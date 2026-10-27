import { readFile, writeFile, readdir, mkdir, stat, copyFile as fsCopyFile } from 'node:fs/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { parse as parseYAML } from 'yaml';
import type {
  AgentConfig,
  EvalLogEntry,
  ExistingComponent,
  IFileReader,
  IFileWriter,
  IFileScanner,
  IExtendedReader,
  IFileCopier,
  Inventory,
  WriteComponentPayload,
  YAMLFileEntry,
  EvalError,
} from '../types.js';

export interface LocalImageManifest {
  count: number;
  mapping: Record<string, string>;
  resolvedNames: Record<string, string>;
}

const COMPONENT_FILE_EXTENSIONS = new Set(['.tsx', '.ts', '.css']);

export class WorkspaceFileSystem implements IFileReader, IFileWriter, IFileScanner, IExtendedReader, IFileCopier {
  readonly workspacePath: string;

  constructor(config: AgentConfig) {
    this.workspacePath = config.paths.workspacePath;
  }

  fileExists(relativePath: string): boolean {
    return existsSync(join(this.workspacePath, relativePath));
  }

  directoryExists(absolutePath: string): boolean {
    try {
      return statSync(absolutePath).isDirectory();
    } catch {
      return false;
    }
  }

  async readFile(relativePath: string): Promise<string> {
    const fullPath = join(this.workspacePath, relativePath);
    return readFile(fullPath, 'utf-8');
  }

  async readAbsoluteFile(absolutePath: string): Promise<string> {
    return readFile(absolutePath, 'utf-8');
  }

  async readDir(
    relativeDirPath: string,
    extension: string,
  ): Promise<Array<{ filename: string; content: string }>> {
    const dirPath = join(this.workspacePath, relativeDirPath);
    if (!existsSync(dirPath)) return [];

    const items = await readdir(dirPath);
    const results: Array<{ filename: string; content: string }> = [];
    for (const item of items) {
      if (!item.endsWith(extension)) continue;
      const content = await readFile(join(dirPath, item), 'utf-8');
      results.push({ filename: item, content });
    }
    return results;
  }

  async readYAML<T = Record<string, string>>(relativePath: string): Promise<T> {
    const fullPath = join(this.workspacePath, relativePath);
    const content = await readFile(fullPath, 'utf-8');
    return parseYAML(content) as T;
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.workspacePath, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  private buildComponentFileEntries(
    payload: WriteComponentPayload,
    componentDir: string,
  ): Array<{ absPath: string; relPath: string; content: string }> {
    const dir = join(this.workspacePath, componentDir);
    const entries: Array<{ absPath: string; relPath: string; content: string }> = [];
    entries.push({ absPath: join(dir, 'index.tsx'), relPath: join(componentDir, 'index.tsx'), content: payload.tsxContent });
    if (payload.cssContent) {
      const cssFile = `${payload.componentName}.module.css`;
      entries.push({ absPath: join(dir, cssFile), relPath: join(componentDir, cssFile), content: payload.cssContent });
    }
    if (payload.contentTsContent) {
      entries.push({ absPath: join(dir, 'content.ts'), relPath: join(componentDir, 'content.ts'), content: payload.contentTsContent });
    }
    return entries;
  }

  async writeComponentFiles(
    payload: WriteComponentPayload,
    componentDir: string,
  ): Promise<string[]> {
    const dir = join(this.workspacePath, componentDir);
    await mkdir(dir, { recursive: true });

    const entries = this.buildComponentFileEntries(payload, componentDir);
    for (const entry of entries) {
      await writeFile(entry.absPath, entry.content, 'utf-8');
    }
    return entries.map((e) => e.relPath);
  }

  async writePlan(planContent: string): Promise<string> {
    const planPath = join(this.workspacePath, '.figma', 'plan.md');
    const planDir = join(this.workspacePath, '.figma');
    await mkdir(planDir, { recursive: true });
    await writeFile(planPath, planContent, 'utf-8');
    return planPath;
  }

  async writeEvalLog(entry: EvalLogEntry, errors: EvalError[]): Promise<void> {
    const logDir = join(this.workspacePath, '.figma', 'logs');
    await mkdir(logDir, { recursive: true });

    const logData = {
      timestamp: new Date().toISOString(),
      componentName: entry.componentName,
      attempt: entry.attempt,
      yamlContent: entry.yamlContent,
      payload: entry.payload,
      evalErrors: errors,
    };

    const logPath = join(logDir, `${entry.componentName}-attempt-${entry.attempt}.json`);
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, JSON.stringify(logData, null, 2), 'utf-8');
  }

  private async walkYAMLDir(
    dir: string,
    callback: (fullPath: string, item: string, dir: string) => void,
  ): Promise<void> {
    const items = await readdir(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        await this.walkYAMLDir(fullPath, callback);
      } else {
        callback(fullPath, item, dir);
      }
    }
  }

  async listYAMLTree(): Promise<YAMLFileEntry[]> {
    const yamlRoot = join(this.workspacePath, '.figma', 'build');
    if (!existsSync(yamlRoot)) return [];
    const entries: YAMLFileEntry[] = [];

    await this.walkYAMLDir(yamlRoot, (fullPath, item, dir) => {
      if (item.endsWith('.yaml') || item.endsWith('.yml')) {
        entries.push({
          directory: relative(this.workspacePath, dir),
          filename: item,
          relativePath: relative(this.workspacePath, fullPath),
        });
      }
    });

    return entries;
  }

  private async walkInventoryDir(
    dir: string,
    inventories: Inventory[],
  ): Promise<void> {
    const items = await readdir(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) {
        await this.walkInventoryDir(fullPath, inventories);
      } else if (item === 'inventory.yaml') {
        const content = await readFile(fullPath, 'utf-8');
        inventories.push(parseYAML(content) as Inventory);
      }
    }
  }

  async readAllInventories(): Promise<Inventory[]> {
    const yamlRoot = join(this.workspacePath, '.figma', 'build');
    if (!existsSync(yamlRoot)) return [];
    const inventories: Inventory[] = [];
    await this.walkInventoryDir(yamlRoot, inventories);
    return inventories;
  }

  private async readComponentFiles(
    absDir: string,
  ): Promise<{ files: Map<string, string>; hasTsx: boolean }> {
    const files = new Map<string, string>();
    let hasTsx = false;

    const items = await readdir(absDir);
    for (const item of items) {
      const fullPath = join(absDir, item);
      const stats = await stat(fullPath);
      if (!stats.isFile()) continue;

      const ext = item.substring(item.lastIndexOf('.'));
      if (!COMPONENT_FILE_EXTENSIONS.has(ext)) continue;
      files.set(item, await readFile(fullPath, 'utf-8'));
      if (ext === '.tsx') hasTsx = true;
    }

    return { files, hasTsx };
  }

  private async registerComponentDir(
    dir: string,
    result: Map<string, ExistingComponent>,
  ): Promise<void> {
    const { files, hasTsx } = await this.readComponentFiles(dir);
    if (!hasTsx) return;
    const dirName = dir.substring(dir.lastIndexOf('/') + 1);
    const relDir = relative(this.workspacePath, dir);
    result.set(dirName, { name: dirName, directory: relDir, files });
  }

  private async walkComponentDirs(
    dir: string,
    result: Map<string, ExistingComponent>,
  ): Promise<void> {
    if (!existsSync(dir)) return;
    const items = await readdir(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const stats = await stat(fullPath);
      if (stats.isDirectory()) await this.walkComponentDirs(fullPath, result);
    }
    await this.registerComponentDir(dir, result);
  }

  async scanExistingComponents(): Promise<Map<string, ExistingComponent>> {
    const componentsRoot = join(this.workspacePath, 'app', 'components');
    const result = new Map<string, ExistingComponent>();
    await this.walkComponentDirs(componentsRoot, result);
    return result;
  }

  async scanSingleComponent(
    componentDir: string,
  ): Promise<ExistingComponent | undefined> {
    const absDir = join(this.workspacePath, componentDir);
    const { files, hasTsx } = await this.readComponentFiles(absDir);
    if (!hasTsx) return undefined;

    const dirName = componentDir.substring(componentDir.lastIndexOf('/') + 1);
    return { name: dirName, directory: componentDir, files };
  }

  async listDir(absolutePath: string): Promise<string[]> {
    if (!existsSync(absolutePath)) return [];
    return readdir(absolutePath);
  }

  listDirSync(absolutePath: string): string[] {
    if (!existsSync(absolutePath)) return [];
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  async scanLocalImages(): Promise<LocalImageManifest> {
    const imagesDir = join(this.workspacePath, '.figma', 'images');
    const mapping: Record<string, string> = {};

    if (!this.directoryExists(imagesDir)) {
      return { count: 0, mapping, resolvedNames: {} };
    }

    const items = await readdir(imagesDir, { recursive: true, withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) continue;
      const dotIndex = item.name.lastIndexOf('.');
      if (dotIndex <= 0) continue;

      const hash = item.name.slice(0, dotIndex);
      const itemDir = relative(imagesDir, item.parentPath);
      const relPath = itemDir
        ? `.figma/images/${itemDir}/${item.name}`
        : `.figma/images/${item.name}`;
      mapping[hash] = relPath;
    }

    return { count: Object.keys(mapping).length, mapping, resolvedNames: {} };
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    await fsCopyFile(sourcePath, destPath);
  }

  async ensureDir(absolutePath: string): Promise<void> {
    await mkdir(absolutePath, { recursive: true });
  }
}
