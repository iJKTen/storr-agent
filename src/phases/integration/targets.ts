import type { IFileReader, IntegrationTarget, PageInventory } from '../../types.js';
import type { BootContext } from '../../figma/context.js';
import type { FigmaNode } from '../../figma/figma-node.js';
import { isDataBindingNode } from '../../figma/figma-node.js';
import { resolveYAMLPaths, resolveRouteFile, resolveTemplateFile, TEMPLATE_MAP } from '../../figma/context.js';
import { log } from '../../log.js';
import { ensureStickyZIndex } from './css-generation.js';

// ── Responsive Frame CSS ──

export interface ResponsiveFrameCSS {
  mobile: string | undefined;
  desktop: string | undefined;
}

// ── PageLayout Frame Types ──

interface PageLayoutFrame {
  css: string;
  children: string[];
}

export interface PageLayoutWrapper {
  css: ResponsiveFrameCSS;
  children: string[];
}

// ── Instance Classification ──

interface ClassifiedInstances {
  global: string[];
  route: string[];
  pageLayoutFrames: PageLayoutFrame[];
  hasDataBindings: boolean;
  instanceProps: Record<string, Record<string, string>>;
}

interface ClassifyContext {
  insidePageLayout: boolean;
  knownGlobals: Set<string>;
  hasPageLayoutSibling: boolean;
}

interface ClassifyResult {
  global: string[];
  route: string[];
}

function classifyNode(
  node: FigmaNode,
  ctx: ClassifyContext,
  result: ClassifyResult,
): void {
  if (ctx.insidePageLayout) {
    if (node.name) result.global.push(node.name);
  } else if (ctx.hasPageLayoutSibling && node.name && ctx.knownGlobals.has(node.name)) {
    result.global.push(node.name);
  } else if (node.name) {
    result.route.push(node.name);
  }
}

function collectPageLayoutChildren(node: FigmaNode): string[] {
  const names: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'INSTANCE' && child.name) names.push(child.name);
  }
  return names;
}

export function classifyInstances(
  nodes: FigmaNode[],
  knownGlobalNames: Set<string>,
): ClassifiedInstances {
  const global: string[] = [];
  const route: string[] = [];
  const pageLayoutFrames: PageLayoutFrame[] = [];
  let foundDataBindings = false;
  const instanceProps: Record<string, Record<string, string>> = {};

  const classifyResult: ClassifyResult = { global, route };

  function walk(nodeList: FigmaNode[], insidePageLayout: boolean, insideDataBinding: boolean): void {
    const hasPageLayoutSibling = nodeList.some(
      (n) => n.type === 'FRAME' && n.name === 'PageLayout',
    );

    for (const node of nodeList) {
      if (node.type === 'INSTANCE') {
        classifyNode(node, { insidePageLayout, knownGlobals: knownGlobalNames, hasPageLayoutSibling }, classifyResult);
        if (node.dataBindings && node.dataBindings.length > 0) {
          foundDataBindings = true;
        }

        // Collect componentProperties for non-data-binding instances
        if (
          node.name
          && node.componentProperties
          && Object.keys(node.componentProperties).length > 0
          && !insideDataBinding
          && !(node.dataBindings && node.dataBindings.length > 0)
        ) {
          instanceProps[node.name] = node.componentProperties;
        }
        continue;
      }

      const isPageLayoutFrame = node.type === 'FRAME' && node.name === 'PageLayout';
      if (isPageLayoutFrame && node.generatedCSS?.base) {
        pageLayoutFrames.push({
          css: ensureStickyZIndex(node.generatedCSS.base),
          children: collectPageLayoutChildren(node),
        });
      }

      const enterDataBinding = insideDataBinding || isDataBindingNode(node);

      if (node.children) {
        walk(node.children, insidePageLayout || isPageLayoutFrame, enterDataBinding);
      }
    }
  }

  walk(nodes, false, false);
  return { global, route, pageLayoutFrames, hasDataBindings: foundDataBindings, instanceProps };
}

// ── Rendered Component Detection ──

export function extractRenderedComponents(fileContent: string): Set<string> {
  const rendered = new Set<string>();
  const importPattern = /import\s+\{([^}]+)\}\s+from\s+['"]~\/components\/[^'"]+['"]/g;
  const importedNames = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = importPattern.exec(fileContent)) !== null) {
    for (const name of match[1].split(',')) {
      const actual = name.trim().split(/\s+as\s+/)[0].trim();
      if (actual) importedNames.add(actual);
    }
  }

  for (const name of importedNames) {
    if (new RegExp(`<${name}[\\s/>]`).test(fileContent)) {
      rendered.add(name);
    }
  }

  return rendered;
}

// ── Target Building ──

interface TargetAccumulator {
  globalComponents: Set<string>;
  globalYamlPaths: string[];
  globalInstanceProps: Record<string, Record<string, string>>;
  routeAccum: Map<string, { components: Set<string>; yamlPaths: string[]; hasDataBindings: boolean; instanceProps: Record<string, Record<string, string>> }>;
  pageLayoutWrappers: PageLayoutWrapper[];
}

function createAccumulator(): TargetAccumulator {
  return {
    globalComponents: new Set(),
    globalYamlPaths: [],
    globalInstanceProps: {},
    routeAccum: new Map(),
    pageLayoutWrappers: [],
  };
}

function mergeWrapperChildren(
  existing: string[],
  incoming: string[],
): string[] {
  const merged = [...existing];
  for (const name of incoming) {
    if (!merged.includes(name)) merged.push(name);
  }
  return merged;
}

function mergePageLayoutFrames(
  wrappers: PageLayoutWrapper[],
  frames: PageLayoutFrame[],
  isMobile: boolean,
): void {
  for (let i = 0; i < frames.length; i++) {
    if (i >= wrappers.length) {
      wrappers.push({
        css: { mobile: undefined, desktop: undefined },
        children: [],
      });
    }
    const w = wrappers[i];
    if (isMobile) w.css.mobile = frames[i].css;
    else w.css.desktop = frames[i].css;
    w.children = mergeWrapperChildren(w.children, frames[i].children);
  }
}

function accumulateGlobalTargets(
  classified: ClassifiedInstances,
  accum: TargetAccumulator,
  yamlPath: string,
  isMobile: boolean,
): void {
  for (const name of classified.global) accum.globalComponents.add(name);
  if (classified.global.length > 0 && !accum.globalYamlPaths.includes(yamlPath)) {
    accum.globalYamlPaths.push(yamlPath);
  }
  mergePageLayoutFrames(accum.pageLayoutWrappers, classified.pageLayoutFrames, isMobile);
  // Merge instance props for global components
  for (const name of classified.global) {
    if (classified.instanceProps[name]) {
      accum.globalInstanceProps[name] = classified.instanceProps[name];
    }
  }
}

function accumulateRouteTargets(
  classified: ClassifiedInstances,
  accum: TargetAccumulator,
  pageName: string,
  yamlPath: string,
): void {
  if (classified.route.length === 0) return;

  const routeFile = resolveRouteFile(pageName);
  if (!routeFile) {
    log('integration', `No route mapping for page "${pageName}". Skipping.`);
    return;
  }

  // When a template mapping exists, redirect route components to the template file
  // instead of the route file (e.g., PDP components → ProductDetail/index.tsx)
  const templateFile = resolveTemplateFile(pageName);
  const targetFile = templateFile ?? routeFile;

  let entry = accum.routeAccum.get(targetFile);
  if (!entry) {
    entry = { components: new Set(), yamlPaths: [], hasDataBindings: false, instanceProps: {} };
    accum.routeAccum.set(targetFile, entry);
  }

  for (const name of classified.route) entry.components.add(name);
  if (!entry.yamlPaths.includes(yamlPath)) entry.yamlPaths.push(yamlPath);
  if (classified.hasDataBindings) entry.hasDataBindings = true;

  // Merge instance props for route components
  for (const name of classified.route) {
    if (classified.instanceProps[name]) {
      entry.instanceProps[name] = classified.instanceProps[name];
    }
  }
}

function buildTargetsFromAccumulator(
  accum: TargetAccumulator,
): IntegrationTarget[] {
  const targets: IntegrationTarget[] = [];

  if (accum.globalComponents.size > 0) {
    const globalTarget: IntegrationTarget = {
      targetFile: 'app/components/PageLayout/index.tsx',
      targetType: 'pageLayout',
      componentNames: [...accum.globalComponents],
      pageYamlPaths: accum.globalYamlPaths,
    };
    if (Object.keys(accum.globalInstanceProps).length > 0) {
      globalTarget.instanceProps = accum.globalInstanceProps;
    }
    targets.push(globalTarget);
  }

  const templateValues = new Set(Object.values(TEMPLATE_MAP));
  for (const [routeFile, entry] of accum.routeAccum) {
    const isTemplate = templateValues.has(routeFile);
    const routeTarget: IntegrationTarget = {
      targetFile: routeFile,
      targetType: isTemplate ? 'template' : 'route',
      componentNames: [...entry.components],
      pageYamlPaths: entry.yamlPaths,
      hasDataBindings: entry.hasDataBindings,
    };
    if (Object.keys(entry.instanceProps).length > 0) {
      routeTarget.instanceProps = entry.instanceProps;
    }
    targets.push(routeTarget);
  }

  return targets;
}

async function loadKnownGlobals(reader: IFileReader): Promise<Set<string>> {
  const pageLayoutPath = 'app/components/PageLayout/index.tsx';
  if (!reader.fileExists(pageLayoutPath)) return new Set();
  try {
    const content = await reader.readFile(pageLayoutPath);
    const names = extractRenderedComponents(content);
    log('integration', `Known global components: ${[...names].join(', ') || '(none)'}`);
    return names;
  } catch {
    log('integration', 'Could not read PageLayout.');
    return new Set();
  }
}

interface PageScanContext {
  knownGlobalNames: Set<string>;
  accum: TargetAccumulator;
  fileIndex: Map<string, string[]>;
}

async function processPageInventory(
  reader: IFileReader,
  inv: PageInventory,
  scanCtx: PageScanContext,
): Promise<void> {
  for (const page of inv.pages) {
    if (page.type !== 'FRAME') continue;
    const yamlPaths = resolveYAMLPaths(page.name, scanCtx.fileIndex);
    if (!yamlPaths || yamlPaths.length === 0) continue;

    const yamlPath = yamlPaths[0];
    if (!reader.fileExists(yamlPath)) continue;

    let parsed: { nodes?: FigmaNode[] };
    try { parsed = await reader.readYAML<{ nodes?: FigmaNode[] }>(yamlPath); } catch { return; }
    if (!parsed.nodes) continue;

    const classified = classifyInstances(parsed.nodes, scanCtx.knownGlobalNames);
    const isMobile = /mobile/i.test(page.name);
    accumulateGlobalTargets(classified, scanCtx.accum, yamlPath, isMobile);
    accumulateRouteTargets(classified, scanCtx.accum, page.name, yamlPath);
  }
}

export async function buildIntegrationTargets(
  reader: IFileReader,
  inventories: PageInventory[],
  ctx: BootContext,
): Promise<{ targets: IntegrationTarget[]; wrappers: PageLayoutWrapper[] }> {
  const accum = createAccumulator();
  const knownGlobalNames = await loadKnownGlobals(reader);
  const scanCtx: PageScanContext = { knownGlobalNames, accum, fileIndex: ctx.yaml.fileIndex };

  for (const inv of inventories) {
    await processPageInventory(reader, inv, scanCtx);
  }

  return { targets: buildTargetsFromAccumulator(accum), wrappers: accum.pageLayoutWrappers };
}
