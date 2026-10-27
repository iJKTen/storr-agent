import { resolve } from 'node:path';
import type { AgentConfig, LLMClient, LLMProvider } from '../types.js';
import { createOpenAIClient } from './providers/openai.js';
import { createAnthropicClient } from './providers/anthropic.js';
import { createDryRunClient } from './dry-run.js';
import { TokenTracker } from './tracker.js';

export { ConversationHistory } from './history.js';
export { TokenTracker } from './tracker.js';

export async function createLLMClient(config: AgentConfig): Promise<{ client: LLMClient; tracker: TokenTracker }> {
  const tracker = new TokenTracker();

  if (config.dryRun) {
    const outputDir = resolve(config.paths.workspacePath, '.figma/dry-run');
    return { client: createDryRunClient(outputDir), tracker };
  }

  const providerMap: Record<LLMProvider, () => Promise<LLMClient>> = {
    openai: () => createOpenAIClient(config.llm),
    ollama: () => createOpenAIClient(config.llm),
    anthropic: () => createAnthropicClient(config.llm),
  };

  const inner = await providerMap[config.llm.provider]();

  const client: LLMClient = {
    async chat(messages, tools, toolChoice) {
      const response = await inner.chat(messages, tools, toolChoice);
      tracker.record(response.usage);
      return response;
    },
  };

  return { client, tracker };
}
