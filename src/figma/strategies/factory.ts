import type { FigmaNode } from '../figma-node.js';
import type { ComponentStrategy } from './types.js';
import { StandardComponentStrategy } from './standard.js';

export class ComponentStrategyFactory {
  private strategies: ComponentStrategy[] = [
    // Future: new LinkComponentStrategy(),
    // Future: new InputComponentStrategy(),
    new StandardComponentStrategy(), // Fallback — must be last
  ];

  getStrategy(componentName: string, nodes: FigmaNode[]): ComponentStrategy {
    return this.strategies.find(s => s.matches(componentName, nodes))
      ?? this.strategies[this.strategies.length - 1];
  }
}
