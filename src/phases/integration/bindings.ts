import type { IFileReader, IFileWriter } from '../../types.js';
import { log } from '../../log.js';

interface BindingEntry {
  entity: 'product' | 'collection' | 'article';
  field: string;
  numericId: string;
}

function extractBindingsFromYAML(content: string): BindingEntry[] {
  const bindings: BindingEntry[] = [];
  const seen = new Set<string>();
  const regex = /\{\{(product|collection|article)\.(gid)\.(\d+)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const key = `${match[1]}.${match[2]}.${match[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      bindings.push({
        entity: match[1] as BindingEntry['entity'],
        field: match[2],
        numericId: match[3],
      });
    }
  }
  return bindings;
}

function buildBindingTypeHeader(): string[] {
  return [
    `export type BindingEntity = 'product' | 'collection' | 'article';`,
    ``,
    `export interface FigmaBinding {`,
    `  entity: BindingEntity;`,
    `  field: string;`,
    `  numericId: string;`,
    `}`,
  ];
}

function buildGidExport(entity: string, shopifyType: string): string[] {
  return [
    `export const ${entity}Gids: string[] = [`,
    `  ...new Set(`,
    `    figmaBindings`,
    `      .filter((b) => b.entity === '${entity}' && b.field === 'gid')`,
    `      .map((b) => \`gid://shopify/${shopifyType}/\${b.numericId}\`),`,
    `  ),`,
    `];`,
  ];
}

function generateBindingsTS(bindings: BindingEntry[]): string {
  const bindingLines = bindings.map(
    (b) => `  { entity: '${b.entity}', field: '${b.field}', numericId: '${b.numericId}' },`,
  );

  return [
    ...buildBindingTypeHeader(), ``,
    `export const figmaBindings: FigmaBinding[] = [`, ...bindingLines, `];`, ``,
    ...buildGidExport('product', 'Product'), ``,
    ...buildGidExport('collection', 'Collection'), ``,
  ].join('\n');
}

export async function syncBindings(
  reader: IFileReader,
  writer: IFileWriter,
  yamlPaths: Set<string>,
): Promise<void> {
  const allBindings: BindingEntry[] = [];

  for (const yamlPath of yamlPaths) {
    if (!reader.fileExists(yamlPath)) continue;

    let content: string;
    try { content = await reader.readFile(yamlPath); } catch { continue; }
    allBindings.push(...extractBindingsFromYAML(content));
  }

  if (allBindings.length === 0) {
    log('integration', 'No data-binding GIDs found. Skipping bindings sync.');
    return;
  }

  const content = generateBindingsTS(allBindings);
  await writer.writeFile('app/content/bindings.ts', content);
  log('integration', `Synced bindings.ts with ${allBindings.length} binding(s).`);
}
