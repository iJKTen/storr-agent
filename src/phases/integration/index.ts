import type {
  AgentConfig,
  ExistingComponent,
  IFileReader,
  IFileWriter,
  IExtendedReader,
  IFileScanner,
  IntegrationTarget,
  LLMClient,
  PageInventory,
  SemanticElement,
  TerminalExecutor,
  UpdateFilePayload,
} from '../../types.js';
import type { ConversationHistory } from '../../llm/index.js';
import type { BootContext } from '../../figma/context.js';
import type { InstanceSizing } from '../../figma/page-sizing.js';
import type { RetryToolConfig } from '../../llm/retry.js';
import { UPDATE_FILE_TOOL } from '../../llm/tools.js';
import { buildSystemMessage, resolveExistingComponent, resolveYAMLPaths } from '../../figma/context.js';
import { resolveHookFiles } from '../../figma/rules.js';
import { log } from '../../log.js';
import { runTypecheck, formatTypecheckErrors, filterTypecheckToScope, logTypecheckErrors } from '../../workspace/typecheck.js';
import { buildInstanceSizingIndex } from '../../figma/page-sizing.js';
import { retryWithToolCall } from '../../llm/retry.js';
import { withDryRunGuard, isDryRunClient } from '../../llm/dry-run.js';
import { syncBindings } from './bindings.js';
import { resolveInstanceToComponent } from './instance-resolver.js';
import { buildIntegrationTargets, classifyInstances, extractRenderedComponents } from './targets.js';
import type { PageLayoutWrapper, ResponsiveFrameCSS } from './targets.js';
import { extractContainerFrames, mergeResponsiveCSS, buildInstanceSizingCSS, inferParentCentering, propagateParentCentering, buildMultiWrapperCSS, wrapperClassName, buildResponsiveFrameBlock } from './css-generation.js';
import { buildIntegrationPrompt, computeSizingClasses } from './prompt-builder.js';
import { extractSemanticElements, collectWrapperHints, mergeWrapperHints } from '../../figma/yaml-parser.js';
import type { WrapperHint } from '../../figma/yaml-parser.js';
import type { LayoutContext, WrapperInfo } from './prompt-builder.js';
import { resolveInstanceProps } from '../../figma/component-meta.js';
import type { ResolvedInstanceProp, ComponentPropMeta } from '../../figma/component-meta.js';
import { FileSystemComponentMetaRepo } from '../../repositories/component-meta-repository.js';
import type { FigmaNode } from '../../figma/figma-node.js';
import * as path from 'node:path';

// ── Phase Dependencies ──

interface PhaseDeps {
  llm: LLMClient;
  history: ConversationHistory;
  terminal: TerminalExecutor;
  config: AgentConfig;
}

// ── Component Source Reading ──

function resolveComponentPath(
  name: string,
  reader: IFileReader,
  existingComponents: Map<string, ExistingComponent>,
): string | undefined {
  const directPath = `app/components/${name}/index.tsx`;
  if (reader.fileExists(directPath)) return directPath;

  const match = resolveExistingComponent(name, existingComponents);
  if (!match) return undefined;

  const suffixPath = `${match.directory}/index.tsx`;
  return reader.fileExists(suffixPath) ? suffixPath : undefined;
}

function findReferencedImports(sources: string[]): Set<string> {
  const navPattern = /import\s+\{[^}]*\}\s+from\s+'~\/components\/([^']+)'/g;
  const referencedNames = new Set<string>();

  for (const block of sources) {
    let m: RegExpExecArray | null;
    while ((m = navPattern.exec(block)) !== null) {
      referencedNames.add(m[1]);
    }
  }
  return referencedNames;
}

async function addReferencedNavComponents(
  reader: IFileReader,
  sources: string[],
  included: Set<string>,
): Promise<void> {
  const referencedNames = findReferencedImports(sources);

  for (const refName of referencedNames) {
    if (included.has(refName)) continue;
    const refPath = `app/components/${refName}/index.tsx`;
    if (!reader.fileExists(refPath)) continue;
    const source = await reader.readFile(refPath);
    sources.push(`## ${refName} (${refPath})`, '```tsx', source, '```');
    included.add(refName);
  }
}

async function readComponentSources(
  reader: IFileReader,
  names: string[],
  targetType: 'pageLayout' | 'route' | 'template',
  existingComponents: Map<string, ExistingComponent>,
): Promise<string[]> {
  const sources: string[] = [];
  const included = new Set<string>();

  for (const name of names) {
    const indexPath = resolveComponentPath(name, reader, existingComponents);
    if (!indexPath) continue;
    const source = await reader.readFile(indexPath);
    sources.push(`## ${name} (${indexPath})`, '```tsx', source, '```');
    included.add(name);
  }

  if (targetType === 'pageLayout') {
    await addReferencedNavComponents(reader, sources, included);
  }

  return sources;
}

// ── Hook Source Loading ──

async function loadHookSources(
  reader: IFileReader,
  componentNames: string[],
): Promise<string[]> {
  const paths = resolveHookFiles(componentNames);
  const sources: string[] = [];
  for (const filePath of paths) {
    if (reader.fileExists(filePath)) {
      const content = await reader.readFile(filePath);
      sources.push(`### ${filePath}\n\`\`\`typescript\n${content}\n\`\`\``);
    }
  }
  return sources;
}

// ── Route CSS Module Generation ──

function parsePageFrames(
  nodes: FigmaNode[],
  metadata: { name?: string } | undefined,
  yamlPath: string,
): { frames: Array<{ className: string; base: string }>; isMobile: boolean } {
  const frames = extractContainerFrames(nodes);
  if (frames.length === 0) return { frames: [], isMobile: false };
  const rootName = nodes[0]?.name ?? metadata?.name ?? yamlPath;
  return { frames, isMobile: /mobile/i.test(rootName) };
}

type FrameEntry = { className: string; base: string };

async function collectFrames(
  reader: IFileReader,
  yamlPaths: string[],
): Promise<{ mobile: FrameEntry[]; desktop: FrameEntry[] }> {
  let mobile: FrameEntry[] = [];
  let desktop: FrameEntry[] = [];

  for (const yamlPath of yamlPaths) {
    type PageYAML = { nodes?: FigmaNode[]; metadata?: { name?: string } };
    let parsed: PageYAML;
    try { parsed = await reader.readYAML<PageYAML>(yamlPath); }
    catch (err) { throw new Error(`Failed to parse page YAML ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`); }
    if (!parsed.nodes) continue;

    const result = parsePageFrames(parsed.nodes, parsed.metadata, yamlPath);
    if (result.frames.length === 0) continue;
    if (result.isMobile) mobile = result.frames;
    else desktop = result.frames;
  }
  inferParentCentering(desktop);
  return { mobile, desktop };
}

async function generateRouteCSSModule(
  reader: IFileReader,
  writer: IFileWriter,
  target: IntegrationTarget,
): Promise<{ relPath?: string; classNames: string[] }> {
  if (target.targetType !== 'route') return { classNames: [] };

  const { mobile, desktop } = await collectFrames(reader, target.pageYamlPaths);
  if (mobile.length === 0 && desktop.length === 0) return { classNames: [] };

  const contentMobile = mobile.slice(1);
  const contentDesktop = desktop.slice(1);
  if (contentMobile.length === 0 && contentDesktop.length === 0) return { classNames: [] };

  // Propagate centering from skipped parent frame (e.g. <main> with align-items: center)
  const parentMobile = mobile.length > 0 ? mobile[0] : undefined;
  const parentDesktop = desktop.length > 0 ? desktop[0] : undefined;
  propagateParentCentering(parentMobile, contentMobile);
  propagateParentCentering(parentDesktop, contentDesktop);

  const mergedCSS = contentMobile.length > 0
    ? mergeResponsiveCSS(contentMobile, contentDesktop)
    : mergeResponsiveCSS(contentDesktop, []);

  const routeBase = path.basename(target.targetFile, '.tsx');
  const relPath = `app/styles/${routeBase}.module.css`;
  await writer.writeFile(relPath, mergedCSS);
  log('integration', `Generated route CSS module: ${relPath}`);

  const allClassNames = new Set([
    ...contentMobile.map(f => f.className),
    ...contentDesktop.map(f => f.className),
  ]);
  return { relPath, classNames: [...allClassNames] };
}

// ── Sizing CSS Module Generation ──

function buildSizingCSS(
  sizingClasses: Array<{ componentName: string; className: string; uniform?: { width?: string; height?: string } }>,
  sizingIndex: Map<string, InstanceSizing[]>,
): string {
  const cssLines: string[] = ['/* Mobile-first base styles */'];
  const mediaLines: string[] = [];

  for (const entry of sizingClasses) {
    if (entry.uniform) {
      // Uniform sizing — simple non-responsive class
      const props: string[] = [];
      if (entry.uniform.width) props.push(`width: ${entry.uniform.width}`);
      if (entry.uniform.height) props.push(`height: ${entry.uniform.height}`);
      if (props.length > 0) {
        cssLines.push(`.${entry.className} { ${props.join('; ')}; }`);
      }
    } else {
      // Responsive sizing — mobile base + desktop override
      const entries = sizingIndex.get(entry.componentName.toLowerCase())!;
      const sizing = buildInstanceSizingCSS(entry.componentName, entries)!;
      cssLines.push(`.${sizing.className} { ${sizing.mobile}; }`);
      if (sizing.desktop) {
        mediaLines.push(`  .${sizing.className} { ${sizing.desktop}; }`);
      }
    }
  }

  if (mediaLines.length > 0) {
    cssLines.push('', '/* Desktop overrides */', '@media (min-width: 1024px) {', ...mediaLines, '}');
  }

  return cssLines.join('\n') + '\n';
}

function deriveSizingModulePath(targetType: string, targetFile: string): string {
  if (targetType === 'pageLayout') return 'app/styles/page-layout-sizing.module.css';
  const dir = path.basename(path.dirname(targetFile));
  const kebab = dir.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `app/styles/${kebab}-sizing.module.css`;
}

async function generateSizingModule(
  writer: IFileWriter,
  resolvedComponentNames: string[],
  sizingIndex: Map<string, InstanceSizing[]>,
  targetType: 'pageLayout' | 'route' | 'template',
  targetFile: string,
): Promise<{ sizingClasses: Array<{ componentName: string; className: string; uniform?: { width?: string; height?: string } }>; handled: Set<string>; sizingModulePath?: string }> {
  if (targetType === 'route') {
    return { sizingClasses: [], handled: new Set() };
  }

  const { sizingClasses, handled } = computeSizingClasses(resolvedComponentNames, sizingIndex);
  if (sizingClasses.length === 0) {
    return { sizingClasses, handled };
  }

  const css = buildSizingCSS(sizingClasses, sizingIndex);
  const sizingModulePath = deriveSizingModulePath(targetType, targetFile);
  await writer.writeFile(sizingModulePath, css);
  log('integration', `Generated sizing CSS module: ${sizingModulePath}`);

  return { sizingClasses, handled, sizingModulePath };
}

// ── PageLayout Frame CSS ──

function deriveModulePath(targetFile: string): string {
  const dir = path.dirname(targetFile);
  return `${dir}/${path.basename(dir)}.module.css`;
}

async function writeWrappersCSSToModule(
  reader: IFileReader,
  writer: IFileWriter,
  targetFile: string,
  wrappers: PageLayoutWrapper[],
): Promise<void> {
  const cssModulePath = deriveModulePath(targetFile);

  let existing = '';
  if (reader.fileExists(cssModulePath)) {
    existing = await reader.readFile(cssModulePath);
    if (existing.includes('.pageLayoutFrame')) return;
  }

  const classBlock = buildMultiWrapperCSS(wrappers);
  const content = existing.trimEnd() + '\n\n' + classBlock;
  await writer.writeFile(cssModulePath, content);
  log('integration', `Wrote wrapper classes to ${cssModulePath}`);
}

async function extractMainFrameCSS(
  reader: IFileReader,
  yamlPaths: string[],
): Promise<ResponsiveFrameCSS> {
  const { mobile, desktop } = await collectFrames(reader, yamlPaths);
  return {
    mobile: mobile[0]?.base,
    desktop: desktop[0]?.base,
  };
}

async function writeMainCSSToModule(
  reader: IFileReader,
  writer: IFileWriter,
  targetFile: string,
  mainCSS: ResponsiveFrameCSS,
): Promise<void> {
  const cssModulePath = deriveModulePath(targetFile);
  let existing = '';
  if (reader.fileExists(cssModulePath)) {
    existing = await reader.readFile(cssModulePath);
    if (existing.includes('.main')) return;
  }
  const classBlock = buildResponsiveFrameBlock(mainCSS, 'main');
  const content = existing.trimEnd() + '\n\n' + classBlock;
  await writer.writeFile(cssModulePath, content);
  log('integration', `Wrote .main to ${cssModulePath}`);
}

function buildWrapperInfos(wrappers: PageLayoutWrapper[]): WrapperInfo[] {
  return wrappers.map((w, i) => ({
    className: wrapperClassName(i),
    children: w.children,
  }));
}

// ── Data Binding Context ──

async function readFormattedSources(
  extReader: IExtendedReader,
  dirPath: string,
): Promise<string[]> {
  const files = await extReader.readDir(dirPath, '.ts');
  return files.map(
    (f) => `### ${dirPath}/${f.filename}\n\`\`\`typescript\n${f.content}\n\`\`\``,
  );
}

async function loadDataBindingContext(
  reader: IFileReader,
  extReader: IExtendedReader,
  target: IntegrationTarget,
  hasDataBindings: boolean,
): Promise<{ bindingsContent?: string; serviceSources: string[]; querySources: string[] }> {
  if (target.targetType !== 'route' && target.targetType !== 'template') {
    return { serviceSources: [], querySources: [] };
  }

  let bindingsContent: string | undefined;
  const bindingsPath = 'app/content/bindings.ts';
  if (hasDataBindings && reader.fileExists(bindingsPath)) {
    bindingsContent = await reader.readFile(bindingsPath);
  }

  const serviceSources = await readFormattedSources(extReader, 'app/lib/services');
  const querySources = await readFormattedSources(extReader, 'app/lib/queries');

  return { bindingsContent, serviceSources, querySources };
}

// ── LLM Response Processing ──

async function writeAndVerifyTarget(
  reader: IFileReader,
  deps: PhaseDeps,
  toolCallId: string,
  filePath: string,
): Promise<boolean> {
  const tc = await runTypecheck(reader, deps.terminal);
  if (tc.passed) return true;

  const targetDir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
  const scoped = filterTypecheckToScope(tc, [targetDir]);
  if (scoped.passed) return true;

  logTypecheckErrors('integration', scoped);
  deps.history.addToolResult(toolCallId, formatTypecheckErrors(scoped, 'update_file'));
  return false;
}

async function processLLMResponse(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  target: IntegrationTarget,
): Promise<boolean> {
  const retryConfig: RetryToolConfig = {
    tools: [UPDATE_FILE_TOOL],
    targetToolName: 'update_file',
    maxRetries: deps.config.retry.maxEvalRetries,
    noToolCallMessage: 'You MUST call the update_file tool. Call it now.',
  };

  const success = await retryWithToolCall(
    deps.llm,
    deps.history,
    retryConfig,
    async ({ toolCall }) => {
      let payload: UpdateFilePayload;
      try {
        payload = JSON.parse(toolCall.arguments) as UpdateFilePayload;
      } catch {
        deps.history.addToolResult(toolCall.id, 'ERROR: Invalid JSON. Try again.');
        return false;
      }

      if (payload.filePath !== target.targetFile) {
        deps.history.addToolResult(toolCall.id, `ERROR: filePath must be "${target.targetFile}".`);
        return false;
      }

      if (!payload.content || payload.content.trim().length === 0) {
        deps.history.addToolResult(toolCall.id, 'ERROR: Cannot write empty content.');
        return false;
      }

      await writer.writeFile(payload.filePath, payload.content);
      log('integration', `Updated: ${payload.filePath}`);

      return writeAndVerifyTarget(reader, deps, toolCall.id, payload.filePath);
    },
  );

  if (!success) {
    log('integration', `FAILED: Could not integrate into ${target.targetFile}.`);
  }
  return success;
}

// ── Page YAML Reading ──

interface PageYAMLResult {
  formatted: string[];
  semanticElements: SemanticElement[];
}

async function readPageYAMLs(
  reader: IFileReader,
  yamlPaths: string[],
): Promise<PageYAMLResult> {
  const formatted: string[] = [];
  const semanticElements: SemanticElement[] = [];
  for (const yamlPath of yamlPaths) {
    const content = await reader.readFile(yamlPath);
    formatted.push(`## ${yamlPath}\n\`\`\`yaml\n${content}\n\`\`\``);
    semanticElements.push(...extractSemanticElements(content));
  }
  return { formatted, semanticElements };
}

// ── Wrapper Hierarchy Extraction ──

function findMainChildren(nodes: FigmaNode[]): FigmaNode[] {
  const rootChildren = nodes[0]?.children ?? nodes;
  const main = rootChildren.find(
    (n) => n.type === 'FRAME' && n.name?.toLowerCase() === 'main',
  );
  return main?.children ?? [];
}

async function extractWrapperHints(
  reader: IFileReader,
  yamlPaths: string[],
): Promise<WrapperHint[]> {
  let mobileHints: WrapperHint[] = [];
  let desktopHints: WrapperHint[] = [];

  for (const yamlPath of yamlPaths) {
    type PageYAML = { nodes?: FigmaNode[] };
    let parsed: PageYAML;
    try { parsed = await reader.readYAML<PageYAML>(yamlPath); }
    catch { continue; }
    if (!parsed.nodes) continue;

    const children = findMainChildren(parsed.nodes);
    const hints = collectWrapperHints(children);
    const rootName = parsed.nodes[0]?.name ?? yamlPath;
    if (/mobile/i.test(rootName)) mobileHints = hints;
    else desktopHints = hints;
  }

  return mergeWrapperHints(mobileHints, desktopHints);
}

// ── Single Target Processing ──

interface IntTargetInput {
  target: IntegrationTarget;
  sizingIndex: Map<string, InstanceSizing[]>;
  wrappers: PageLayoutWrapper[];
  bootCtx: BootContext;
}

// ── Target Resolution Helpers ──

const DATA_BINDING_RE = /\{\{(product|collection|article)\./;

function deduplicateResolved(
  componentNames: string[],
  instanceNameMap: Map<string, string>,
): string[] {
  const resolved: string[] = [];
  for (const name of componentNames) {
    const r = instanceNameMap.get(name) ?? name;
    if (!resolved.includes(r)) resolved.push(r);
  }
  return resolved;
}

interface ResolvedTargetData {
  existingContent: string;
  yamlContents: string[];
  semanticElements: SemanticElement[];
  instanceNameMap: Map<string, string>;
  instanceVariantMap: Map<string, string>;
  hasDataBindings: boolean;
  resolvedComponentNames: string[];
  resolvedInstanceProps: ResolvedInstanceProp[];
  propInterfaces: Map<string, string>;
}

/**
 * Extracts interface text entries from the component metadata map.
 * Only includes components that have a saved interfaceText field.
 */
function buildPropInterfacesMap(
  propMetaMap: Map<string, ComponentPropMeta>,
): Map<string, string> {
  const interfaces = new Map<string, string>();
  for (const [name, meta] of propMetaMap) {
    if (meta.interfaceText) interfaces.set(name, meta.interfaceText);
  }
  return interfaces;
}

async function resolveTargetData(
  reader: IFileReader,
  writer: IFileWriter,
  target: IntegrationTarget,
  bootCtx: BootContext,
): Promise<ResolvedTargetData> {
  const existingContent = await reader.readFile(target.targetFile);

  const { formatted: yamlContents, semanticElements } = await readPageYAMLs(
    reader, target.pageYamlPaths,
  );

  const { nameMap: instanceNameMap, variantMap: instanceVariantMap } =
    await resolveInstanceToComponent(reader, target.componentNames, target.pageYamlPaths, bootCtx);

  const hasDataBindings = target.hasDataBindings
    || target.componentNames.some((n) => DATA_BINDING_RE.test(n));

  const resolvedComponentNames = deduplicateResolved(target.componentNames, instanceNameMap);

  const metaRepo = new FileSystemComponentMetaRepo(reader, writer);
  const propMetaMap = await metaRepo.loadAll(resolvedComponentNames);
  const resolvedInstanceProps = resolveInstanceProps(
    target.instanceProps ?? {}, instanceNameMap, propMetaMap,
  );
  const propInterfaces = buildPropInterfacesMap(propMetaMap);

  return {
    existingContent, yamlContents, semanticElements,
    instanceNameMap, instanceVariantMap,
    hasDataBindings, resolvedComponentNames, resolvedInstanceProps,
    propInterfaces,
  };
}

// ── CSS + Source Loading ──

interface TargetSourcesAndCSS {
  componentSources: string[];
  hookSources: string[];
  cssModule: { relPath?: string; classNames: string[] };
  sizingResult: {
    sizingClasses: Array<{ componentName: string; className: string; uniform?: { width?: string; height?: string } }>;
    handled: Set<string>;
    sizingModulePath?: string;
  };
  hasMainCSS: boolean;
}

async function loadTargetSourcesAndCSS(
  reader: IFileReader,
  writer: IFileWriter,
  target: IntegrationTarget,
  resolved: ResolvedTargetData,
  input: IntTargetInput,
): Promise<TargetSourcesAndCSS> {
  const componentSources = await readComponentSources(
    reader, resolved.resolvedComponentNames, target.targetType,
    input.bootCtx.project.existingComponents,
  );
  const hookSources = await loadHookSources(reader, resolved.resolvedComponentNames);
  const cssModule = await generateRouteCSSModule(reader, writer, target);
  const sizingResult = await generateSizingModule(
    writer, resolved.resolvedComponentNames, input.sizingIndex,
    target.targetType, target.targetFile,
  );

  if (target.targetType === 'pageLayout' && input.wrappers.length > 0) {
    await writeWrappersCSSToModule(reader, writer, target.targetFile, input.wrappers);
  }

  let hasMainCSS = false;
  if (target.targetType === 'pageLayout') {
    const mainCSS = await extractMainFrameCSS(reader, target.pageYamlPaths);
    hasMainCSS = !!(mainCSS.mobile || mainCSS.desktop);
    if (hasMainCSS) {
      await writeMainCSSToModule(reader, writer, target.targetFile, mainCSS);
    }
  }

  return { componentSources, hookSources, cssModule, sizingResult, hasMainCSS };
}

// ── Prompt Assembly ──

/**
 * Filters the full propInterfaces map to only include components that are
 * actually imported by the built component sources. This prevents sending
 * irrelevant interface text to the LLM prompt.
 */
function discoverChildInterfaces(
  componentSources: string[],
  propInterfaces: Map<string, string>,
): Map<string, string> {
  const importedNames = findReferencedImports(componentSources);
  const relevant = new Map<string, string>();
  for (const name of importedNames) {
    const iface = propInterfaces.get(name);
    if (iface) relevant.set(name, iface);
  }
  return relevant;
}

async function buildTargetPrompt(
  reader: IFileReader & IExtendedReader,
  target: IntegrationTarget,
  resolved: ResolvedTargetData,
  sources: TargetSourcesAndCSS,
  input: IntTargetInput,
): Promise<string> {
  const wrapperHints = target.targetType === 'route'
    ? await extractWrapperHints(reader, target.pageYamlPaths)
    : [];

  const { bindingsContent, serviceSources, querySources } = await loadDataBindingContext(
    reader, reader, target, resolved.hasDataBindings,
  );

  const hasWrappers = input.wrappers.length > 0;
  const wrapperInfos = target.targetType === 'pageLayout' && hasWrappers
    ? buildWrapperInfos(input.wrappers) : [];

  const layout: LayoutContext = {
    wrappers: wrapperInfos,
    hasMainCSS: sources.hasMainCSS,
    wrapperHints,
  };

  const childInterfaces = discoverChildInterfaces(
    sources.componentSources, resolved.propInterfaces,
  );
  for (const name of resolved.resolvedComponentNames) {
    const iface = resolved.propInterfaces.get(name);
    if (iface && !childInterfaces.has(name)) {
      childInterfaces.set(name, iface);
    }
  }

  return buildIntegrationPrompt(
    {
      target,
      content: {
        existingContent: resolved.existingContent,
        yamlContents: resolved.yamlContents,
        componentSources: sources.componentSources,
        hookSources: sources.hookSources,
      },
      names: {
        resolvedComponentNames: resolved.resolvedComponentNames,
        instanceNameMap: resolved.instanceNameMap,
        instanceVariantMap: resolved.instanceVariantMap,
      },
      css: {
        cssModuleRelPath: sources.cssModule.relPath,
        cssModuleClassNames: sources.cssModule.classNames,
        sizingClasses: sources.sizingResult.sizingClasses,
        sizingModulePath: sources.sizingResult.sizingModulePath,
      },
    },
    {
      sizingCtx: { sizingIndex: input.sizingIndex, handledComponents: sources.sizingResult.handled },
      dataBinding: {
        hasBindings: resolved.hasDataBindings,
        bindingsContent,
        serviceSources,
        querySources,
      },
      semanticElements: resolved.semanticElements,
      resolvedInstanceProps: resolved.resolvedInstanceProps,
      propInterfaces: childInterfaces,
    },
    layout,
  );
}

// ── LLM Execution ──

function configureLLMContext(
  deps: PhaseDeps,
  target: IntegrationTarget,
): void {
  if (isDryRunClient(deps.llm)) {
    deps.llm.setContext({ targetFile: target.targetFile, yamlPath: target.pageYamlPaths[0] });
  }
}

// ── Orchestrator ──

async function processIntegrationTarget(
  reader: IFileReader & IExtendedReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: IntTargetInput,
): Promise<boolean> {
  const { target, bootCtx } = input;
  log('integration', `Processing ${target.targetType}: ${target.targetFile}`);

  if (!reader.fileExists(target.targetFile)) {
    log('integration', `Target file does not exist: ${target.targetFile}. Skipping.`);
    return false;
  }

  const resolved = await resolveTargetData(reader, writer, target, bootCtx);
  const sources = await loadTargetSourcesAndCSS(reader, writer, target, resolved, input);

  deps.history.clear();
  const { message: systemMsg } = await buildSystemMessage(deps.config, 'integration', bootCtx);
  deps.history.setSystemMessage(systemMsg);
  configureLLMContext(deps, target);

  const prompt = await buildTargetPrompt(reader, target, resolved, sources, input);
  deps.history.addUser(prompt);

  return processLLMResponse(reader, writer, deps, target);
}

// ── Main Orchestrator ──

interface ProcessTargetsInput {
  targets: IntegrationTarget[];
  sizingIndex: Map<string, InstanceSizing[]>;
  bootCtx: BootContext;
  wrappers: PageLayoutWrapper[];
}

function collectGlobalNames(layoutTargets: IntegrationTarget[]): Set<string> {
  const names = new Set<string>();
  for (const t of layoutTargets) {
    for (const name of t.componentNames) names.add(name);
  }
  return names;
}

function filterRouteTarget(
  target: IntegrationTarget,
  globalNames: Set<string>,
): IntegrationTarget | undefined {
  const filtered = target.componentNames.filter(n => !globalNames.has(n));
  if (filtered.length === target.componentNames.length) return target;
  if (filtered.length > 0) {
    log('integration', `Filtered global components from route ${target.targetFile}`);
    return { ...target, componentNames: filtered };
  }
  log('integration', `All components for ${target.targetFile} are already global. Skipping.`);
  return undefined;
}

interface CategorizedTargets {
  layoutTargets: IntegrationTarget[];
  templateTargets: IntegrationTarget[];
  routeTargets: IntegrationTarget[];
  globalNames: Set<string>;
}

function categorizeTargets(targets: IntegrationTarget[]): CategorizedTargets {
  const layoutTargets = targets.filter((t) => t.targetType === 'pageLayout');
  const templateTargets = targets.filter((t) => t.targetType === 'template');
  const routeTargets = targets.filter((t) => t.targetType === 'route');
  const globalNames = collectGlobalNames(layoutTargets);
  return { layoutTargets, templateTargets, routeTargets, globalNames };
}

async function processTargetList(
  reader: IFileReader & IExtendedReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  targets: IntegrationTarget[],
  input: ProcessTargetsInput,
): Promise<void> {
  for (const target of targets) {
    await withDryRunGuard(
      async () => { await processIntegrationTarget(reader, writer, deps, {
        target, sizingIndex: input.sizingIndex, wrappers: input.wrappers, bootCtx: input.bootCtx,
      }); },
      'integration',
      target.targetFile,
    );
  }
}

function filterRouteTargets(
  routeTargets: IntegrationTarget[],
  globalNames: Set<string>,
): IntegrationTarget[] {
  const filtered: IntegrationTarget[] = [];
  for (const target of routeTargets) {
    const result = filterRouteTarget(target, globalNames);
    if (result) filtered.push(result);
  }
  return filtered;
}

async function processTargets(
  reader: IFileReader & IExtendedReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: ProcessTargetsInput,
): Promise<void> {
  const cat = categorizeTargets(input.targets);
  await processTargetList(reader, writer, deps, cat.layoutTargets, input);
  await processTargetList(reader, writer, deps, cat.templateTargets, input);
  const filteredRoutes = filterRouteTargets(cat.routeTargets, cat.globalNames);
  await processTargetList(reader, writer, deps, filteredRoutes, input);
}

export async function integration(
  reader: IFileReader & IFileScanner & IExtendedReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  ctx: BootContext,
): Promise<void> {
  const scanner: IFileScanner = reader;
  const inventories = await scanner.readAllInventories();
  const pageInventories = inventories.filter(
    (inv): inv is PageInventory => 'pages' in inv,
  );

  if (pageInventories.length === 0) {
    log('integration', 'No page inventories found. Skipping.');
    return;
  }

  const pageYamlPaths = new Set<string>();
  for (const inv of pageInventories) {
    for (const page of inv.pages) {
      if (page.type !== 'FRAME') continue;
      const paths = resolveYAMLPaths(page.name, ctx.yaml.fileIndex);
      if (paths) for (const p of paths) pageYamlPaths.add(p);
    }
  }
  await syncBindings(reader, writer, pageYamlPaths);

  const { targets, wrappers } = await buildIntegrationTargets(reader, pageInventories, ctx);
  if (targets.length === 0) {
    log('integration', 'No integration targets found. Skipping.');
    return;
  }

  const sizingIndex = await buildInstanceSizingIndex(reader, ctx.yaml.fileIndex, ctx.project.inventories);
  log('integration', `Found ${targets.length} integration target(s).`);

  await processTargets(reader, writer, deps, {
    targets, sizingIndex, bootCtx: ctx, wrappers,
  });
  log('integration', 'Integration phase complete.');
}

// Re-export for tests
export {
  classifyInstances as _classifyInstances,
  extractRenderedComponents as _extractRenderedComponents,
} from './targets.js';
export {
  ensureStickyZIndex as _ensureStickyZIndex,
  inferParentCentering as _inferParentCentering,
  propagateParentCentering as _propagateParentCentering,
  mergeResponsiveCSS as _mergeResponsiveCSS,
} from './css-generation.js';
export type { ContainerFrame as _ContainerFrame } from './css-generation.js';
