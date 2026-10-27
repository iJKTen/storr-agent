import type { TokenUsage } from '../types.js';

const MODEL_PRICING: Record<string, [number, number]> = {
  'gpt-4o':              [2.50,  10.00],
  'gpt-4o-mini':         [0.15,   0.60],
  'gpt-4.1':             [2.00,   8.00],
  'gpt-4.1-mini':        [0.40,   1.60],
  'gpt-4.1-nano':        [0.10,   0.40],
  'o3':                  [2.00,   8.00],
  'o3-mini':             [1.10,   4.40],
  'o4-mini':             [1.10,   4.40],
  'claude-sonnet-4-20250514':   [3.00,  15.00],
  'claude-sonnet-5':     [3.00,  15.00],
  'claude-opus-4-20250514':    [15.00,  75.00],
  'claude-opus-4-6':     [5.00,  25.00],
  'claude-opus-4-7':     [5.00,  25.00],
  'claude-opus-4-8':     [5.00,  25.00],
  'claude-opus-5':       [5.00,  25.00],
  'claude-haiku-3.5':    [0.80,   4.00],
};

export class TokenTracker {
  private totalInput = 0;
  private totalOutput = 0;
  private totalCacheRead = 0;
  private totalCacheCreation = 0;
  private callCount = 0;

  record(usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.totalInput += usage.inputTokens;
    this.totalOutput += usage.outputTokens;
    this.totalCacheRead += usage.cacheReadInputTokens ?? 0;
    this.totalCacheCreation += usage.cacheCreationInputTokens ?? 0;
    this.callCount++;
  }

  getStats(): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    llmCalls: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  } {
    return {
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      totalTokens: this.totalInput + this.totalOutput,
      llmCalls: this.callCount,
      cacheReadInputTokens: this.totalCacheRead,
      cacheCreationInputTokens: this.totalCacheCreation,
    };
  }

  estimateCost(model: string): number | undefined {
    let pricing = MODEL_PRICING[model];
    if (!pricing) {
      for (const [key, value] of Object.entries(MODEL_PRICING)) {
        if (model.startsWith(key)) {
          pricing = value;
          break;
        }
      }
    }
    if (!pricing) return undefined;

    const [inputRate, outputRate] = pricing;
    const nonCached = this.totalInput - this.totalCacheRead - this.totalCacheCreation;
    const inputCost = (nonCached / 1_000_000) * inputRate;
    const cacheReadCost = (this.totalCacheRead / 1_000_000) * inputRate * 0.1;
    const cacheWriteCost = (this.totalCacheCreation / 1_000_000) * inputRate * 1.25;
    const outputCost = (this.totalOutput / 1_000_000) * outputRate;
    return inputCost + cacheReadCost + cacheWriteCost + outputCost;
  }

  private formatInputDetail(stats: ReturnType<TokenTracker['getStats']>): string {
    let detail = `  Input tokens:    ${stats.inputTokens.toLocaleString()}`;
    const parts: string[] = [];
    if (stats.cacheReadInputTokens > 0) parts.push(`${stats.cacheReadInputTokens.toLocaleString()} cached`);
    if (stats.cacheCreationInputTokens > 0) parts.push(`${stats.cacheCreationInputTokens.toLocaleString()} cache writes`);
    if (parts.length > 0) detail += ` (${parts.join(', ')})`;
    return detail;
  }

  private formatCostLine(model: string): string {
    const cost = this.estimateCost(model);
    return cost !== undefined
      ? `  Estimated cost:  $${cost.toFixed(4)}`
      : `  Estimated cost:  unknown (no pricing for "${model}")`;
  }

  formatSummary(model: string): string {
    const stats = this.getStats();
    const lines = [
      '', '── Token Usage Summary ──', '',
      `  LLM calls:      ${stats.llmCalls}`,
      this.formatInputDetail(stats),
      `  Output tokens:   ${stats.outputTokens.toLocaleString()}`,
      `  Total tokens:    ${stats.totalTokens.toLocaleString()}`,
    ];
    if (stats.cacheReadInputTokens > 0 && stats.inputTokens > 0) {
      lines.push(`  Cache hit rate:  ${((stats.cacheReadInputTokens / stats.inputTokens) * 100).toFixed(1)}%`);
    }
    lines.push(this.formatCostLine(model), '');
    return lines.join('\n');
  }
}
