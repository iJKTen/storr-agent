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
import { toOpenAITool } from '../tools.js';

type ChatCompletionMessageParam =
  import('openai').OpenAI.Chat.Completions.ChatCompletionMessageParam;

function mapOpenAIAssistantWithTools(msg: ChatMessage): ChatCompletionMessageParam {
  return {
    role: 'assistant' as const,
    content: msg.content || null,
    tool_calls: msg.toolCalls!.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    })),
  };
}

function mapSingleOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  if (msg.role === 'assistant' && msg.toolCalls?.length) return mapOpenAIAssistantWithTools(msg);
  if (msg.role === 'tool') return { role: 'tool' as const, content: msg.content, tool_call_id: msg.toolCallId ?? '' };
  if (msg.role === 'system') return { role: 'system' as const, content: msg.content };
  return { role: msg.role as 'user' | 'assistant', content: msg.content };
}

function mapToOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map(mapSingleOpenAIMessage);
}

function extractOpenAIToolCalls(
  raw: import('openai').OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): ToolCallRequest[] {
  if (!raw) return [];
  return raw.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
}

function mapOpenAIStopReason(reason: string | null): ChatResponse['stopReason'] {
  if (reason === 'stop') return 'stop';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'length';
  return 'unknown';
}

function parseOpenAIResponse(
  choice: import('openai').OpenAI.Chat.Completions.ChatCompletion.Choice,
  usage: import('openai').OpenAI.Completions.CompletionUsage | undefined,
): ChatResponse {
  const tokenUsage: TokenUsage | undefined = usage
    ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
    : undefined;

  return {
    content: choice.message.content ?? '',
    toolCalls: extractOpenAIToolCalls(choice.message.tool_calls),
    stopReason: mapOpenAIStopReason(choice.finish_reason),
    usage: tokenUsage,
  };
}

function buildOpenAIParams(
  llmConfig: LLMConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  toolChoice: ToolChoiceOption | undefined,
): import('openai').OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  type ChatCompletionToolChoiceOption =
    import('openai').OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;

  const params: import('openai').OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    messages: mapToOpenAIMessages(messages),
  };

  if (tools?.length) {
    params.tools = tools.map(toOpenAITool);
    if (toolChoice) params.tool_choice = toolChoice as ChatCompletionToolChoiceOption;
  }
  return params;
}

export async function createOpenAIClient(llmConfig: LLMConfig): Promise<LLMClient> {
  const OpenAI = (await import('openai')).default;
  const timeout = llmConfig.provider === 'ollama' ? 30 * 60 * 1000 : 10 * 60 * 1000;
  const client = new OpenAI({ apiKey: llmConfig.apiKey, baseURL: llmConfig.baseURL, timeout });

  return {
    async chat(messages, tools, toolChoice): Promise<ChatResponse> {
      const params = buildOpenAIParams(llmConfig, messages, tools, toolChoice);
      const response = await client.chat.completions.create(params);
      return parseOpenAIResponse(response.choices[0], response.usage ?? undefined);
    },
  };
}
