import type { AgentConfig, AgentState, ExistingComponent, IFileReader, IExtendedReader, IFileScanner, Inventory, YAMLFileEntry } from "../types.js";
import type { LocalImageManifest } from "../workspace/WorkspaceFileSystem.js";
import type { FigmaDocument } from "./figma-node.js";
import { parseDataBindingField } from "./figma-node.js";
import { formatYAMLTree } from "../workspace/fileSystem.js";
import { assembleSystemMessage } from "./rules.js";
import {
  resolveImageNames,
  formatImageManifestForPrompt,
  scanSvgAssets,
  formatSvgManifestForPrompt,
} from "./images.js";
import { buildVariantUsageMap, type VariantUsageMap } from "./variant-filter.js";
import { log } from "../log.js";

// ── Decomposed BootContext sub-groups ──

export interface YAMLIndex {
  entries: YAMLFileEntry[];
  buildableEntries: YAMLFileEntry[];
  buildableDirs: Set<string>;
  fileIndex: Map<string, string[]>;
}

export interface AssetManifests {
  imageSection: string;
  svgSection: string;
  imageManifest: LocalImageManifest;
}

export interface ProjectContext {
  inventories: Inventory[];
  existingComponents: Map<string, ExistingComponent>;
  componentIdIndex: Map<string, string>;
  variantUsageMap: VariantUsageMap;
}

export interface PromptContext {
  agentsContent: string;
  workspaceRules: string;
}

export interface BootContext {
  yaml: YAMLIndex;
  assets: AssetManifests;
  project: ProjectContext;
  prompt: PromptContext;
}

/** Maps page frame names to their route files (matching routes.md conventions). */
export const ROUTE_MAP: Record<string, string> = {
  HomepageDesktop: "app/routes/_index.tsx",
  HomepageMobile: "app/routes/_index.tsx",
  CollectionDesktop: "app/routes/collections.$handle.tsx",
  CollectionMobile: "app/routes/collections.$handle.tsx",
  ProductDesktop: "app/routes/products.$handle.tsx",
  ProductMobile: "app/routes/products.$handle.tsx",
  PDPDesktop: "app/routes/products.$handle.tsx",
  PDPMobile: "app/routes/products.$handle.tsx",
  Cart: "app/routes/cart.tsx",
  CartDesktop: "app/routes/cart.tsx",
  CartMobile: "app/routes/cart.tsx",
};

/** Maps page frame names to their template component files (components that the route delegates rendering to). */
export const TEMPLATE_MAP: Record<string, string> = {
  PDPDesktop: 'app/components/ProductDetail/index.tsx',
  PDPMobile: 'app/components/ProductDetail/index.tsx',
  ProductDesktop: 'app/components/ProductDetail/index.tsx',
  ProductMobile: 'app/components/ProductDetail/index.tsx',
};

export function resolveTemplateFile(pageName: string): string | undefined {
  return TEMPLATE_MAP[pageName];
}

/**
 * Resolve a page name to its route file. Checks the exact ROUTE_MAP first,
 * then falls back to a case-insensitive keyword match for "collection".
 */
export function resolveRouteFile(pageName: string): string | undefined {
  if (pageName in ROUTE_MAP) return ROUTE_MAP[pageName];
  if (/collection/i.test(pageName)) return 'app/routes/collections.$handle.tsx';
  return undefined;
}

/**
 * Deduplicate the YAML slug lookup pattern used by componentLoop and integration.
 * Tries multiple casing/slug variants to find matching YAML file paths.
 */
export function resolveYAMLPaths(
  name: string,
  yamlFileIndex: Map<string, string[]>,
  fullName?: string,
): string[] | undefined {
  const nameLower = name.toLowerCase();
  const slug = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/\s+/g, "-")
    .toLowerCase();
  const fullSlug = fullName
    ? fullName.replace(/\//g, "-").toLowerCase()
    : nameLower;

  return (
    yamlFileIndex.get(nameLower) ??
    yamlFileIndex.get(slug) ??
    yamlFileIndex.get(fullSlug) ??
    yamlFileIndex.get(nameLower.replace(/[-_\s]/g, ""))
  );
}

/**
 * Resolve a Figma component name to an existing component.
 * Tries exact match first, then suffix match (e.g. "Price" matches "ProductPrice").
 * Shortest-name-wins when multiple suffix matches exist.
 */
export function resolveExistingComponent(
  name: string,
  existingComponents: Map<string, ExistingComponent>,
): ExistingComponent | undefined {
  const exact = existingComponents.get(name);
  if (exact) return exact;

  // Case-insensitive match (e.g. "footer" → "Footer")
  const nameLower = name.toLowerCase();
  for (const [key, comp] of existingComponents) {
    if (key.toLowerCase() === nameLower) return comp;
  }

  const suffixMatches: ExistingComponent[] = [];
  for (const [key, comp] of existingComponents) {
    if (key.endsWith(name) && key.length > name.length) {
      suffixMatches.push(comp);
    }
  }

  if (suffixMatches.length === 0) return undefined;
  return suffixMatches.reduce((shortest, c) =>
    c.name.length < shortest.name.length ? c : shortest,
  );
}

/**
 * Stem-match a data-binding name to an existing component.
 * e.g. {{product.swatches}} → extracts "swatches" → stems to "swatch" → matches "ColorSwatch".
 */
export function resolveDataBindingDep(
  name: string,
  existingComponents: Map<string, ExistingComponent>,
): ExistingComponent | undefined {
  const field = parseDataBindingField(name);
  if (!field) return undefined;
  const stem = field.replace(/(?:e?s)$/, '').toLowerCase();
  for (const [, comp] of existingComponents) {
    if (comp.name.toLowerCase().includes(stem)) return comp;
  }
  return undefined;
}

// ── Boot sub-steps ──

function buildYAMLFileIndex(entries: YAMLFileEntry[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const entry of entries) {
    const baseName = entry.filename.replace(/\.ya?ml$/, "").toLowerCase();
    const existing = index.get(baseName) ?? [];
    existing.push(entry.relativePath);
    index.set(baseName, existing);
  }
  return index;
}

function identifyBuildableDirs(inventories: Inventory[]): Set<string> {
  const dirs = new Set<string>();
  for (const inv of inventories) {
    if ("components" in inv) {
      dirs.add(inv.page.toLowerCase());
    } else if ("pages" in inv) {
      const hasRoutable = inv.pages.some((p) => resolveRouteFile(p.name) !== undefined);
      if (hasRoutable) dirs.add(inv.page.toLowerCase());
    }
  }
  return dirs;
}

function filterBuildableEntries(
  entries: YAMLFileEntry[],
  buildableDirs: Set<string>,
): YAMLFileEntry[] {
  return entries.filter((e) => {
    const segments = e.directory.split("/");
    return buildableDirs.has(segments[segments.length - 1]);
  });
}

async function loadPromptContext(
  reader: IFileReader,
  extReader: IExtendedReader,
): Promise<PromptContext> {
  let agentsContent = "";
  if (reader.fileExists("AGENTS.md")) {
    agentsContent = await reader.readFile("AGENTS.md");
    log("boot", "Loaded AGENTS.md.");
  }

  let workspaceRules = "";
  const mdcFiles = await extReader.readDir(".cursor/rules", ".mdc");
  if (mdcFiles.length > 0) {
    const ruleContents = mdcFiles
      .map((f) => f.content.replace(/^---[\s\S]*?---\s*/, "").trim())
      .filter(Boolean);
    workspaceRules = ruleContents.join("\n\n---\n\n");
    log("boot", `Loaded ${mdcFiles.length} workspace rule(s).`);
  }

  return { agentsContent, workspaceRules };
}

async function loadImageSection(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  imageManifest: LocalImageManifest,
  workspacePath: string,
): Promise<string> {
  if (imageManifest.count === 0) return "";

  log("boot", `Found ${imageManifest.count} downloaded Figma images.`);
  const resolvedNames = await resolveImageNames(extReader, scanner, imageManifest, workspacePath);
  imageManifest.resolvedNames = resolvedNames;
  if (Object.keys(resolvedNames).length > 0) {
    log("boot", `Resolved ${Object.keys(resolvedNames).length} image name(s).`);
  }
  return formatImageManifestForPrompt(imageManifest) ?? "";
}

async function loadSvgSection(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  workspacePath: string,
): Promise<string> {
  const svgManifest = await scanSvgAssets(extReader, scanner, workspacePath);
  if (svgManifest.count > 0) {
    log("boot", `Found ${svgManifest.count} SVG assets.`);
    return formatSvgManifestForPrompt(svgManifest);
  }
  return "";
}

async function loadAssetManifests(
  extReader: IExtendedReader,
  scanner: IFileScanner,
  imageManifest: LocalImageManifest,
  workspacePath: string,
): Promise<AssetManifests> {
  const imageSection = await loadImageSection(extReader, scanner, imageManifest, workspacePath);
  const svgSection = await loadSvgSection(extReader, scanner, workspacePath);
  return { imageSection, svgSection, imageManifest };
}

function indexNodeIds(
  nodes: FigmaDocument["nodes"],
  name: string,
  index: Map<string, string>,
): void {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.id) index.set(node.id, name);
    if (node.children) indexNodeIds(node.children, name, index);
  }
}

function indexSingleYAML(
  doc: FigmaDocument,
  index: Map<string, string>,
): void {
  if (!doc.metadata?.name || !doc.nodes) return;
  indexNodeIds(doc.nodes, doc.metadata.name, index);
}

async function buildComponentIdIndex(
  reader: IFileReader,
  buildableEntries: YAMLFileEntry[],
): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const componentEntries = buildableEntries.filter((e) => {
    const segments = e.directory.split("/");
    return segments[segments.length - 1] === "components";
  });

  for (const entry of componentEntries) {
    if (entry.filename === "inventory.yaml") continue;
    try {
      const doc = await reader.readYAML<FigmaDocument>(entry.relativePath);
      indexSingleYAML(doc, index);
    } catch {
      // Skip unparseable YAML
    }
  }

  if (index.size > 0) {
    log("boot", `Indexed ${index.size} component node IDs.`);
  }
  return index;
}

interface BootDeps {
  reader: IFileReader;
  extReader: IExtendedReader;
  scanner: IFileScanner;
}

function buildYAMLIndex(
  entries: YAMLFileEntry[],
  inventories: Inventory[],
): YAMLIndex {
  const fileIndex = buildYAMLFileIndex(entries);
  const buildableDirs = identifyBuildableDirs(inventories);
  const buildableEntries = filterBuildableEntries(entries, buildableDirs);
  return { entries, buildableEntries, buildableDirs, fileIndex };
}

export async function boot(
  deps: BootDeps,
  imageManifest: LocalImageManifest,
): Promise<BootContext> {
  log("boot", "Listing .figma/build/ tree...");
  const entries = await deps.scanner.listYAMLTree();
  log("boot", `Found ${entries.length} YAML files.`);

  const inventories = await deps.scanner.readAllInventories();
  const yaml = buildYAMLIndex(entries, inventories);
  log("boot", `Buildable directories: ${[...yaml.buildableDirs].join(", ")}`);

  const promptCtx = await loadPromptContext(deps.reader, deps.extReader);
  const assets = await loadAssetManifests(
    deps.extReader, deps.scanner, imageManifest, deps.reader.workspacePath,
  );
  const existingComponents = await deps.scanner.scanExistingComponents();

  if (existingComponents.size > 0) {
    log("boot", `Found ${existingComponents.size} existing scaffold component(s): ${[...existingComponents.keys()].join(", ")}`);
  }

  const componentIdIndex = await buildComponentIdIndex(deps.reader, yaml.buildableEntries);
  const variantUsageMap = await buildVariantUsageMap(deps.reader, yaml.buildableEntries);

  return {
    yaml,
    assets,
    project: { inventories, existingComponents, componentIdIndex, variantUsageMap },
    prompt: promptCtx,
  };
}

export interface SystemMessageResult {
  message: string;
  hookFiles: string[];
}

function getToolGuidance(phase: AgentState): string {
  if (phase === "final_audit") {
    return "You are an automated coding agent. To fix component files under app/components/{Name}/, call `write_component`. To fix route files or layout files, call `update_file` with the workspace-relative path and complete file content. Do not output code in markdown blocks — use the appropriate tool.";
  }
  if (phase === "integration") {
    return "You are an automated coding agent. Use the `update_file` tool to modify existing files. Do not output code in markdown blocks — use the tool.";
  }
  return "You are an automated coding agent. When instructed to build a component, you MUST call the `write_component` tool with the complete file contents. Do not output code in markdown blocks — use the tool.";
}

interface ComponentContext {
  name: string;
  yamlContent: string;
}

function buildOperatingContext(
  config: AgentConfig,
  phase: AgentState,
): string[] {
  return [
    "", "# Operating Context", "",
    `- Workspace: ${config.paths.workspacePath}`,
    `- Provider: ${config.llm.provider}`,
    `- Model: ${config.llm.model}`,
    "", getToolGuidance(phase),
  ];
}

function appendContextSections(
  parts: string[],
  ctx: BootContext,
  config: AgentConfig,
  phase: AgentState,
): void {
  if (ctx.prompt.agentsContent) {
    parts.push("", "# Agent Instructions", "", ctx.prompt.agentsContent);
  }
  if (ctx.prompt.workspaceRules) {
    parts.push("", "# Workspace Rules", "", ctx.prompt.workspaceRules);
  }

  parts.push(
    "", "# Available YAML Design Data", "",
    "```", formatYAMLTree(ctx.yaml.buildableEntries), "```",
  );

  if (ctx.assets.imageSection) parts.push("", ctx.assets.imageSection);
  if (ctx.assets.svgSection) parts.push("", ctx.assets.svgSection);

  parts.push(...buildOperatingContext(config, phase));
}

/**
 * Build a full system message for a given phase by assembling rule modules
 * and appending shared context.
 */
export async function buildSystemMessage(
  config: AgentConfig,
  phase: AgentState,
  ctx: BootContext,
  componentCtx?: ComponentContext,
): Promise<SystemMessageResult> {
  const assembled = await assembleSystemMessage(
    config,
    phase,
    componentCtx?.name,
    componentCtx?.yamlContent,
  );

  const parts = ["# System Prompt", "", assembled.content];
  appendContextSections(parts, ctx, config, phase);

  const msg = parts.join("\n");
  log(phase, `System message assembled (${msg.length} chars).`);
  return { message: msg, hookFiles: assembled.hookFiles };
}
