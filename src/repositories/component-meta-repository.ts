import type { IFileReader, IFileWriter } from '../types.js';
import type { ComponentPropMeta } from '../figma/component-meta.js';

export interface ComponentMetaRepository {
  save(componentName: string, meta: ComponentPropMeta): Promise<void>;
  load(componentName: string): Promise<ComponentPropMeta | null>;
  loadAll(componentNames: string[]): Promise<Map<string, ComponentPropMeta>>;
}

export class FileSystemComponentMetaRepo implements ComponentMetaRepository {
  constructor(
    private reader: IFileReader,
    private writer: IFileWriter,
  ) {}

  private metaPath(name: string): string {
    return `app/components/${name}/props.meta.json`;
  }

  async save(componentName: string, meta: ComponentPropMeta): Promise<void> {
    await this.writer.writeFile(
      this.metaPath(componentName),
      JSON.stringify(meta, null, 2),
    );
  }

  async load(componentName: string): Promise<ComponentPropMeta | null> {
    const path = this.metaPath(componentName);
    if (!this.reader.fileExists(path)) return null;
    try {
      const raw = await this.reader.readFile(path);
      return JSON.parse(raw) as ComponentPropMeta;
    } catch { return null; }
  }

  async loadAll(names: string[]): Promise<Map<string, ComponentPropMeta>> {
    const map = new Map<string, ComponentPropMeta>();
    for (const name of names) {
      const meta = await this.load(name);
      if (meta) map.set(name, meta);
    }
    return map;
  }
}
