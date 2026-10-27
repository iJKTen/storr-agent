import type {
  ChatMessage,
  ChatResponse,
  LLMClient,
  LLMConfig,
  ToolDefinition,
  ToolChoiceOption,
  ToolCallRequest,
  TokenUsage,
} from '../../types.js';
import { toAnthropicTool } from '../tools.js';

interface AnthropicCacheUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type AnthropicMessageParam = import('@anthropic-ai/sdk').Anthropic.MessageParam;
type AnthropicToolResultBlockParam = import('@anthropic-ai/sdk').Anthropic.ToolResultBlockParam;
type AnthropicToolUseBlockParam = import('@anthropic-ai/sdk').Anthropic.ToolUseBlockParam;
type AnthropicTextBlockParam = import('@anthropic-ai/sdk').Anthropic.TextBlockParam;

function mapAnthropicAssistantWithTools(
  msg: ChatMessage,
): AnthropicMessageParam {
  const blocks: (AnthropicTextBlockParam | AnthropicToolUseBlockParam)[] = [];
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const tc of msg.toolCalls!) {
    blocks.push({
      type: 'tool_use', id: tc.id, name: tc.name,
      input: JSON.parse(tc.arguments) as Record<string, string>,
    });
  }
  return { role: 'assistant', content: blocks };
}

function appendToolResult(
  anthropicMessages: AnthropicMessageParam[],
  msg: ChatMessage,
): void {
  const toolResult: AnthropicToolResultBlockParam = {
    type: 'tool_result', tool_use_id: msg.toolCallId ?? '', content: msg.content,
  };
  const lastMsg = anthropicMessages[anthropicMessages.length - 1];
  const isToolResultGroup = lastMsg?.role === 'user' && Array.isArray(lastMsg.content)
    && (lastMsg.content as Array<{ type: string }>).length > 0
    && (lastMsg.content as Array<{ type: string }>)[0].type === 'tool_result';

  if (isToolResultGroup) {
    (lastMsg.content as AnthropicToolResultBlockParam[]).push(toolResult);
  } else {
    anthropicMessages.push({ role: 'user', content: [toolResult] });
  }
}

function mapToAnthropicMessages(
  messages: ChatMessage[],
): { systemContent: string; anthropicMessages: AnthropicMessageParam[] } {
  let systemContent = '';
  const anthropicMessages: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') { systemContent = msg.content; continue; }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      anthropicMessages.push(mapAnthropicAssistantWithTools(msg));
      continue;
    }
    if (msg.role === 'tool') { appendToolResult(anthropicMessages, msg); continue; }
    anthropicMessages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
  }

  return { systemContent, anthropicMessages };
}

function extractAnthropicContent(
  blocks: import('@anthropic-ai/sdk').Anthropic.ContentBlock[],
): { text: string; toolCalls: ToolCallRequest[] } {
  let text = '';
  const toolCalls: ToolCallRequest[] = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  return { text, toolCalls };
}

function mapAnthropicStopReason(reason: string | null): ChatResponse['stopReason'] {
  if (reason === 'end_turn') return 'stop';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'length';
  return 'unknown';
}

function extractAnthropicUsage(usage: AnthropicCacheUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function parseAnthropicResponse(
  response: import('@anthropic-ai/sdk').Anthropic.Message,
): ChatResponse {
  const { text, toolCalls } = extractAnthropicContent(response.content);
  return {
    content: text,
    toolCalls,
    stopReason: mapAnthropicStopReason(response.stop_reason),
    usage: extractAnthropicUsage(response.usage as AnthropicCacheUsage),
  };
}

type AnthropicMessageCreateParams = import('@anthropic-ai/sdk').Anthropic.MessageCreateParams;

function applyAnthropicSystem(
  params: AnthropicMessageCreateParams,
  systemContent: string,
  usePromptCache: boolean,
): void {
  if (!systemContent) return;
  params.system = usePromptCache
    ? [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }]
    : systemContent;
}

function applyAnthropicTools(
  params: AnthropicMessageCreateParams,
  tools: ToolDefinition[],
  toolChoice: ToolChoiceOption | undefined,
  usePromptCache: boolean,
): void {
  const anthropicTools = tools.map(toAnthropicTool);
  if (usePromptCache) {
    const last = anthropicTools[anthropicTools.length - 1];
    Object.assign(last, { cache_control: { type: 'ephemeral' } });
  }
  params.tools = anthropicTools;
  if (toolChoice === 'required') params.tool_choice = { type: 'any' };
  else if (toolChoice === 'auto') params.tool_choice = { type: 'auto' };
}

export async function createAnthropicClient(llmConfig: LLMConfig): Promise<LLMClient> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: llmConfig.apiKey });
  const useCache = process.env.ANTHROPIC_PROMPT_CACHE === '1' || process.env.ANTHROPIC_PROMPT_CACHE === 'true';

  return {
    async chat(messages, tools, toolChoice): Promise<ChatResponse> {
      const { systemContent, anthropicMessages } = mapToAnthropicMessages(messages);
      const params: AnthropicMessageCreateParams = {
        model: llmConfig.model, max_tokens: 32768, messages: anthropicMessages,
        thinking: { type: 'adaptive' },
      };
      applyAnthropicSystem(params, systemContent, useCache);
      if (tools?.length) applyAnthropicTools(params, tools, toolChoice, useCache);
      const stream = client.messages.stream(params);
      const response = await stream.finalMessage();
      return parseAnthropicResponse(response);
    },
  };
}
