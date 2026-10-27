import { mkdirSync, writeFileSync } from 'node:fs';
import type { ChatMessage, LLMClient, ToolDefinition } from '../types.js';
import { log } from '../log.js';

// ── Types ──

export interface DryRunContext {
  component?: string;
  targetFile?: string;
  yamlPath?: string;
}

export interface DryRunLLMClient extends LLMClient {
  setContext(ctx: DryRunContext): void;
}

interface DryRunDumpEntry {
  callIndex: number;
  label: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  context: DryRunContext;
}

// ── Error ──

export class DryRunError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`[DRY RUN] Prompt dumped to ${filePath}`);
    this.name = 'DryRunError';
    this.filePath = filePath;
  }
}

export function isDryRunError(err: Error | DryRunError): err is DryRunError {
  return err instanceof DryRunError;
}

export function isDryRunClient(client: LLMClient): client is DryRunLLMClient {
  return 'setContext' in client;
}

// ── Guard ──

export async function withDryRunGuard(
  fn: () => Promise<void>,
  phase: string,
  context: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && isDryRunError(err)) {
      log('boot', `[DRY RUN] ${phase}: ${context} → ${err.filePath}`);
      return;
    }
    throw err;
  }
}

// ── Label Inference ──

function inferLabel(tools: ToolDefinition[]): string {
  if (tools.length === 0) return 'prompt';
  const names = tools.map((t) => t.name);
  if (names.includes('plan')) return 'plan';
  if (names.includes('write_component')) return 'write_component';
  if (names.includes('update_file')) return 'update_file';
  return names[0];
}

// ── Formatting ──

function formatContextLines(ctx: DryRunContext): string[] {
  const lines: string[] = [];
  if (ctx.component) lines.push(`**Component:** ${ctx.component}`);
  if (ctx.targetFile) lines.push(`**Target:** ${ctx.targetFile}`);
  if (ctx.yamlPath) lines.push(`**YAML:** ${ctx.yamlPath}`);
  return lines;
}

function formatHeader(entry: DryRunDumpEntry): string {
  const lines = [
    `# Dry Run — Call ${entry.callIndex}`,
    '',
    `**Label:** ${entry.label}`,
    ...formatContextLines(entry.context),
    `**Messages:** ${entry.messages.length}`,
    `**Tools:** ${entry.tools.map((t) => t.name).join(', ') || '(none)'}`,
    '',
  ];
  return lines.join('\n');
}

function formatMessageSection(msg: ChatMessage): string {
  const lines = [
    `## ${msg.role.toUpperCase()} Message`,
    '',
    '```',
    msg.content,
    '```',
    '',
  ];
  return lines.join('\n');
}

function formatToolSection(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';
  const lines = [
    '## Tool Definitions',
    '',
    '```json',
    JSON.stringify(tools, null, 2),
    '```',
    '',
  ];
  return lines.join('\n');
}

function buildDumpContent(entry: DryRunDumpEntry): string {
  const parts = [formatHeader(entry)];
  for (const msg of entry.messages) {
    parts.push(formatMessageSection(msg));
  }
  parts.push(formatToolSection(entry.tools));
  return parts.join('\n');
}

// ── File Writing ──

function inferFilenameSuffix(ctx: DryRunContext): string {
  const name = ctx.component
    ?? ctx.targetFile?.split('/').pop()?.replace('.tsx', '');
  return name ? `-${name.replace(/\//g, '-')}` : '';
}

function writeDump(outputDir: string, entry: DryRunDumpEntry): string {
  mkdirSync(outputDir, { recursive: true });
  const padded = String(entry.callIndex).padStart(2, '0');
  const suffix = inferFilenameSuffix(entry.context);
  const filePath = `${outputDir}/${padded}-${entry.label}${suffix}.md`;
  writeFileSync(filePath, buildDumpContent(entry), 'utf-8');
  return filePath;
}

// ── Client Factory ──

export function createDryRunClient(outputDir: string): DryRunLLMClient {
  let callIndex = 0;
  let currentContext: DryRunContext = {};

  return {
    setContext(ctx: DryRunContext) {
      currentContext = ctx;
    },
    async chat(messages, tools, _toolChoice) {
      callIndex++;
      const label = inferLabel(tools ?? []);
      const entry: DryRunDumpEntry = {
        callIndex,
        label,
        messages,
        tools: tools ?? [],
        context: { ...currentContext },
      };
      const filePath = writeDump(outputDir, entry);
      throw new DryRunError(filePath);
    },
  };
}
