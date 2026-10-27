import type {
  EvalLogEntry,
  IFileReader,
  IFileWriter,
  TerminalExecutor,
  WriteComponentPayload,
} from '../../types.js';
import type { ConversationHistory } from '../../llm/index.js';
import type { RetryToolConfig } from '../../llm/retry.js';
import { WRITE_COMPONENT_TOOL } from '../../llm/tools.js';
import { runEvals, runYAMLEvals, formatEvalErrors } from '../../figma/evals.js';
import { log } from '../../log.js';
import { runTypecheck, filterTypecheckToScope, extractMissingModules, formatTypecheckErrors, logTypecheckErrors } from '../../workspace/typecheck.js';
import { retryWithToolCall } from '../../llm/retry.js';
import type { ComponentBuildInput, PhaseDeps } from './types.js';

interface EvalInput {
  yaml: string;
  attempt: number;
  name: string;
}

async function runEvalsOnPayload(
  writer: IFileWriter,
  payload: WriteComponentPayload,
  evalInput: EvalInput,
): Promise<{ passed: boolean; errors: Array<{ rule: string; message: string }> }> {
  const evalResult = runEvals(payload);
  const yamlEvalResult = runYAMLEvals(payload, evalInput.yaml);

  const allErrors = [
    ...(evalResult.pass ? [] : evalResult.errors),
    ...(yamlEvalResult.pass ? [] : yamlEvalResult.errors),
  ];

  const entry: EvalLogEntry = {
    componentName: evalInput.name,
    attempt: evalInput.attempt,
    yamlContent: evalInput.yaml,
    payload,
  };
  await writer.writeEvalLog(entry, allErrors);
  return { passed: allErrors.length === 0, errors: allErrors };
}

function checkTypecheckScope(
  tc: import('../../workspace/typecheck.js').TypecheckResult,
  componentName: string,
  scopeDir: string,
): { success: boolean; errorContext?: string } {
  const scoped = filterTypecheckToScope(tc, [scopeDir]);
  if (scoped.passed) return { success: true };
  log('component_loop', `Typecheck failed after writing ${componentName}.`);
  logTypecheckErrors('component_loop', scoped);
  return {
    success: false,
    errorContext: formatTypecheckErrors(scoped, 'write_component'),
  };
}

interface WriteAndCheckInput {
  payload: WriteComponentPayload;
  componentDir: string;
}

async function writeAndTypecheck(
  reader: IFileReader,
  writer: IFileWriter,
  terminal: TerminalExecutor,
  input: WriteAndCheckInput,
): Promise<{ success: boolean; errorContext?: string; written: string[] }> {
  const written = await writer.writeComponentFiles(input.payload, input.componentDir);
  log('component_loop', `Wrote ${input.payload.componentName}: ${written.join(', ')}`);

  const tc = await runTypecheck(reader, terminal);
  if (tc.passed) return { success: true, written };

  const scoped = filterTypecheckToScope(tc, [input.componentDir + '/']);
  if (scoped.passed) return { success: true, written };

  // Auto-install missing npm packages and retry typecheck once
  const missing = extractMissingModules(scoped);
  if (missing.length > 0) {
    for (const pkg of missing) {
      log('component_loop', `Auto-installing missing package: ${pkg}`);
      await terminal(`npm install ${pkg}`);
    }
    const tc2 = await runTypecheck(reader, terminal);
    if (tc2.passed) return { success: true, written };
    const scoped2 = filterTypecheckToScope(tc2, [input.componentDir + '/']);
    if (scoped2.passed) return { success: true, written };
    const result = checkTypecheckScope(tc2, input.payload.componentName, input.componentDir + '/');
    return { ...result, written };
  }

  const result = checkTypecheckScope(tc, input.payload.componentName, input.componentDir + '/');
  return { ...result, written };
}

function parseToolCallPayload(
  toolCallId: string,
  args: string,
  name: string,
  history: ConversationHistory,
): WriteComponentPayload | null {
  try {
    return JSON.parse(args) as WriteComponentPayload;
  } catch {
    log('component_loop', `Invalid JSON for ${name}. Retrying...`);
    history.addToolResult(toolCallId, 'ERROR: Invalid JSON in tool call arguments. Try again.');
    history.trimIfNeeded();
    return null;
  }
}

interface EvalWriteContext {
  input: ComponentBuildInput;
  toolCallId: string;
  payload: WriteComponentPayload;
  attempt: number;
}

async function handleEvalAndWrite(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  ctx: EvalWriteContext,
): Promise<string | null> {
  const evalInput: EvalInput = { yaml: ctx.input.yaml, attempt: ctx.attempt, name: ctx.input.name };
  const evalResult = await runEvalsOnPayload(writer, ctx.payload, evalInput);
  if (!evalResult.passed) {
    log('component_loop', `Eval failed for ${ctx.input.name} (attempt ${ctx.attempt}/${deps.config.retry.maxEvalRetries}): ${evalResult.errors.map((e) => e.rule).join(', ')}`);
    deps.history.addToolResult(ctx.toolCallId, formatEvalErrors(evalResult.errors));
    deps.history.trimIfNeeded();
    return null;
  }

  const componentDir = ctx.input.existing?.directory ?? `app/components/${ctx.payload.componentName}`;
  const tcResult = await writeAndTypecheck(reader, writer, deps.terminal, { payload: ctx.payload, componentDir });
  if (tcResult.success) {
    deps.history.addToolResult(ctx.toolCallId, `SUCCESS: Component "${ctx.payload.componentName}" written to ${componentDir}/. Files: ${tcResult.written.join(', ')}`);
    return componentDir;
  }

  deps.history.addToolResult(ctx.toolCallId, tcResult.errorContext!);
  deps.history.trimIfNeeded();
  return null;
}

export async function evalRetryLoop(
  reader: IFileReader,
  writer: IFileWriter,
  deps: PhaseDeps,
  input: ComponentBuildInput,
): Promise<string | null> {
  const retryConfig: RetryToolConfig = {
    tools: [WRITE_COMPONENT_TOOL],
    targetToolName: 'write_component',
    maxRetries: deps.config.retry.maxEvalRetries,
    noToolCallMessage: 'You MUST call the write_component tool. Do not output code as text. Call the tool now.',
  };

  let writtenDir: string | null = null;

  const success = await retryWithToolCall(
    deps.llm,
    deps.history,
    retryConfig,
    async ({ toolCall }, attempt) => {
      const payload = parseToolCallPayload(toolCall.id, toolCall.arguments, input.name, deps.history);
      if (!payload) return false;
      const ctx: EvalWriteContext = { input, toolCallId: toolCall.id, payload, attempt: attempt + 1 };
      const dir = await handleEvalAndWrite(reader, writer, deps, ctx);
      if (dir) {
        writtenDir = dir;
        return true;
      }
      return false;
    },
  );

  return success ? writtenDir : null;
}
