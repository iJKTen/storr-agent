// ── Component Prop Metadata ──
// Types and resolution logic for deterministic component instance prop-passing.

/** Figma-to-React prop mapping for a single property. */
export interface PropDefinition {
  figmaName: string;      // Original Figma property name: "Heading"
  propKey: string;         // camelCased React prop name: "heading"
  defaultValue: string;    // Default from component YAML: "20% off..."
}

/** Metadata saved per component for prop resolution and interface extraction. */
export interface ComponentPropMeta {
  category: string;
  props: PropDefinition[];
  interfaceText?: string;
}

export interface ResolvedInstanceProp {
  instanceName: string;
  componentName: string;
  props: Array<{ propKey: string; value: string }>;
}

/** Regex patterns for matching TypeScript props declarations. */
const INTERFACE_PATTERN = /^(export\s+)?interface\s+\w+Props\s*\{/m;
const TYPE_ALIAS_PATTERN = /^(export\s+)?type\s+\w+Props\s*=\s*\{/m;

/**
 * Finds the character index where a Props interface or type alias begins.
 * Returns undefined if no Props declaration exists in the source.
 */
function findPropsDeclarationStart(source: string): number | undefined {
  const interfaceMatch = INTERFACE_PATTERN.exec(source);
  const typeMatch = TYPE_ALIAS_PATTERN.exec(source);
  const match = interfaceMatch ?? typeMatch;
  if (match?.index === undefined) return undefined;
  return match.index;
}

/**
 * Extracts the closing brace position for a block starting at `start`.
 * Uses brace-depth counting to handle nested types like `{ nested: { a: string } }`.
 */
function findMatchingBraceEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Extracts all exported interface/type blocks that are NOT Props declarations.
 * These are custom types referenced by the Props interface (e.g. GalleryImage).
 * Matches `export interface X {` and `export type X = {` blocks.
 */
function extractExportedTypeBlocks(source: string): string[] {
  const blocks: string[] = [];
  const pattern = /^export\s+(?:interface|type)\s+(\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    // Skip Props declarations — already captured separately
    if (name.endsWith('Props')) continue;
    const blockStart = match.index;
    const braceIdx = source.indexOf('{', blockStart);
    if (braceIdx === -1) continue;
    const blockEnd = findMatchingBraceEnd(source, braceIdx);
    blocks.push(source.slice(blockStart, blockEnd).trim());
  }
  return blocks;
}

/**
 * Extracts the first `interface ...Props { }` or `type ...Props = { }` block
 * from component source code. Also includes any exported custom type blocks
 * (non-Props) so the integration phase can see referenced type definitions.
 * Returns the raw TypeScript text, or undefined if no Props declaration is found.
 */
export function extractPropsInterface(source: string): string | undefined {
  const start = findPropsDeclarationStart(source);
  if (start === undefined) return undefined;
  const end = findMatchingBraceEnd(source, start);
  const propsText = source.slice(start, end).trim();

  const exportedTypes = extractExportedTypeBlocks(source);
  if (exportedTypes.length === 0) return propsText;

  return [...exportedTypes, '', propsText].join('\n');
}

export function resolveInstanceProps(
  instanceProps: Record<string, Record<string, string>>,
  instanceNameMap: Map<string, string>,
  metaMap: Map<string, ComponentPropMeta>,
): ResolvedInstanceProp[] {
  const results: ResolvedInstanceProp[] = [];
  for (const [instanceName, props] of Object.entries(instanceProps)) {
    const componentName = instanceNameMap.get(instanceName) ?? instanceName;
    const meta = metaMap.get(componentName);
    if (!meta) continue;

    const matched: Array<{ propKey: string; value: string }> = [];
    for (const [figmaKey, value] of Object.entries(props)) {
      const def = meta.props.find(p => p.figmaName === figmaKey);
      if (def) matched.push({ propKey: def.propKey, value });
    }
    if (matched.length > 0) {
      results.push({ instanceName, componentName, props: matched });
    }
  }
  return results;
}
