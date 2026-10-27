import type { IFileReader } from '../../types.js';
import type { FigmaNode, FigmaDocument, FigmaComponentMeta } from '../../figma/figma-node.js';
import { parse } from 'yaml';

interface BehavioralVariant {
  name: string;
  nodeId: string;
}

interface VariantUsageEntry {
  variantName: string;
  referencedBy: string;
}

export function extractBehavioralVariants(yamlContent: string): BehavioralVariant[] {
  const doc = parse(yamlContent) as FigmaDocument | null;
  const root = doc?.nodes?.[0];
  if (root?.type !== 'COMPONENT_SET' || !root.children) return [];

  const variants: BehavioralVariant[] = [];
  for (const child of root.children) {
    if (child.type === 'COMPONENT' && child.name?.startsWith('Variant=') && child.id) {
      variants.push({ name: child.name, nodeId: child.id });
    }
  }
  return variants;
}

function collectYamlPathsByType(
  fileIndex: Map<string, string[]>,
): { pageYamlPaths: string[]; componentYamlPaths: string[] } {
  const pageYamlPaths: string[] = [];
  const componentYamlPaths: string[] = [];
  for (const [, paths] of fileIndex) {
    for (const p of paths) {
      if (p.endsWith('inventory.yaml')) continue;
      if (p.includes('/components/')) {
        componentYamlPaths.push(p);
      } else {
        pageYamlPaths.push(p);
      }
    }
  }
  return { pageYamlPaths, componentYamlPaths };
}

function buildVariantLookups(
  variants: BehavioralVariant[],
): { variantNodeIds: Set<string>; variantNameById: Map<string, string> } {
  const variantNodeIds = new Set(variants.map((v) => v.nodeId));
  const variantNameById = new Map(variants.map((v) => [v.nodeId, v.name]));
  return { variantNodeIds, variantNameById };
}

export function collectInstanceComponentIds(nodes: FigmaNode[]): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const node of nodes) {
    if (node.type === 'INSTANCE' && node.name && node.componentId) {
      result.push([node.name, node.componentId]);
      continue;
    }
    if (node.children) {
      result.push(...collectInstanceComponentIds(node.children));
    }
  }
  return result;
}

export function findSectionForInstance(nodes: FigmaNode[], componentId: string, depth = 0): string | undefined {
  for (const node of nodes) {
    if (node.type === 'INSTANCE' && node.componentId === componentId) {
      return undefined;
    }
    if (node.children) {
      const found = findSectionForInstance(node.children, componentId, depth + 1);
      if (found !== undefined) return found;
      for (const child of node.children) {
        if (hasInstanceWithId(child, componentId)) {
          return node.name ?? 'unnamed section';
        }
      }
    }
  }
  return undefined;
}

export function hasInstanceWithId(node: FigmaNode, componentId: string): boolean {
  if (node.type === 'INSTANCE' && node.componentId === componentId) return true;
  if (node.children) {
    return node.children.some((c) => hasInstanceWithId(c, componentId));
  }
  return false;
}

async function scanComponentYamlsForVariants(
  reader: IFileReader,
  componentName: string,
  lookups: { variantNodeIds: Set<string>; variantNameById: Map<string, string> },
  paths: string[],
): Promise<{ entries: VariantUsageEntry[]; found: Set<string> }> {
  const entries: VariantUsageEntry[] = [];
  const found = new Set<string>();

  for (const yamlPath of paths) {
    if (!reader.fileExists(yamlPath)) continue;
    let doc: FigmaDocument;
    try { doc = await reader.readYAML<FigmaDocument>(yamlPath); }
    catch { continue; }

    if (doc.metadata?.name === componentName) continue;

    const instanceRefs = collectInstanceComponentIds(doc.nodes ?? []);
    for (const [instanceName, compId] of instanceRefs) {
      if (lookups.variantNodeIds.has(compId)) {
        const variantName = lookups.variantNameById.get(compId)!;
        found.add(variantName);
        entries.push({ variantName, referencedBy: `${doc.metadata?.name ?? instanceName}` });
      }
    }
  }

  return { entries, found };
}

async function scanPageYamlsForVariants(
  reader: IFileReader,
  variants: BehavioralVariant[],
  paths: string[],
  alreadyFound: Set<string>,
): Promise<VariantUsageEntry[]> {
  const entries: VariantUsageEntry[] = [];

  for (const yamlPath of paths) {
    if (!reader.fileExists(yamlPath)) continue;
    let parsed: { metadata?: { components?: Record<string, FigmaComponentMeta> }; nodes?: FigmaNode[] };
    try { parsed = await reader.readYAML<typeof parsed>(yamlPath); }
    catch { continue; }

    if (!parsed.metadata?.components) continue;

    for (const meta of Object.values(parsed.metadata.components)) {
      if (!meta.name?.startsWith('Variant=') || !meta.componentSetId) continue;
      const matchingVariant = variants.find((v) => v.name === meta.name);
      if (!matchingVariant) continue;

      if (meta.id && parsed.nodes) {
        const sectionName = findSectionForInstance(parsed.nodes, meta.id);
        if (sectionName && !alreadyFound.has(meta.name)) {
          alreadyFound.add(meta.name);
          entries.push({ variantName: meta.name, referencedBy: sectionName });
        }
      }
    }
  }

  return entries;
}

export async function scanPageVariantUsage(
  reader: IFileReader,
  componentName: string,
  variants: BehavioralVariant[],
  fileIndex: Map<string, string[]>,
): Promise<VariantUsageEntry[]> {
  if (variants.length === 0) return [];

  const { pageYamlPaths, componentYamlPaths } = collectYamlPathsByType(fileIndex);
  const lookups = buildVariantLookups(variants);

  const compResult = await scanComponentYamlsForVariants(reader, componentName, lookups, componentYamlPaths);
  const pageEntries = await scanPageYamlsForVariants(reader, variants, pageYamlPaths, compResult.found);

  return [...compResult.entries, ...pageEntries];
}

export function buildVariantUsageSection(
  variants: BehavioralVariant[],
  usageEntries: VariantUsageEntry[],
): string[] {
  if (variants.length < 2) return [];

  const lines: string[] = [
    '## Variant Usage', '',
    'Both behavioral variants are used across pages:',
  ];

  for (const v of variants) {
    const usage = usageEntries.find((e) => e.variantName === v.name);
    if (usage) {
      lines.push(`- ${v.name}: Referenced by ${usage.referencedBy}`);
    } else {
      lines.push(`- ${v.name}`);
    }
  }

  lines.push('', 'Implement conditional rendering via a `variant` prop.', '');
  return lines;
}
