import type { IFileReader, IExtendedReader } from '../../types.js';
import type { FigmaNode } from '../../figma/figma-node.js';
import type { BootContext } from '../../figma/context.js';
import { buildSystemMessage, resolveYAMLPaths } from '../../figma/context.js';
import { filterUnusedVariants, downgradeOrphanedSvgNodes } from '../../figma/variant-filter.js';
import { parse } from 'yaml';
import { log } from '../../log.js';
import { resolveScaffoldDeps } from './prompt-builder.js';
import { extractBehavioralVariants, scanPageVariantUsage, buildVariantUsageSection } from './variant-usage.js';
import type { ExistingComponent } from '../../types.js';
import type { PhaseDeps, PreparedComponent } from './types.js';

const IMPLICIT_DEPS: Record<string, string[]> = {
  CartMain: ['MiniCart'],
};

function addImplicitDeps(
  scaffoldDeps: ExistingComponent[],
  currentName: string,
  existingComponents: Map<string, ExistingComponent>,
): void {
  const implicit = IMPLICIT_DEPS[currentName];
  if (!implicit) return;
  for (const depName of implicit) {
    if (scaffoldDeps.some((d) => d.name === depName)) continue;
    const comp = existingComponents.get(depName);
    if (comp) scaffoldDeps.push(comp);
  }
}

interface LoadedYAML {
  content: string;
  yamlPath: string;
}

async function loadComponentYAML(
  reader: IFileReader,
  name: string,
  fileIndex: Map<string, string[]>,
  componentName: string,
): Promise<LoadedYAML | null> {
  const yamlPaths = resolveYAMLPaths(name, fileIndex, componentName);
  if (!yamlPaths || yamlPaths.length === 0) {
    log('component_loop', `Skipping ${name} — no YAML data found.`);
    return null;
  }

  if (yamlPaths.length > 1) {
    log('component_loop', `Warning: Multiple YAML files for "${name}": ${yamlPaths.join(', ')}. Using first.`);
  }
  const yamlPath = yamlPaths[0];

  if (!reader.fileExists(yamlPath)) {
    log('component_loop', `Skipping ${name} — could not read ${yamlPath}.`);
    return null;
  }
  const content = await reader.readFile(yamlPath);
  return { content, yamlPath };
}

async function loadHookSources(
  reader: IFileReader,
  hookFiles: string[],
): Promise<Array<{ path: string; content: string }>> {
  const sources: Array<{ path: string; content: string }> = [];
  for (const hf of hookFiles) {
    if (reader.fileExists(hf)) {
      const content = await reader.readFile(hf);
      sources.push({ path: hf, content });
    }
  }
  return sources;
}

async function loadAndSetSystemMessage(
  deps: PhaseDeps,
  bootCtx: BootContext,
  name: string,
  yaml: string,
): Promise<string[]> {
  const { message: systemMsg, hookFiles } = await buildSystemMessage(
    deps.config, 'component_loop', bootCtx, { name, yamlContent: yaml },
  );
  deps.history.setSystemMessage(systemMsg);
  return hookFiles;
}

async function loadQueryFiles(
  extReader: IExtendedReader,
  yaml: string,
  hookSources: Array<{ path: string; content: string }>,
): Promise<void> {
  if (!/\{\{(product|collection|article)\./.test(yaml)) return;
  const queryFiles = await extReader.readDir('app/lib/queries', '.ts');
  for (const qf of queryFiles) {
    hookSources.push({
      path: `app/lib/queries/${qf.filename}`,
      content: qf.content,
    });
  }
}

export async function prepareComponent(
  reader: IFileReader,
  extReader: IExtendedReader,
  deps: PhaseDeps,
  bootCtx: BootContext,
  componentName: string,
): Promise<(PreparedComponent & { variantUsageSection: string[] }) | null> {
  const name = componentName.split('/').pop()!;
  const loaded = await loadComponentYAML(reader, name, bootCtx.yaml.fileIndex, componentName);
  if (!loaded) return null;

  const doc = parse(loaded.content) as { nodes?: FigmaNode[] } | null;
  const rawNodes = doc?.nodes ?? [];

  const scaffoldDeps = resolveScaffoldDeps(
    rawNodes, bootCtx.project.componentIdIndex, bootCtx.project.existingComponents, name,
  );
  addImplicitDeps(scaffoldDeps, name, bootCtx.project.existingComponents);

  const usedVariants = bootCtx.project.variantUsageMap.get(name);
  const filtered = usedVariants ? filterUnusedVariants(loaded.content, usedVariants) : loaded.content;
  const yaml = downgradeOrphanedSvgNodes(filtered);

  const hookFiles = await loadAndSetSystemMessage(deps, bootCtx, name, yaml);
  const hookSources = await loadHookSources(reader, hookFiles);
  await loadQueryFiles(extReader, yaml, hookSources);

  if (scaffoldDeps.length > 0) {
    log('component_loop', `Resolved scaffold deps for ${name}: ${scaffoldDeps.map((d) => d.name).join(', ')}`);
  }

  const behavioralVariants = extractBehavioralVariants(loaded.content);
  let variantUsageSection: string[] = [];
  if (behavioralVariants.length >= 2) {
    const usageEntries = await scanPageVariantUsage(reader, name, behavioralVariants, bootCtx.yaml.fileIndex);
    variantUsageSection = buildVariantUsageSection(behavioralVariants, usageEntries);
    if (variantUsageSection.length > 0) {
      log('component_loop', `Found ${behavioralVariants.length} behavioral variants for ${name}`);
    }
  }

  return { yaml, yamlPath: loaded.yamlPath, hookSources, scaffoldDeps, variantUsageSection };
}
