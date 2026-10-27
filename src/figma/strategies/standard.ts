import type { FigmaNode } from '../figma-node.js';
import { isDataBindingNode } from '../figma-node.js';
import type { PropDefinition } from '../component-meta.js';
import type { ComponentStrategy } from './types.js';

function hasTextPropertyRef(node: FigmaNode): boolean {
  return !!(node.componentPropertyReferences && 'text' in node.componentPropertyReferences);
}

function toCamelCase(figmaName: string): string {
  return figmaName.charAt(0).toLowerCase() + figmaName.slice(1).replace(/\s+/g, '');
}

function collectPropDefs(node: FigmaNode, out: PropDefinition[]): void {
  if (isDataBindingNode(node)) return;
  if (node.type === 'INSTANCE') return;
  if (node.type === 'TEXT' && typeof node.text === 'string' && node.text.length > 2) {
    if (hasTextPropertyRef(node)) {
      const figmaName = node.componentPropertyReferences!.text;
      out.push({
        figmaName,
        propKey: toCamelCase(figmaName),
        defaultValue: node.text,
      });
    }
  }
  if (node.children) {
    for (const child of node.children) collectPropDefs(child, out);
  }
}

export class StandardComponentStrategy implements ComponentStrategy {
  readonly category = 'standard';

  matches(_componentName: string, _nodes: FigmaNode[]): boolean {
    return true; // Fallback — always matches
  }

  extractProps(nodes: FigmaNode[]): PropDefinition[] {
    const props: PropDefinition[] = [];
    for (const node of nodes) collectPropDefs(node, props);
    return props;
  }
}
