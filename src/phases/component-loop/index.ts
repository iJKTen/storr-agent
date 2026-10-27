import type {
  IFileReader,
  IFileWriter,
  IFileScanner,
  TerminalExecutor,
} from '../../types.js';
import type { FigmaNode } from '../../figma/figma-node.js';
import type { ComponentPropMeta } from '../../figma/component-meta.js';
import { extractPropsInterface } from '../../figma/component-meta.js';
import type { BootContext } from '../../figma/context.js';
import { resolveExistingComponent } from '../../figma/context.js';
import { ComponentStrategyFactory } from '../../figma/strategies/index.js';
import { FileSystemComponentMetaRepo } from '../../repositories/component-meta-repository.js';
import { buildInstanceSizingIndex } from '../../figma/page-sizing.js';
import { withDryRunGuard, isDryRunClient } from '../../llm/dry-run.js';
import { log } from '../../log.js';
import { parse } from 'yaml';
import { collectBuildableComponents } from './filtering.js';
import { topoSortComponents, resolvePackageName, collectYAMLPackages } from './dependency-graph.js';
import { buildComponentPrompt } from './prompt-builder.js';
import { evalRetryLoop } from './eval-retry.js';
import { prepareComponent } from './preparation.js';
import type { PhaseDeps, ComponentBuildInput, ComponentLoopInput } from './types.js';

// ── Build Helpers ──

async function loadPreviouslyBuiltInterfaces(
  reader: IFileReader,
  writer: IFileWriter,
  existingComponents: Map<string, import('../../types.js').ExistingComponent>,
  currentName: string,
): Promise<Map<string, string>> {
  const metaRepo = new FileSystemComponentMetaRepo(reader, writer);
  const interfaces = new Map<string, string>();
  for (const name of existingComponents.keys()) {
    if (name === currentName) continue;
    const meta = await metaRepo.load(name);
    if (meta?.interfaceText) {
      interfaces.set(name, meta.interfaceText);
    }
  }
  return interfaces;
}

async function installPackage(
  terminal: TerminalExecutor,
  packageName: string,
): Promise<void> {
  log('component_loop', `Installing package: ${packageName}...`);
  const result = await terminal(`npm install ${packageName}`);
  if (result.exitCode !== 0) {
    log('component_loop', `Warning: npm install ${packageName} failed (exit ${result.exitCode}).`);
  }
}

async function persistPropMetadata(
  reader: IFileReader,
  writer: IFileWriter,
  name: string,
  yaml: string,
): Promise<void> {
  try {
    const doc = parse(yaml) as { nodes?: FigmaNode[] } | null;
    if (!doc?.nodes) return;

    const factory = new ComponentStrategyFactory();
    const strategy = factory.getStrategy(name, doc.nodes);
    const meta: ComponentPropMeta = {
      category: strategy.category,
      props: strategy.extractProps(doc.nodes),
    };
    if (meta.props.length > 0) {
      const metaRepo = new FileSystemComponentMetaRepo(reader, writer);
      await metaRepo.save(name, meta);
      log('component_loop', `Saved prop metadata for ${name}: ${meta.props.map(p => p.propKey).join(', ')}`);
    }
  } catch (err) {
    throw new Error(`Failed to save prop metadata for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reads the built component TSX, extracts its Props interface, and saves it
 * to props.meta.json. This gives the integration phase an authoritative
 * contract for child component props, preventing the LLM from inventing
 * or missing props.
 */
async function persistInterfaceText(
  reader: IFileReader,
  writer: IFileWriter,
  name: string,
  dir: string,
): Promise<void> {
  const tsxPath = `${dir}/index.tsx`;
  if (!reader.fileExists(tsxPath)) return;

  const source = await reader.readFile(tsxPath);
  const interfaceText = extractPropsInterface(source);
  if (!interfaceText) return;

  const metaRepo = new FileSystemComponentMetaRepo(reader, writer);
  const existing = await metaRepo.load(name);
  const meta: ComponentPropMeta = existing ?? { category: 'standard', props: [] };
  meta.interfaceText = interfaceText;
  await metaRepo.save(name, meta);
  log('component_loop', `Saved interface text for ${name}`);
}

async function handleSuccessfulBuild(
  scanner: IFileScanner,
  bootCtx: BootContext,
  name: string,
  dir: string,
): Promise<void> {
  const updated = await scanner.scanSingleComponent(dir);
  if (updated) {
    bootCtx.project.existingComponents.set(name, updated);
  }
}

// ── Build a Single Component ──

interface BuildComponentInput {
  name: string;
  plan: string;
  bootCtx: BootContext;
  sizingIndex: Map<string, Array<{ pageName: string; width?: string; height?: string }>>;
}

type FullBuildInput = BuildComponentInput & { scanner: IFileScanner; extReader: import('../../types.js').IExtendedReader };

function resolveComponentIdentity(
  name: string,
  existingComponents: Map<string, import('../../types.js').ExistingComponent>,
): { actualName: string; packageName: string | undefined; existing: import('../../types.js').ExistingComponent | undefined } {
  const { actualName, packageName } = resolvePackageName(name);
  const existing = resolveExistingComponent(actualName, existingComponents);
  if (existing) {
    log('component_loop', `Found existing scaffold component: ${actualName}`);
  }
  log('component_loop', `${existing ? 'Updating' : 'Building'} component: ${actualName}`);
  return { actualName, packageName, existing };
}

async function installComponentDeps(
  terminal: TerminalExecutor,
  packageName: string | undefined,
  yaml: string,
): Promise<string[]> {
  const yamlPackages = collectYAMLPackages(yaml);
  const allPackages = [...new Set(
    [packageName, ...yamlPackages].filter((p): p is string => p != null),
  )];
  for (const pkg of allPackages) {
    await installPackage(terminal, pkg);
  }
  return allPackages;
}

function buildAndEnqueuePrompt(
  deps: PhaseDeps,
  buildInput: ComponentBuildInput,
  prepared: Awaited<ReturnType<typeof prepareComponent>> & object,
  allPackages: string[],
  previouslyBuiltInterfaces: Map<string, string>,
): void {
  const prompt = buildComponentPrompt(buildInput, {
    packageNames: allPackages.length > 0 ? allPackages : undefined,
    hookSources: prepared.hookSources,
    scaffoldDeps: prepared.scaffoldDeps,
    variantUsageSection: prepared.variantUsageSection,
    previouslyBuiltInterfaces,
  });
  deps.history.addUser(prompt);
}

async function finalizeComponentBuild(
  input: FullBuildInput,
  deps: PhaseDeps,
  actualName: string,
  writtenDir: string | null,
): Promise<void> {
  if (writtenDir) {
    await handleSuccessfulBuild(input.scanner, input.bootCtx, actualName, writtenDir);
  } else {
    log('component_loop', `FAILED: ${actualName} after ${deps.config.retry.maxEvalRetries} eval retries. Moving on.`);
  }
}

async function buildComponent(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: FullBuildInput,
): Promise<void> {
  const { actualName, packageName, existing } = resolveComponentIdentity(
    input.name, input.bootCtx.project.existingComponents,
  );

  deps.history.clear();
  const prepared = await prepareComponent(reader, input.extReader, deps, input.bootCtx, input.name);
  if (!prepared) return;

  const allPackages = await installComponentDeps(deps.terminal, packageName, prepared.yaml);

  if (isDryRunClient(deps.llm)) {
    deps.llm.setContext({ component: actualName, yamlPath: prepared.yamlPath });
  }

  const previouslyBuiltInterfaces = await loadPreviouslyBuiltInterfaces(
    reader, writer, input.bootCtx.project.existingComponents, actualName,
  );

  const buildInput: ComponentBuildInput = { name: actualName, yaml: prepared.yaml, plan: input.plan, existing };
  buildAndEnqueuePrompt(deps, buildInput, prepared, allPackages, previouslyBuiltInterfaces);
  await persistPropMetadata(reader, writer, actualName, prepared.yaml);

  const writtenDir = await evalRetryLoop(reader, writer, deps, buildInput);
  if (writtenDir) {
    await persistInterfaceText(reader, writer, actualName, writtenDir);
  }
  await finalizeComponentBuild(input, deps, actualName, writtenDir);
}

// ── Main Loop ──

function sortAndLog(sortedNames: string[]): void {
  log('component_loop', `Processing ${sortedNames.length} components: ${sortedNames.join(', ')}`);
}

export async function componentLoop(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: ComponentLoopInput,
): Promise<void> {
  const componentNames = collectBuildableComponents(input.bootCtx.project.inventories);

  if (componentNames.length === 0) {
    log('component_loop', 'No components found. Skipping.');
    return;
  }

  const sortedNames = await topoSortComponents(
    componentNames, reader, input.bootCtx.yaml.fileIndex, input.bootCtx.project.componentIdIndex,
  );
  sortAndLog(sortedNames);

  const sizingIndex = await buildInstanceSizingIndex(reader, input.bootCtx.yaml.fileIndex, input.bootCtx.project.inventories);

  for (const componentName of sortedNames) {
    await withDryRunGuard(
      () => buildComponent(reader, writer, deps, {
        name: componentName,
        plan: input.planContent,
        bootCtx: input.bootCtx,
        sizingIndex,
        scanner: input.scanner,
        extReader: input.extReader,
      }),
      'component_loop',
      componentName,
    );
  }
}

// ── Test Re-exports ──

export { buildRootTagSection as _buildRootTagSection } from './prompt-builder.js';
