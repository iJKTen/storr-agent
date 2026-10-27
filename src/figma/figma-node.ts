// ── Shared Figma YAML Node Types ──
// Canonical types for walking parsed YAML node trees.
// Replaces all scattered `unknown`-based YAML node types.

export interface FigmaNodeCSS {
  className?: string;
  base?: string;
}

export interface FigmaNode {
  name?: string;
  type?: string;
  id?: string;
  text?: string;
  children?: FigmaNode[];
  componentId?: string;
  fills?: string;
  imageRef?: string;
  assetPath?: string;
  generatedCSS?: FigmaNodeCSS;
  componentPropertyReferences?: Record<string, string>;
  dataBindings?: string[];
  componentProperties?: Record<string, string>;
}

export function isDataBindingNode(node: FigmaNode): boolean {
  return typeof node.name === 'string' && node.name.startsWith('{{');
}

export function parseDataBindingField(name: string): string | null {
  const m = name.match(/^\{\{(?:product|collection|article)\.(\w+)\}\}$/);
  return m ? m[1] : null;
}

export interface FigmaComponentMeta {
  id?: string;
  name?: string;
  componentSetId?: string;
}

export interface FigmaMetadata {
  name?: string;
  components?: Record<string, FigmaComponentMeta>;
}

export interface FigmaDocument {
  metadata?: FigmaMetadata;
  nodes?: FigmaNode[];
}
