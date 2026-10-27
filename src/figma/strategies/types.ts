import type { FigmaNode } from '../figma-node.js';
import type { PropDefinition } from '../component-meta.js';

export interface ComponentStrategy {
  readonly category: string;
  matches(componentName: string, nodes: FigmaNode[]): boolean;
  extractProps(nodes: FigmaNode[]): PropDefinition[];
}
