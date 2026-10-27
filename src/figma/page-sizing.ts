import type { IFileReader, Inventory, PageInventory } from '../types.js';
import type { FigmaNode, FigmaDocument } from './figma-node.js';
import { resolveYAMLPaths } from './context.js';
import { log } from '../log.js';

export interface InstanceSizing {
  pageName: string;
  width?: string;
  height?: string;
}

function extractSizingFromCSS(css: string): { width?: string; height?: string } {
  const widthMatch = css.match(/width:\s*([^;]+)/);
  const heightMatch = css.match(/height:\s*([^;]+)/);
  return {
    width: widthMatch?.[1]?.trim(),
    height: heightMatch?.[1]?.trim(),
  };
}

function walkForInstanceSizing(
  nodes: FigmaNode[],
  pageName: string,
  result: Map<string, InstanceSizing[]>,
): void {
  for (const node of nodes) {
    if (node.type === 'INSTANCE') {
      if (!node.name) continue;
      const css = node.generatedCSS?.base ?? '';
      const { width, height } = extractSizingFromCSS(css);

      if (width || height) {
        const key = node.name.toLowerCase();
        const entries = result.get(key) ?? [];
        entries.push({ pageName, width, height });
        result.set(key, entries);
      }
      continue;
    }

    if (node.children) {
      walkForInstanceSizing(node.children, pageName, result);
    }
  }
}

async function collectPageSizing(
  reader: IFileReader,
  page: { name: string; type: string },
  yamlFileIndex: Map<string, string[]>,
  result: Map<string, InstanceSizing[]>,
): Promise<void> {
  if (page.type !== 'FRAME') return;

  const yamlPaths = resolveYAMLPaths(page.name, yamlFileIndex);
  if (!yamlPaths || yamlPaths.length === 0) return;

  const yamlPath = yamlPaths[0];
  if (!reader.fileExists(yamlPath)) return;

  let parsed: FigmaDocument;
  try {
    parsed = await reader.readYAML<FigmaDocument>(yamlPath);
  } catch {
    log('integration', `Failed to parse YAML: ${yamlPath}. Skipping.`);
    return;
  }

  if (!parsed.nodes) return;
  const pageName = parsed.metadata?.name ?? page.name;
  walkForInstanceSizing(parsed.nodes, pageName, result);
}

export async function buildInstanceSizingIndex(
  reader: IFileReader,
  yamlFileIndex: Map<string, string[]>,
  inventories: Inventory[],
): Promise<Map<string, InstanceSizing[]>> {
  const result = new Map<string, InstanceSizing[]>();

  const pageInventories = inventories.filter(
    (inv): inv is PageInventory => 'pages' in inv,
  );

  for (const inv of pageInventories) {
    for (const page of inv.pages) {
      await collectPageSizing(reader, page, yamlFileIndex, result);
    }
  }

  if (result.size > 0) {
    log('integration', `Built instance sizing index for ${result.size} component(s).`);
  }

  return result;
}

export function resolveInstanceWidth(entries: InstanceSizing[]): string | undefined {
  const widths = entries.map(e => e.width).filter((w): w is string => !!w);
  if (widths.length === 0) return undefined;
  const unique = new Set(widths);
  if (unique.size > 1) return undefined;
  return widths[0];
}

export function resolveInstanceHeight(entries: InstanceSizing[]): string | undefined {
  const heights = entries.map(e => e.height).filter((h): h is string => !!h);
  if (heights.length === 0) return undefined;
  const unique = new Set(heights);
  if (unique.size > 1) return undefined;
  return heights[0];
}
