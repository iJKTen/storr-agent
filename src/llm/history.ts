import type { ChatMessage, ToolCallRequest } from '../types.js';

const MAX_HISTORY_MESSAGES = 20;

export class ConversationHistory {
  private messages: ChatMessage[] = [];
  private systemMessage: string;

  constructor(systemMessage: string) {
    this.systemMessage = systemMessage;
  }

  getSystemMessage(): string {
    return this.systemMessage;
  }

  setSystemMessage(msg: string): void {
    this.systemMessage = msg;
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  getAllForLLM(): ChatMessage[] {
    return [
      { role: 'system', content: this.systemMessage },
      ...this.messages,
    ];
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(content: string, toolCalls?: ToolCallRequest[]): void {
    this.messages.push({ role: 'assistant', content, toolCalls });
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', content, toolCallId });
  }

  trimIfNeeded(): boolean {
    if (this.messages.length <= MAX_HISTORY_MESSAGES) return false;

    const first = this.messages[0];
    let start = this.messages.length - 4;
    if (start < 1) start = 1;

    while (start > 1 && this.messages[start].role === 'tool') {
      start--;
    }

    this.messages = [first, ...this.messages.slice(start)];
    return true;
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }
}
