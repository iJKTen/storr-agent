import { parse, stringify } from 'yaml';
import type { FigmaNode, FigmaDocument } from './figma-node.js';
import type { IFileReader, YAMLFileEntry } from '../types.js';

export type VariantUsageMap = Map<string, Set<string>>;

function collectNodeRefs(nodes: FigmaNode[]): Set<string> {
  const refs = new Set<string>();
  for (const node of nodes) {
    if (node.componentId) refs.add(node.componentId);
    if (node.children) {
      for (const ref of collectNodeRefs(node.children)) refs.add(ref);
    }
  }
  return refs;
}

function collectAllDocRefs(docs: Map<string, FigmaDocument>): Set<string> {
  const refs = new Set<string>();
  for (const doc of docs.values()) {
    if (doc.nodes) {
      for (const ref of collectNodeRefs(doc.nodes)) refs.add(ref);
    }
  }
  return refs;
}

function extractUsedVariants(
  root: FigmaNode,
  allRefs: Set<string>,
): Set<string> | null {
  if (root.type !== 'COMPONENT_SET' || !root.children) return null;
  const variants = root.children.filter((c) => c.type === 'COMPONENT');

  // Don't filter state variants — they represent runtime states, not design choices
  if (variants.some((c) => c.name?.startsWith('State='))) return null;

  // Don't filter device variants — both must render with CSS show/hide for responsiveness
  if (variants.some((c) => c.name?.startsWith('Device='))) return null;

  // Don't filter behavioral variants — they represent design-intent modes (e.g. Default/HoverImage)
  // that the plan references for composition; filtering breaks scaffold dep resolution
  if (variants.some((c) => c.name?.startsWith('Variant='))) return null;

  const variantIds = variants.filter((c) => c.id).map((c) => c.id!);
  const used = new Set(variantIds.filter((id) => allRefs.has(id)));
  if (used.size === 0 || used.size === variantIds.length) return null;
  return used;
}

async function loadComponentDocs(
  reader: IFileReader,
  entries: YAMLFileEntry[],
): Promise<Map<string, FigmaDocument>> {
  const docs = new Map<string, FigmaDocument>();
  for (const entry of entries) {
    if (!entry.directory.endsWith('/components')) continue;
    if (entry.filename === 'inventory.yaml') continue;
    try {
      const doc = await reader.readYAML<FigmaDocument>(entry.relativePath);
      docs.set(entry.relativePath, doc);
    } catch { /* skip unreadable */ }
  }
  return docs;
}

export async function buildVariantUsageMap(
  reader: IFileReader,
  entries: YAMLFileEntry[],
): Promise<VariantUsageMap> {
  const docs = await loadComponentDocs(reader, entries);
  const allRefs = collectAllDocRefs(docs);
  const result: VariantUsageMap = new Map();
  for (const doc of docs.values()) {
    const root = doc.nodes?.[0];
    const name = doc.metadata?.name;
    if (!root || !name) continue;
    const used = extractUsedVariants(root, allRefs);
    if (used) result.set(name, used);
  }
  return result;
}

function removeOrphanedMetadata(doc: FigmaDocument): void {
  if (!doc.metadata?.components || !doc.nodes) return;
  const usedIds = collectNodeRefs(doc.nodes);
  for (const id of Object.keys(doc.metadata.components)) {
    if (!usedIds.has(id)) delete doc.metadata.components[id];
  }
}

export function filterUnusedVariants(
  yamlContent: string,
  usedVariantIds: Set<string>,
): string {
  const doc = parse(yamlContent) as FigmaDocument;
  const root = doc.nodes?.[0];
  if (root?.type !== 'COMPONENT_SET' || !root.children) return yamlContent;
  root.children = root.children.filter(
    (child) => child.type !== 'COMPONENT' || usedVariantIds.has(child.id ?? ''),
  );
  removeOrphanedMetadata(doc);
  return stringify(doc, { lineWidth: 0 });
}

function isOrphanedSvgNode(node: FigmaNode): boolean {
  return node.type === 'IMAGE-SVG' && !node.assetPath;
}

function downgradeOrphanedNodes(nodes: FigmaNode[]): boolean {
  let changed = false;
  for (const node of nodes) {
    if (isOrphanedSvgNode(node)) {
      node.type = 'FRAME';
      changed = true;
    }
    if (node.children && downgradeOrphanedNodes(node.children)) {
      changed = true;
    }
  }
  return changed;
}

export function downgradeOrphanedSvgNodes(yamlContent: string): string {
  const doc = parse(yamlContent) as FigmaDocument;
  if (!doc?.nodes) return yamlContent;
  if (!downgradeOrphanedNodes(doc.nodes)) return yamlContent;
  removeOrphanedMetadata(doc);
  return stringify(doc, { lineWidth: 0 });
}
