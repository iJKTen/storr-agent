import type {
  IFileReader,
  IFileWriter,
  AgentConfig,
  LLMClient,
  TerminalExecutor,
  WriteComponentPayload,
  UpdateFilePayload,
} from '../types.js';
import type { ConversationHistory } from '../llm/index.js';
import type { BootContext } from '../figma/context.js';
import { resolveYAMLPaths } from '../figma/context.js';
import { WRITE_COMPONENT_TOOL, UPDATE_FILE_TOOL } from '../llm/tools.js';
import { runEvals, runYAMLEvals, formatEvalErrors } from '../figma/evals.js';
import { log } from '../log.js';
import { extractErrorFilePaths, isComponentFile } from '../workspace/typecheck.js';

// ── Phase Dependencies ──

interface PhaseDeps {
  llm: LLMClient;
  history: ConversationHistory;
  terminal: TerminalExecutor;
  config: AgentConfig;
}

// ── Helpers ──

async function runCheck(
  terminal: TerminalExecutor,
  command: string,
): Promise<{ passed: boolean; errorOutput: string }> {
  const result = await terminal(command);
  if (result.exitCode === 0) return { passed: true, errorOutput: '' };

  const errorOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return { passed: false, errorOutput };
}

async function readErrorFiles(
  reader: IFileReader,
  errorOutput: string,
): Promise<string[]> {
  const filePaths = extractErrorFilePaths(errorOutput, reader.workspacePath);
  const fileContents: string[] = [];

  for (const filePath of filePaths) {
    if (!reader.fileExists(filePath)) continue;
    try {
      const content = await reader.readFile(filePath);
      const tool = isComponentFile(filePath) ? 'write_component' : 'update_file';
      fileContents.push(
        `## ${filePath} (fix with \`${tool}\`)`, '```tsx', content, '```',
      );
    } catch {
      log('final_audit', `Could not read error file: ${filePath}`);
    }
  }

  return fileContents;
}

function buildErrorSection(
  errorOutput: string,
  fileContents: string[],
  command: string,
): string[] {
  const parts = [
    `\`${command}\` failed with these errors:`, '', '```', errorOutput, '```', '',
  ];

  if (fileContents.length > 0) {
    parts.push('## Files With Errors', '', ...fileContents, '');
  }

  return parts;
}

function buildInstructionsSection(lastEvalErrors: string[]): string[] {
  const parts = [
    '## Instructions', '',
    'Fix each error by calling the appropriate tool:',
    '- For component files under `app/components/{Name}/`: call `write_component`.',
    '- For route/template files: call `update_file`.', '',
    'Preserve all existing exports. Only fix the errors shown above.',
  ];

  if (lastEvalErrors.length > 0) {
    parts.push(
      '', '## Previous Fix Rejected', '',
      'Your previous write_component call was rejected:',
      ...lastEvalErrors.map(e => `  - ${e}`), '',
      'Preserve original text content and CSS classNames.',
    );
  }

  return parts;
}

function buildFixPrompt(
  errorOutput: string,
  fileContents: string[],
  command: string,
  lastEvalErrors: string[],
): string {
  return [
    ...buildErrorSection(errorOutput, fileContents, command),
    ...buildInstructionsSection(lastEvalErrors),
  ].join('\n');
}

async function writeAuditLog(
  writer: IFileWriter,
  label: string,
  attempt: number,
  data: string,
): Promise<void> {
  const sanitized = label.replace(/[^a-zA-Z0-9-]/g, '_');
  try {
    await writer.writeFile(`.figma/logs/audit-${sanitized}-attempt-${attempt}.log`, data);
  } catch {
    // Best-effort logging
  }
}

// ── Tool Response Processing ──

async function validateComponentPayload(
  reader: IFileReader,
  payload: WriteComponentPayload,
  bootCtx: BootContext,
): Promise<import('../types.js').EvalError[]> {
  const evalResult = runEvals(payload);
  const yamlPaths = resolveYAMLPaths(payload.componentName, bootCtx.yaml.fileIndex);
  let yamlEvalResult: import('../types.js').EvalResult = { pass: true };

  if (yamlPaths && yamlPaths.length > 0) {
    try {
      const yamlContent = await reader.readFile(yamlPaths[0]);
      yamlEvalResult = runYAMLEvals(payload, yamlContent);
    } catch {
      log('final_audit', `Could not read YAML for eval: ${yamlPaths[0]}`);
    }
  }

  return [
    ...(!evalResult.pass ? evalResult.errors : []),
    ...(!yamlEvalResult.pass ? yamlEvalResult.errors : []),
  ];
}

interface AuditToolContext {
  history: ConversationHistory;
  toolCall: { id: string; arguments: string };
  bootCtx: BootContext;
}

async function processWriteComponent(
  reader: IFileReader,
  writer: IFileWriter,
  ctx: AuditToolContext,
): Promise<string[]> {
  let payload: WriteComponentPayload;
  try { payload = JSON.parse(ctx.toolCall.arguments) as WriteComponentPayload; } catch {
    ctx.history.addToolResult(ctx.toolCall.id, 'ERROR: Could not apply fix.');
    return [];
  }

  if (!payload.tsxContent || payload.tsxContent.trim().length === 0) {
    ctx.history.addToolResult(ctx.toolCall.id, 'ERROR: Cannot write empty tsxContent.');
    return [];
  }

  const allErrors = await validateComponentPayload(reader, payload, ctx.bootCtx);

  if (allErrors.length > 0) {
    ctx.history.addToolResult(ctx.toolCall.id, formatEvalErrors(allErrors));
    return allErrors.map(e => `[${e.rule}] ${e.message}`);
  }

  const componentDir = `app/components/${payload.componentName}`;
  await writer.writeComponentFiles(payload, componentDir);
  log('final_audit', `Fixed component: ${payload.componentName}`);
  ctx.history.addToolResult(ctx.toolCall.id, `Fixed ${payload.componentName}.`);
  return [];
}

const AUDIT_WRITABLE_PREFIXES = [
  'app/components/',
  'app/routes/',
];

function isAuditWritable(filePath: string): boolean {
  return AUDIT_WRITABLE_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

async function processUpdateFile(
  writer: IFileWriter,
  history: ConversationHistory,
  toolCall: { id: string; arguments: string },
): Promise<void> {
  let payload: UpdateFilePayload;
  try { payload = JSON.parse(toolCall.arguments) as UpdateFilePayload; } catch {
    history.addToolResult(toolCall.id, 'ERROR: Could not apply fix.');
    return;
  }

  if (!payload.content || payload.content.trim().length === 0) {
    history.addToolResult(toolCall.id, 'ERROR: Cannot write empty content.');
    return;
  }

  if (!isAuditWritable(payload.filePath)) {
    history.addToolResult(toolCall.id, `ERROR: Cannot modify ${payload.filePath} during audit. Only component and route files can be fixed.`);
    return;
  }

  await writer.writeFile(payload.filePath, payload.content);
  log('final_audit', `Fixed file: ${payload.filePath}`);
  history.addToolResult(toolCall.id, `Fixed ${payload.filePath}.`);
}

// ── Main Audit Step ──

async function processToolCallsSequentially(
  reader: IFileReader,
  writer: IFileWriter,
  toolCalls: import('../types.js').ToolCallRequest[],
  auditCtx: { history: ConversationHistory; bootCtx: BootContext },
): Promise<string[]> {
  let lastEvalErrors: string[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name === 'write_component') {
      const ctx: AuditToolContext = { history: auditCtx.history, toolCall, bootCtx: auditCtx.bootCtx };
      const errors = await processWriteComponent(reader, writer, ctx);
      if (errors.length > 0) lastEvalErrors = errors;
    } else if (toolCall.name === 'update_file') {
      await processUpdateFile(writer, auditCtx.history, toolCall);
    } else {
      auditCtx.history.addToolResult(toolCall.id, 'Acknowledged.');
    }
  }

  return lastEvalErrors;
}

async function callLLMForFix(
  deps: PhaseDeps,
  prompt: string,
): Promise<import('../types.js').ChatResponse> {
  deps.history.clear();
  deps.history.addUser(prompt);

  return deps.llm.chat(
    deps.history.getAllForLLM(),
    [WRITE_COMPONENT_TOOL, UPDATE_FILE_TOOL],
    'required',
  );
}

interface AuditStepInput {
  command: string;
  label: string;
  bootCtx: BootContext;
}

interface FailedCheckContext {
  errorOutput: string;
  lastEvalErrors: string[];
  command: string;
  bootCtx: BootContext;
}

async function handleFailedCheck(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  ctx: FailedCheckContext,
): Promise<string[]> {
  const fileContents = await readErrorFiles(reader, ctx.errorOutput);
  const prompt = buildFixPrompt(ctx.errorOutput, fileContents, ctx.command, ctx.lastEvalErrors);

  const response = await callLLMForFix(deps, prompt);
  deps.history.addAssistant(response.content, response.toolCalls);

  if (response.toolCalls.length === 0) {
    log('final_audit', 'LLM did not call any tools — retrying.');
    return [];
  }

  return processToolCallsSequentially(reader, writer, response.toolCalls, { history: deps.history, bootCtx: ctx.bootCtx });
}

async function auditStep(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: AuditStepInput,
): Promise<boolean> {
  log('final_audit', `Running ${input.label}...`);
  let lastEvalErrors: string[] = [];

  for (let attempt = 0; attempt < deps.config.retry.maxRetries; attempt++) {
    const { passed, errorOutput } = await runCheck(deps.terminal, input.command);
    if (passed) {
      log('final_audit', `${input.label} passed.`);
      return true;
    }

    log('final_audit', `${input.label} failed (attempt ${attempt + 1}/${deps.config.retry.maxRetries}).`);
    await writeAuditLog(writer, input.label, attempt + 1, errorOutput);
    lastEvalErrors = await handleFailedCheck(reader, writer, deps, {
      errorOutput, lastEvalErrors, command: input.command, bootCtx: input.bootCtx,
    });
  }

  log('final_audit', `${input.label} did not pass after ${deps.config.retry.maxRetries} retries.`);
  return false;
}

// Re-export from typecheck.ts for backward compatibility
export { extractErrorFilePaths, isComponentFile } from '../workspace/typecheck.js';

export async function finalAudit(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  ctx: BootContext,
): Promise<void> {
  const typecheckPassed = await auditStep(reader, writer, deps, {
    command: 'npm run typecheck', label: 'npm run typecheck', bootCtx: ctx,
  });
  await auditStep(reader, writer, deps, {
    command: 'npm run build', label: 'npm run build', bootCtx: ctx,
  });

  if (typecheckPassed) {
    log('final_audit', 'Audit complete.');
  }
}
