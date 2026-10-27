import { parse } from 'yaml';
import type { PropTextEntry, SemanticElement, SvgNodeEntry, YAMLDesignData } from '../types.js';
import { isDataBindingNode, type FigmaNode } from './figma-node.js';

function hasTextPropertyRef(node: FigmaNode): boolean {
  return !!(node.componentPropertyReferences && 'text' in node.componentPropertyReferences);
}

function collectTexts(node: FigmaNode, out: string[]): void {
  if (isDataBindingNode(node)) return;
  if (node.type === 'INSTANCE') return;
  if (node.type === 'TEXT' && typeof node.text === 'string' && node.text.length > 2) {
    if (!hasTextPropertyRef(node)) {
      out.push(node.text);
    }
  }
  if (node.children) {
    for (const child of node.children) collectTexts(child, out);
  }
}

function collectTextsFromArray(nodes: FigmaNode[], out: string[]): void {
  for (const node of nodes) collectTexts(node, out);
}

function collectPropTexts(node: FigmaNode, out: PropTextEntry[]): void {
  if (isDataBindingNode(node)) return;
  if (node.type === 'INSTANCE') return;
  if (node.type === 'TEXT' && typeof node.text === 'string' && node.text.length > 2) {
    if (hasTextPropertyRef(node)) {
      out.push({
        text: node.text,
        propName: node.componentPropertyReferences!.text,
      });
    }
  }
  if (node.children) {
    for (const child of node.children) collectPropTexts(child, out);
  }
}

function collectPropTextsFromArray(nodes: FigmaNode[], out: PropTextEntry[]): void {
  for (const node of nodes) collectPropTexts(node, out);
}

function collectSvgNodes(node: FigmaNode, out: SvgNodeEntry[]): void {
  if (isDataBindingNode(node)) return;
  if (node.type === 'IMAGE-SVG' && typeof node.name === 'string' && typeof node.assetPath === 'string') {
    out.push({ name: node.name, assetPath: node.assetPath });
  }
  if (node.children) {
    for (const child of node.children) collectSvgNodes(child, out);
  }
}

function collectSvgFromArray(nodes: FigmaNode[], out: SvgNodeEntry[]): void {
  for (const node of nodes) collectSvgNodes(node, out);
}

const CSS_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

function isValidCSSClassName(value: string | number | boolean | null | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && CSS_IDENT_RE.test(value);
}

function collectClassNames(node: FigmaNode, out: string[]): void {
  if (isDataBindingNode(node)) return;
  if (node.type === 'INSTANCE') return;
  const className = node.generatedCSS?.className;
  if (isValidCSSClassName(className)) {
    out.push(className);
  }
  if (node.children) {
    for (const child of node.children) collectClassNames(child, out);
  }
}

function collectClassNamesFromArray(nodes: FigmaNode[], out: string[]): void {
  for (const node of nodes) collectClassNames(node, out);
}

const EMPTY: YAMLDesignData = { texts: [], propTexts: [], svgNodes: [], classNames: [] };

function deduplicateSvgNodes(entries: SvgNodeEntry[]): SvgNodeEntry[] {
  const seen = new Set<string>();
  const result: SvgNodeEntry[] = [];
  for (const entry of entries) {
    const key = entry.assetPath
      ? entry.assetPath.split('/').pop()!
      : entry.name.toLowerCase().replace(/[\s_]+/g, '-') + '.svg';
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

export function parseYAMLDesignData(yamlContent: string): YAMLDesignData {
  try {
    const doc = parse(yamlContent) as { nodes?: FigmaNode[] } | null;
    if (!doc || typeof doc !== 'object') return EMPTY;

    const nodes = doc.nodes;
    if (!Array.isArray(nodes)) return EMPTY;

    const texts: string[] = [];
    collectTextsFromArray(nodes, texts);

    const propTexts: PropTextEntry[] = [];
    collectPropTextsFromArray(nodes, propTexts);

    const rawSvgNodes: SvgNodeEntry[] = [];
    collectSvgFromArray(nodes, rawSvgNodes);
    const svgNodes = deduplicateSvgNodes(rawSvgNodes);

    const rawClassNames: string[] = [];
    collectClassNamesFromArray(nodes, rawClassNames);
    const classNames = [...new Set(rawClassNames)];

    return { texts, propTexts, svgNodes, classNames };
  } catch {
    return EMPTY;
  }
}

// ── Semantic HTML Element Extraction ──

const SEMANTIC_ELEMENTS = new Set([
  'section', 'nav', 'header', 'footer', 'main', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote',
  'ul', 'ol', 'li',
  'figure', 'figcaption', 'form', 'fieldset',
  'details', 'summary', 'address',
  'input', 'button', 'textarea', 'select', 'label',
]);

const ELEMENT_DEFAULT_TYPE: Record<string, string> = {
  input: 'text',
};

export function parseSemanticTag(name: string): SemanticElement | null {
  const dot = name.indexOf('.');
  const element = dot === -1 ? name : name.slice(0, dot);
  if (!SEMANTIC_ELEMENTS.has(element)) return null;
  const type = dot === -1 ? ELEMENT_DEFAULT_TYPE[element] : name.slice(dot + 1);
  return { element, ...(type ? { type } : {}) };
}

function collectSemanticNodes(
  node: FigmaNode,
  out: SemanticElement[],
): void {
  if (typeof node.name === 'string') {
    const tag = parseSemanticTag(node.name);
    if (tag) {
      out.push({ ...tag, className: node.generatedCSS?.className });
    }
  }
  if (node.children) {
    for (const child of node.children) collectSemanticNodes(child, out);
  }
}

export function extractSemanticElements(yamlContent: string): SemanticElement[] {
  try {
    const doc = parse(yamlContent) as { nodes?: FigmaNode[] } | null;
    if (!doc?.nodes || !Array.isArray(doc.nodes)) return [];
    const result: SemanticElement[] = [];
    for (const node of doc.nodes) collectSemanticNodes(node, result);
    return result;
  } catch { return []; }
}

// ── Wrapper Hierarchy Hints ──

export interface WrapperHint {
  element: string;
  className: string;
  children: string[];
}

function isInstanceChild(child: FigmaNode): boolean {
  return child.type === 'INSTANCE' && typeof child.name === 'string';
}

export function collectWrapperHints(
  mainChildren: FigmaNode[],
): WrapperHint[] {
  const hints: WrapperHint[] = [];
  for (const child of mainChildren) {
    const tag = typeof child.name === 'string' ? parseSemanticTag(child.name) : null;
    if (!tag || child.type !== 'FRAME' || !child.children) continue;
    const instances = child.children.filter(isInstanceChild);
    if (instances.length === 0) continue;
    const className = child.generatedCSS?.className ?? child.name!;
    hints.push({
      element: tag.element,
      className,
      children: instances.map((c) => c.name!),
    });
  }
  return hints;
}

export function mergeWrapperHints(
  mobileHints: WrapperHint[],
  desktopHints: WrapperHint[],
): WrapperHint[] {
  const merged = new Map<string, WrapperHint>();
  for (const hint of [...mobileHints, ...desktopHints]) {
    const key = `${hint.element}:${hint.children.join(',')}`;
    const existing = merged.get(key);
    if (existing) {
      const union = new Set([...existing.children, ...hint.children]);
      existing.children = [...union];
    } else {
      merged.set(key, { ...hint, children: [...hint.children] });
    }
  }
  return [...merged.values()];
}
