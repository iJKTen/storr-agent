import type { IFileReader } from '../../types.js';
import type { FigmaNode, FigmaDocument } from '../../figma/figma-node.js';
import { resolveYAMLPaths } from '../../figma/context.js';
import { log } from '../../log.js';
import { parse } from 'yaml';

export function collectComponentIds(nodes: FigmaNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.componentId) ids.add(node.componentId);
    if (node.children) {
      for (const id of collectComponentIds(node.children)) ids.add(id);
    }
  }
  return ids;
}

function buildDependencyGraph(
  componentNames: string[],
  parsedDocs: Map<string, FigmaNode[]>,
  componentIdIndex: Map<string, string>,
): Map<string, Set<string>> {
  const buildableSet = new Set(componentNames);
  const actualToFull = new Map<string, string>();
  for (const fullName of componentNames) {
    actualToFull.set(fullName.split('/').pop()!, fullName);
  }

  const deps = new Map<string, Set<string>>();
  for (const fullName of componentNames) {
    const depSet = new Set<string>();
    const nodes = parsedDocs.get(fullName) ?? [];
    const ids = collectComponentIds(nodes);

    for (const id of ids) {
      const depName = componentIdIndex.get(id);
      const actualName = fullName.split('/').pop()!;
      if (!depName || depName === actualName) continue;
      const depFull = buildableSet.has(depName) ? depName : actualToFull.get(depName);
      if (depFull && buildableSet.has(depFull)) depSet.add(depFull);
    }
    deps.set(fullName, depSet);
  }
  return deps;
}

function initializeKahnState(
  componentNames: string[],
  deps: Map<string, Set<string>>,
): { inDegree: Map<string, number>; dependents: Map<string, string[]>; orderIndex: Map<string, number> } {
  const inDegree = new Map(componentNames.map((n) => [n, deps.get(n)!.size]));
  const dependents = new Map(componentNames.map((n) => [n, [] as string[]]));
  for (const [name, nodeDeps] of deps) {
    for (const dep of nodeDeps) dependents.get(dep)!.push(name);
  }
  const orderIndex = new Map(componentNames.map((n, i) => [n, i]));
  return { inDegree, dependents, orderIndex };
}

function kahnSort(
  componentNames: string[],
  deps: Map<string, Set<string>>,
): string[] {
  const { inDegree, dependents, orderIndex } = initializeKahnState(componentNames, deps);
  const queue = componentNames.filter((n) => inDegree.get(n) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const newDeg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        const idx = orderIndex.get(dependent)!;
        let pos = queue.length;
        for (let i = 0; i < queue.length; i++) {
          if (orderIndex.get(queue[i])! > idx) { pos = i; break; }
        }
        queue.splice(pos, 0, dependent);
      }
    }
  }

  return sorted;
}

function appendCycleFallback(
  sorted: string[],
  componentNames: string[],
): string[] {
  if (sorted.length >= componentNames.length) return sorted;
  log('component_loop', 'Warning: Circular dependency detected. Appending remaining in original order.');
  for (const n of componentNames) {
    if (!sorted.includes(n)) sorted.push(n);
  }
  return sorted;
}

export async function topoSortComponents(
  componentNames: string[],
  reader: IFileReader,
  fileIndex: Map<string, string[]>,
  componentIdIndex: Map<string, string>,
): Promise<string[]> {
  const parsedDocs = new Map<string, FigmaNode[]>();
  for (const fullName of componentNames) {
    const actualName = fullName.split('/').pop()!;
    const yamlPaths = resolveYAMLPaths(actualName, fileIndex, fullName);
    if (yamlPaths?.length && reader.fileExists(yamlPaths[0])) {
      try {
        const doc = await reader.readYAML<FigmaDocument>(yamlPaths[0]);
        parsedDocs.set(fullName, doc.nodes ?? []);
      } catch { /* skip unreadable */ }
    }
  }

  const deps = buildDependencyGraph(componentNames, parsedDocs, componentIdIndex);
  const sorted = kahnSort(componentNames, deps);
  return appendCycleFallback(sorted, componentNames);
}

interface PackageNode {
  package?: string;
  children?: PackageNode[];
}

interface PackageDocument {
  nodes?: PackageNode[];
}

function walkPackages(nodes: PackageNode[]): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    if (node.package) result.push(node.package);
    if (node.children) result.push(...walkPackages(node.children));
  }
  return result;
}

export function collectYAMLPackages(yaml: string): string[] {
  const doc = parse(yaml);
  if (!doc || typeof doc !== 'object' || !('nodes' in doc)) return [];
  return [...new Set(walkPackages((doc as PackageDocument).nodes ?? []))];
}

export function resolvePackageName(componentName: string): { actualName: string; packageName?: string } {
  if (!componentName.startsWith('pkg/')) {
    return { actualName: componentName.replace(/\//g, '-') };
  }
  const segments = componentName.slice(4).split('/');
  if (segments.length === 2) {
    log('component_loop', `Detected package dependency: ${segments[0]} for ${segments[1]}`);
    return { actualName: segments[1], packageName: segments[0] };
  }
  return { actualName: componentName.replace(/\//g, '-') };
}
