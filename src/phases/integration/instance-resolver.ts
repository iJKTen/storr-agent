import type { ExistingComponent, IFileReader } from '../../types.js';
import type { BootContext } from '../../figma/context.js';
import type { FigmaNode, FigmaComponentMeta, FigmaDocument } from '../../figma/figma-node.js';
import { resolveExistingComponent } from '../../figma/context.js';
import { log } from '../../log.js';

interface VariantCandidate {
  componentSetName: string;
  allVariants: string[];
}

interface PageYAMLWithMetadata {
  metadata?: {
    name?: string;
    components?: Record<string, FigmaComponentMeta>;
  };
  nodes?: FigmaNode[];
}

function walkForComponentIds(
  nodes: FigmaNode[],
  result: Map<string, string>,
): void {
  for (const node of nodes) {
    if (node.type === 'INSTANCE') {
      if (node.name && node.componentId) {
        result.set(node.name, node.componentId);
      }
      continue;
    }
    if (node.children) {
      walkForComponentIds(node.children, result);
    }
  }
}

function buildInstanceComponentIdMap(
  allParsed: PageYAMLWithMetadata[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const parsed of allParsed) {
    if (parsed.nodes) {
      walkForComponentIds(parsed.nodes, map);
    }
  }
  return map;
}

function collectMetadataComponents(
  allParsed: PageYAMLWithMetadata[],
): FigmaComponentMeta[] {
  const all: FigmaComponentMeta[] = [];
  for (const parsed of allParsed) {
    if (parsed.metadata?.components) {
      for (const entry of Object.values(parsed.metadata.components)) {
        all.push(entry);
      }
    }
  }
  return all;
}

function groupByComponentSetId(
  components: FigmaComponentMeta[],
): Map<string, FigmaComponentMeta[]> {
  const map = new Map<string, FigmaComponentMeta[]>();
  for (const entry of components) {
    if (entry.componentSetId) {
      const group = map.get(entry.componentSetId) ?? [];
      group.push(entry);
      map.set(entry.componentSetId, group);
    }
  }
  return map;
}

function disambiguateVariant(
  candidates: VariantCandidate[],
  siblings: FigmaComponentMeta[],
): string {
  const siblingNames = new Set(
    siblings.map((s) => s.name).filter((n): n is string => Boolean(n)),
  );
  let best = candidates[0];
  let bestExtra = Infinity;

  for (const c of candidates) {
    const cSet = new Set(c.allVariants);
    const containsAll = [...siblingNames].every((n) => cSet.has(n));
    if (containsAll) {
      const extra = c.allVariants.length - siblingNames.size;
      if (extra < bestExtra) {
        bestExtra = extra;
        best = c;
      }
    }
  }

  return best.componentSetName;
}

interface MetadataResolutionContext {
  allMeta: FigmaComponentMeta[];
  instanceToComponentId: Map<string, string>;
  setIdToEntries: Map<string, FigmaComponentMeta[]>;
  variantIndex: Map<string, VariantCandidate[]>;
}

function tryDirectMatch(
  instanceName: string,
  reader: IFileReader,
  existingComponents: Map<string, ExistingComponent>,
): boolean {
  if (reader.fileExists(`app/components/${instanceName}/index.tsx`)) return true;
  const match = resolveExistingComponent(instanceName, existingComponents);
  return match !== undefined;
}

function hasComponentYAML(
  instanceName: string,
  fileIndex: Map<string, string[]>,
): boolean {
  const paths = fileIndex.get(instanceName.toLowerCase());
  return paths?.some((p) => p.includes('/components/')) ?? false;
}

function resolveByMetadata(
  metaEntry: FigmaComponentMeta,
  mctx: MetadataResolutionContext,
): string | undefined {
  if (!metaEntry.componentSetId) {
    return metaEntry.name ?? undefined;
  }
  if (!metaEntry.name) return undefined;

  const candidates = mctx.variantIndex.get(metaEntry.name);
  if (!candidates || candidates.length === 0) return undefined;

  if (candidates.length === 1) return candidates[0].componentSetName;

  const siblings = mctx.setIdToEntries.get(metaEntry.componentSetId) ?? [];
  const resolved = disambiguateVariant(candidates, siblings);
  log('integration', `Variant "${metaEntry.name}" resolved to "${resolved}" via set matching.`);
  return resolved;
}

function applyExistingComponentMatch(
  resolved: string,
  existingComponents: Map<string, ExistingComponent>,
): string {
  const match = resolveExistingComponent(resolved, existingComponents);
  return match ? match.name : resolved;
}

function buildMetadataContext(
  allParsed: PageYAMLWithMetadata[],
  variantIndex: Map<string, VariantCandidate[]>,
): MetadataResolutionContext {
  const instanceToComponentId = buildInstanceComponentIdMap(allParsed);
  const allMeta = collectMetadataComponents(allParsed);
  const setIdToEntries = groupByComponentSetId(allMeta);
  return { allMeta, instanceToComponentId, setIdToEntries, variantIndex };
}

function resolveViaMetadata(
  instanceNames: string[],
  mctx: MetadataResolutionContext,
  reader: IFileReader,
  existingComponents: Map<string, ExistingComponent>,
  fileIndex: Map<string, string[]>,
): Map<string, string> {
  const nameMap = new Map<string, string>();

  for (const instanceName of instanceNames) {
    // Check existing components first (with case-insensitive matching)
    const existingMatch = resolveExistingComponent(instanceName, existingComponents);
    if (existingMatch) {
      if (existingMatch.name !== instanceName) {
        nameMap.set(instanceName, existingMatch.name);
      }
      continue;
    }
    if (tryDirectMatch(instanceName, reader, existingComponents)) continue;
    if (hasComponentYAML(instanceName, fileIndex)) continue;

    const componentId = mctx.instanceToComponentId.get(instanceName);
    if (!componentId) continue;

    const metaEntry = mctx.allMeta.find((e) => e.id === componentId);
    if (!metaEntry) continue;

    const resolved = resolveByMetadata(metaEntry, mctx);
    if (!resolved) continue;

    const finalName = applyExistingComponentMatch(resolved, existingComponents);
    nameMap.set(instanceName, finalName);
    const kind = metaEntry.componentSetId ? 'variant' : 'standalone';
    log('integration', `Resolved "${instanceName}" → "${finalName}" (${kind})`);
  }

  return nameMap;
}

async function parsePageYAMLs(
  reader: IFileReader,
  pageYamlPaths: string[],
): Promise<PageYAMLWithMetadata[]> {
  const results: PageYAMLWithMetadata[] = [];
  for (const yamlPath of pageYamlPaths) {
    if (!reader.fileExists(yamlPath)) continue;
    const parsed = await reader.readYAML<PageYAMLWithMetadata>(yamlPath);
    results.push(parsed);
  }
  return results;
}

function parseComponentSetVariants(
  doc: FigmaDocument,
): Array<{ name: string; variants: string[] }> {
  const results: Array<{ name: string; variants: string[] }> = [];
  if (!doc.nodes) return results;

  for (const node of doc.nodes) {
    if (node.type !== 'COMPONENT_SET' || !node.children) continue;
    const variants: string[] = [];
    for (const child of node.children) {
      if (child.type === 'COMPONENT' && child.name) {
        variants.push(child.name);
      }
    }
    if (variants.length > 0 && doc.metadata?.name) {
      results.push({ name: doc.metadata.name, variants });
    }
  }
  return results;
}

export async function buildVariantIndex(
  reader: IFileReader,
  ctx: BootContext,
): Promise<Map<string, VariantCandidate[]>> {
  const index = new Map<string, VariantCandidate[]>();

  for (const [, paths] of ctx.yaml.fileIndex) {
    for (const yamlPath of paths) {
      if (!yamlPath.includes('/components/')) continue;
      if (yamlPath.endsWith('inventory.yaml')) continue;

      let parsed: FigmaDocument;
      try { parsed = await reader.readYAML<FigmaDocument>(yamlPath); }
      catch (err) { throw new Error(`Failed to parse component YAML ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`); }

      for (const { name, variants } of parseComponentSetVariants(parsed)) {
        const candidate: VariantCandidate = { componentSetName: name, allVariants: variants };
        for (const variantName of variants) {
          const list = index.get(variantName) ?? [];
          list.push(candidate);
          index.set(variantName, list);
        }
      }
    }
  }

  log('integration', `Built variant index with ${index.size} variant name(s).`);
  return index;
}

export interface InstanceResolution {
  nameMap: Map<string, string>;
  /** Maps instance name → variant prop value (e.g. "hoverImage") for variant-resolved instances. */
  variantMap: Map<string, string>;
}

/**
 * Convert a Figma variant name like "Variant=HoverImage" to a camelCase prop value like "hoverImage".
 * Returns undefined for non-variant or default variant names.
 */
function variantNameToPropValue(variantName: string): string | undefined {
  const match = variantName.match(/^(?:Variant|State)=(.+)$/);
  if (!match) return undefined;
  const raw = match[1];
  // "Default" → "default", "HoverImage" → "hoverImage"
  return raw.charAt(0).toLowerCase() + raw.slice(1);
}

export async function resolveInstanceToComponent(
  reader: IFileReader,
  instanceNames: string[],
  pageYamlPaths: string[],
  ctx: BootContext,
): Promise<InstanceResolution> {
  const allParsed = await parsePageYAMLs(reader, pageYamlPaths);
  const variantIndex = await buildVariantIndex(reader, ctx);
  const mctx = buildMetadataContext(allParsed, variantIndex);

  const nameMap = resolveViaMetadata(
    instanceNames, mctx, reader, ctx.project.existingComponents, ctx.yaml.fileIndex,
  );

  // Build variant map: for each resolved instance, check if it was resolved
  // through a variant metadata entry and preserve the variant prop value.
  const variantMap = new Map<string, string>();
  for (const instanceName of instanceNames) {
    const componentId = mctx.instanceToComponentId.get(instanceName);
    if (!componentId) continue;
    const metaEntry = mctx.allMeta.find((e) => e.id === componentId);
    if (!metaEntry?.componentSetId || !metaEntry.name) continue;
    const propValue = variantNameToPropValue(metaEntry.name);
    if (propValue && propValue !== 'default') {
      variantMap.set(instanceName, propValue);
    }
  }

  return { nameMap, variantMap };
}
