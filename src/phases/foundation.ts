import path from 'path';
import type { IFileReader, IFileWriter, IFileCopier } from '../types.js';
import type { LocalImageManifest } from '../workspace/WorkspaceFileSystem.js';
import type { BootContext } from '../figma/context.js';
import { log } from '../log.js';

type ListDirFn = (absolutePath: string) => string[];

const CSS_SEARCH_ROOTS = ['.figma/css', '.figma/build'];

interface CSSFileSpec {
  source: string;
  target: string;
  label: string;
}

const CSS_FILES: CSSFileSpec[] = [
  { source: 'fonts.css', target: 'app/styles/fonts.css', label: 'fonts.css' },
  { source: 'typography.css', target: 'app/styles/typography.css', label: 'typography.css' },
];

function isPopulatedCSS(content: string): boolean {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0;
}

function searchRoot(
  reader: IFileReader,
  listDirSync: ListDirFn,
  root: string,
  filename: string,
): string | undefined {
  const rootAbs = path.join(reader.workspacePath, root);
  for (const dir of listDirSync(rootAbs)) {
    const candidate = `${root}/${dir}/${filename}`;
    if (reader.fileExists(candidate)) return candidate;
  }
  return undefined;
}

function findPipelineCSS(
  reader: IFileReader,
  listDirSync: ListDirFn,
  filename: string,
): string | undefined {
  for (const root of CSS_SEARCH_ROOTS) {
    const found = searchRoot(reader, listDirSync, root, filename);
    if (found) return found;
  }
  return undefined;
}

async function copyPipelineCSS(
  reader: IFileReader,
  writer: IFileWriter,
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  const content = await reader.readFile(sourcePath);
  if (!content.trim()) return false;
  await writer.writeFile(targetPath, content);
  return true;
}

async function injectCSSIntoRoot(
  reader: IFileReader,
  writer: IFileWriter,
  cssFilename: string,
  importName: string,
): Promise<boolean> {
  const rootPath = 'app/root.tsx';
  if (!reader.fileExists(rootPath)) return false;

  let content = await reader.readFile(rootPath);
  if (content.includes(importName)) return false;

  const appImportLine = `import appStyles from '~/styles/app.css?url';`;
  if (!content.includes(appImportLine)) return false;

  const newImport = `import ${importName} from '~/styles/${cssFilename}?url';`;
  content = content.replace(appImportLine, `${newImport}\n${appImportLine}`);

  const appLinkLine = `<link rel="stylesheet" href={appStyles}></link>`;
  if (content.includes(appLinkLine)) {
    const newLink = `<link rel="stylesheet" href={${importName}}></link>`;
    content = content.replace(appLinkLine, `${newLink}\n          ${appLinkLine}`);
  }

  await writer.writeFile(rootPath, content);
  return true;
}

interface ImageCopyInput {
  hash: string;
  semanticName: string;
  assetsDir: string;
  mapping: Record<string, string>;
}

async function copySingleImage(
  copier: IFileCopier,
  reader: IFileReader,
  input: ImageCopyInput,
): Promise<void> {
  const sourcePath = input.mapping[input.hash];
  if (!sourcePath) {
    log('foundation', `No source file for imageRef ${input.hash.slice(0, 12)}... — skipping.`);
    return;
  }

  const destRelative = `app/assets/${input.semanticName}`;
  if (reader.fileExists(destRelative)) {
    log('foundation', `${input.semanticName} already exists. Skipping.`);
    return;
  }

  const sourceAbsolute = path.join(reader.workspacePath, sourcePath);
  const destPath = path.join(input.assetsDir, input.semanticName);
  try {
    await copier.copyFile(sourceAbsolute, destPath);
    log('foundation', `Copied ${input.semanticName} to app/assets/.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('foundation', `Failed to copy ${input.semanticName}: ${msg}`);
  }
}

async function copyRasterImages(
  copier: IFileCopier,
  reader: IFileReader,
  imageManifest: LocalImageManifest,
): Promise<void> {
  const { mapping, resolvedNames } = imageManifest;
  const resolvedEntries = Object.entries(resolvedNames);
  if (resolvedEntries.length === 0) return;

  const assetsDir = path.join(reader.workspacePath, 'app', 'assets');
  await copier.ensureDir(assetsDir);

  for (const [hash, semanticName] of resolvedEntries) {
    await copySingleImage(copier, reader, { hash, semanticName, assetsDir, mapping });
  }
}

async function copySingleCSSFile(
  reader: IFileReader,
  writer: IFileWriter,
  listDirSync: ListDirFn,
  spec: CSSFileSpec,
): Promise<void> {
  if (reader.fileExists(spec.target)) {
    const existing = await reader.readFile(spec.target);
    if (isPopulatedCSS(existing)) {
      log('foundation', `${spec.label} already populated. Skipping.`);
      return;
    }
  }

  log('foundation', `${spec.label} is empty. Looking for pipeline-generated file...`);
  const sourcePath = findPipelineCSS(reader, listDirSync, spec.source);
  if (!sourcePath) {
    log('foundation', `No pipeline-generated ${spec.label} found.`);
    return;
  }
  await copyPipelineCSS(reader, writer, sourcePath, spec.target);
  log('foundation', `Copied ${spec.label} to app/styles/.`);
}

async function copyCSSFiles(
  reader: IFileReader,
  writer: IFileWriter,
  listDirSync: ListDirFn,
): Promise<void> {
  for (const spec of CSS_FILES) {
    await copySingleCSSFile(reader, writer, listDirSync, spec);
  }
}

async function injectTypography(
  reader: IFileReader,
  writer: IFileWriter,
): Promise<void> {
  if (!reader.fileExists('app/styles/typography.css')) return;
  const content = await reader.readFile('app/styles/typography.css');
  if (!isPopulatedCSS(content)) return;

  const injected = await injectCSSIntoRoot(reader, writer, 'typography.css', 'typographyStyles');
  if (injected) {
    log('foundation', 'Injected typography.css import into app/root.tsx.');
  }
}

async function copyImages(
  copier: IFileCopier,
  reader: IFileReader,
  ctx: BootContext | undefined,
): Promise<void> {
  if (!ctx?.assets.imageManifest) return;
  log('foundation', 'Copying raster images to app/assets/...');
  await copyRasterImages(copier, reader, ctx.assets.imageManifest);
}

interface FoundationDeps {
  reader: IFileReader;
  writer: IFileWriter;
  copier: IFileCopier;
  listDirSync: ListDirFn;
}

export async function foundation(
  deps: FoundationDeps,
  ctx?: BootContext,
): Promise<void> {
  await copyCSSFiles(deps.reader, deps.writer, deps.listDirSync);
  await injectTypography(deps.reader, deps.writer);
  await copyImages(deps.copier, deps.reader, ctx);
}
