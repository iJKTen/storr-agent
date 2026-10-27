import type { LLMClient, ToolDefinition, ToolCallRequest } from '../types.js';
import type { ConversationHistory } from './index.js';

export interface RetryToolConfig {
  targetToolName: string;
  maxRetries: number;
  noToolCallMessage: string;
  tools: ToolDefinition[];
}

export interface ExtractedToolCall {
  toolCall: ToolCallRequest;
}

function handleNoTools(
  history: ConversationHistory,
  content: string,
  noToolCallMessage: string,
): void {
  history.addAssistant(content);
  history.addUser(noToolCallMessage);
}

function acknowledgeNonTarget(
  history: ConversationHistory,
  toolCalls: ToolCallRequest[],
  targetId: string | undefined,
): void {
  for (const tc of toolCalls) {
    if (tc.id !== targetId) {
      history.addToolResult(tc.id, 'Acknowledged.');
    }
  }
}

export async function retryWithToolCall(
  llm: LLMClient,
  history: ConversationHistory,
  config: RetryToolConfig,
  processCall: (extracted: ExtractedToolCall, attempt: number) => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    const response = await llm.chat(
      history.getAllForLLM(),
      config.tools,
      'required',
    );

    if (response.toolCalls.length === 0) {
      handleNoTools(history, response.content, config.noToolCallMessage);
      continue;
    }

    history.addAssistant(response.content, response.toolCalls);
    const targetCall = response.toolCalls.find((tc) => tc.name === config.targetToolName);
    acknowledgeNonTarget(history, response.toolCalls, targetCall?.id);

    if (!targetCall) continue;

    const success = await processCall({ toolCall: targetCall }, attempt);
    if (success) return true;
  }
  return false;
}
