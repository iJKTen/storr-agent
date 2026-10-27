import { basename, extname, join } from 'node:path';
import { parse as parseYAML } from 'yaml';
import type { IExtendedReader, IFileScanner } from '../types.js';
import { isDataBindingNode, type FigmaNode, type FigmaDocument } from './figma-node.js';
import type { LocalImageManifest } from '../workspace/WorkspaceFileSystem.js';

// Re-export for consumers
export type { LocalImageManifest } from '../workspace/WorkspaceFileSystem.js';

// ── Prompt Formatting ──

function formatRawImageManifest(mapping: Record<string, string>): string {
  const entries = Object.entries(mapping);
  if (entries.length === 0) return '';

  const lines = [
    '# Downloaded Figma Images', '',
    'The following Figma image fills have been downloaded to the workspace.',
    'Use the local path when referencing these images in components.', '',
    '| imageRef Hash | Local Path |', '|---|---|',
  ];
  for (const [hash, localPath] of entries) {
    lines.push(`| ${hash} | ${localPath} |`);
  }
  return lines.join('\n');
}

function formatResolvedImageManifest(resolvedNames: Record<string, string>): string {
  const lines = [
    '# Downloaded Figma Images', '',
    'The following Figma image fills have been pre-copied to `app/assets/`.',
    'Use the `~/assets/` import path when referencing these images in components.', '',
    '| imageRef Hash | Import Path |', '|---|---|',
  ];

  for (const [hash, semanticName] of Object.entries(resolvedNames)) {
    lines.push(`| ${hash} | ~/assets/${semanticName} |`);
  }

  return lines.join('\n');
}

export function formatImageManifestForPrompt(manifest: LocalImageManifest): string {
  const resolved = Object.entries(manifest.resolvedNames);
  if (resolved.length === 0) {
    return formatRawImageManifest(manifest.mapping);
  }
  return formatResolvedImageManifest(manifest.resolvedNames);
}

// ── Fill Reference Types (local to image resolution) ──

interface FigmaImageFill {
  type: string;
  imageRef?: string;
}

interface FigmaGlobalVars {
  styles?: Record<string, FigmaImageFill[]>;
}

interface FigmaDocumentWithFills extends FigmaDocument {
  globalVars?: FigmaGlobalVars;
}

function buildFillImageRefMap(
  styles: Record<string, FigmaImageFill[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, fills] of Object.entries(styles)) {
    if (!key.startsWith('fill_') || !Array.isArray(fills)) continue;
    for (const fill of fills) {
      if (fill.type === 'IMAGE' && fill.imageRef) {
        map.set(key, fill.imageRef);
      }
    }
  }
  return map;
}

// ── YAML-aware Image Name Resolution ──

interface ImageRefOccurrence {
  componentSlug: string;
  variant: 'mobile' | 'desktop' | null;
  ext: string;
}

function collectImageRefs(
  node: FigmaNode,
  ancestors: string[],
  results: Array<{ imageRef: string; nodeName: string; ancestors: string[] }>,
  fillMap: Map<string, string>,
): void {
  if (isDataBindingNode(node)) return;

  const ref = node.imageRef ?? (node.fills ? fillMap.get(node.fills) : undefined);
  if (typeof ref === 'string' && ref) {
    results.push({
      imageRef: ref,
      nodeName: node.name || 'unnamed',
      ancestors: [...ancestors],
    });
  }
  if (node.children) {
    const currentName = typeof node.name === 'string' ? node.name : '';
    for (const child of node.children) {
      collectImageRefs(child, [...ancestors, currentName], results, fillMap);
    }
  }
}

function detectVariant(ancestors: string[]): 'mobile' | 'desktop' | null {
  for (const name of ancestors) {
    const lower = name.toLowerCase();
    if (lower.includes('device=mobile') || lower.includes('device = mobile')) return 'mobile';
    if (lower.includes('device=desktop') || lower.includes('device = desktop')) return 'desktop';
    if (/\bmobile\b/.test(lower)) return 'mobile';
    if (/\bdesktop\b/.test(lower)) return 'desktop';
  }
  return null;
}

function processYAMLEntry(
  entry: { relativePath: string; filename: string },
  content: string,
  imageManifest: LocalImageManifest,
  hashOccurrences: Map<string, ImageRefOccurrence[]>,
): void {
  let parsed: FigmaDocumentWithFills;
  try { parsed = parseYAML(content) as FigmaDocumentWithFills; }
  catch (err) { throw new Error(`Failed to parse YAML ${entry.filename}: ${err instanceof Error ? err.message : String(err)}`); }
  if (!parsed || !Array.isArray(parsed.nodes)) return;

  const fillMap = buildFillImageRefMap(parsed.globalVars?.styles ?? {});
  const componentSlug = entry.filename.replace(/\.ya?ml$/, '').toLowerCase();
  const refs: Array<{ imageRef: string; nodeName: string; ancestors: string[] }> = [];
  for (const node of parsed.nodes) collectImageRefs(node, [], refs, fillMap);

  for (const ref of refs) {
    const sourcePath = imageManifest.mapping[ref.imageRef];
    const ext = sourcePath ? extname(sourcePath) : '.png';
    const variant = detectVariant(ref.ancestors);

    const existing = hashOccurrences.get(ref.imageRef) ?? [];
    existing.push({ componentSlug, variant, ext });
    hashOccurrences.set(ref.imageRef, existing);
  }
}

function groupBySlug(hashOccurrences: Map<string, ImageRefOccurrence[]>): Map<string, Set<string>> {
  const slugHashes = new Map<string, Set<string>>();
  for (const [hash, occurrences] of hashOccurrences) {
    for (const occ of occurrences) {
      const existing = slugHashes.get(occ.componentSlug) ?? new Set();
      existing.add(hash);
      slugHashes.set(occ.componentSlug, existing);
    }
  }
  return slugHashes;
}

interface BaseImageName {
  hash: string;
  name: string;
  ext: string;
}

function assignBaseNames(
  hashOccurrences: Map<string, ImageRefOccurrence[]>,
  slugHashes: Map<string, Set<string>>,
): BaseImageName[] {
  const results: BaseImageName[] = [];
  for (const [hash, occurrences] of hashOccurrences) {
    const { componentSlug, variant, ext } = occurrences[0];
    const hasMultiple = (slugHashes.get(componentSlug)?.size ?? 0) > 1;
    const suffix = hasMultiple && variant ? `-${variant}` : '';
    results.push({ hash, name: `${componentSlug}${suffix}`, ext });
  }
  return results;
}

function deduplicateCollisions(entries: BaseImageName[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const { name } of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const resolved: Record<string, string> = {};
  for (const { hash, name, ext } of entries) {
    const suffix = (counts.get(name) ?? 0) > 1 ? `-${hash.slice(0, 8)}` : '';
    resolved[hash] = `${name}${suffix}${ext}`;
  }
  return resolved;
}

function buildSemanticNames(
  hashOccurrences: Map<string, ImageRefOccurrence[]>,
  slugHashes: Map<string, Set<string>>,
): Record<string, string> {
  const baseNames = assignBaseNames(hashOccurrences, slugHashes);
  return deduplicateCollisions(baseNames);
}

export async function resolveImageNames(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  imageManifest: LocalImageManifest,
  workspacePath: string,
): Promise<Record<string, string>> {
  const hashOccurrences = await collectAllImageRefsWithPath(
    extReader, scanner, imageManifest, workspacePath,
  );
  const slugHashes = groupBySlug(hashOccurrences);
  return buildSemanticNames(hashOccurrences, slugHashes);
}

async function collectAllImageRefsWithPath(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  imageManifest: LocalImageManifest,
  workspacePath: string,
): Promise<Map<string, ImageRefOccurrence[]>> {
  const yamlEntries = await scanner.listYAMLTree();
  const hashOccurrences = new Map<string, ImageRefOccurrence[]>();

  for (const entry of yamlEntries) {
    if (entry.filename === 'inventory.yaml') continue;

    const fullPath = join(workspacePath, entry.relativePath);
    let content: string;
    try { content = await extReader.readAbsoluteFile(fullPath); }
    catch (err) { throw new Error(`Failed to read ${entry.relativePath}: ${err instanceof Error ? err.message : String(err)}`); }

    processYAMLEntry(entry, content, imageManifest, hashOccurrences);
  }

  return hashOccurrences;
}

// ── SVG Asset Scanning ──

export interface SvgAssetManifest {
  count: number;
  entries: Array<{ name: string; assetPath: string }>;
}

function collectSvgEntries(
  node: FigmaNode,
  results: Array<{ name: string; assetPath: string }>,
): void {
  if (typeof node.assetPath === 'string') {
    results.push({
      name: node.name || 'unnamed',
      assetPath: node.assetPath,
    });
  }
  if (node.children) {
    for (const child of node.children) collectSvgEntries(child, results);
  }
}

function parseSvgFromEntry(
  content: string,
): Array<{ name: string; assetPath: string }> {
  const parsed = parseYAML(content) as FigmaDocument;
  if (!parsed || !Array.isArray(parsed.nodes)) return [];

  const entries: Array<{ name: string; assetPath: string }> = [];
  for (const node of parsed.nodes) collectSvgEntries(node, entries);
  return entries;
}

async function collectSvgFromYAML(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  workspacePath: string,
): Promise<{ entries: Array<{ name: string; assetPath: string }>; seen: Set<string> }> {
  const yamlEntries = await scanner.listYAMLTree();
  const seen = new Set<string>();
  const entries: Array<{ name: string; assetPath: string }> = [];

  for (const entry of yamlEntries) {
    const fullPath = join(workspacePath, entry.relativePath);
    let content: string;
    try { content = await extReader.readAbsoluteFile(fullPath); }
    catch (err) { throw new Error(`Failed to read ${entry.relativePath}: ${err instanceof Error ? err.message : String(err)}`); }

    const fileEntries = parseSvgFromEntry(content);
    for (const e of fileEntries) {
      if (!seen.has(e.assetPath)) {
        seen.add(e.assetPath);
        entries.push(e);
      }
    }
  }

  return { entries, seen };
}

async function scanAssetsDirectory(
  extReader: IExtendedReader,
  entries: Array<{ name: string; assetPath: string }>,
  seen: Set<string>,
  workspacePath: string,
): Promise<void> {
  const assetsDir = join(workspacePath, 'app', 'assets');
  if (!extReader.directoryExists(assetsDir)) return;

  const assetFiles = await extReader.listDir(assetsDir);
  for (const file of assetFiles) {
    if (!file.endsWith('.svg')) continue;
    const assetPath = `app/assets/${file}`;
    if (!seen.has(assetPath)) {
      seen.add(assetPath);
      entries.push({ name: file.replace(/\.svg$/, ''), assetPath });
    }
  }
}

export async function scanSvgAssets(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  workspacePath: string,
): Promise<SvgAssetManifest> {
  const { entries, seen } = await collectSvgFromYAML(extReader, scanner, workspacePath);
  await scanAssetsDirectory(extReader, entries, seen, workspacePath);
  return { count: entries.length, entries };
}

export function formatSvgManifestForPrompt(manifest: SvgAssetManifest): string {
  if (manifest.entries.length === 0) return '';

  const lines = [
    '# Downloaded SVG Assets', '',
    'These SVG assets have been pre-downloaded and copied to `app/assets/`.',
    'Import them directly — do NOT hardcode inline SVG markup.', '',
    '| Asset Name | Import Path |', '|---|---|',
  ];

  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const fileName = basename(entry.assetPath);
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    lines.push(`| ${entry.name} | ~/assets/${fileName} |`);
  }

  return lines.join('\n');
}
