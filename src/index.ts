import "dotenv/config";
import { resolve } from "node:path";
import { loadConfig } from "./workspace/config.js";
import { createTerminal } from "./workspace/terminal.js";
import { createLLMClient, ConversationHistory } from "./llm/index.js";
import { WorkspaceFileSystem } from "./workspace/WorkspaceFileSystem.js";
import { log } from "./log.js";
import { boot, buildSystemMessage } from "./figma/context.js";
import { foundation } from "./phases/foundation.js";
import { plan, planEval } from "./phases/plan.js";
import { componentLoop } from "./phases/component-loop/index.js";
import { integration } from "./phases/integration/index.js";
import { finalAudit } from "./phases/audit.js";
import { isDryRunError } from "./llm/dry-run.js";
import type { AgentConfig, LLMClient } from "./types.js";
import type { BootContext } from "./figma/context.js";

// ── Phase Dependencies ──

interface PhaseDeps {
  llm: LLMClient;
  history: ConversationHistory;
  terminal: ReturnType<typeof createTerminal>;
  config: AgentConfig;
}

// ── Error Handling ──

function formatFatalError(err: Error): { message: string; stack: string } {
  return { message: err.message, stack: err.stack ?? '' };
}

// ── Plan Phase ──

async function attemptPlanGeneration(
  deps: PhaseDeps,
  ctx: BootContext,
): Promise<string | null> {
  try {
    return await plan(deps.llm, deps.history, ctx);
  } catch (err) {
    if (err instanceof Error && isDryRunError(err)) {
      log("plan", `[DRY RUN] Plan prompt dumped to ${err.filePath}`);
      return null;
    }
    throw err;
  }
}

function handlePlanRejection(
  deps: PhaseDeps,
  attempt: number,
  maxRetries: number,
): void {
  log("plan_eval", `Plan rejected (attempt ${attempt}/${maxRetries}).`);
  deps.history.addUser(
    'Your plan is missing the "Unmapped Files: None" confirmation. Revise the plan.',
  );
}

async function validateAndSavePlan(
  planContent: string,
  planValid: boolean,
  writer: WorkspaceFileSystem,
): Promise<string> {
  if (!planValid) {
    log("plan_eval", "Plan did not pass. Proceeding with best effort.");
  } else {
    log("plan_eval", "Plan validated.");
  }
  const planPath = await writer.writePlan(planContent);
  log("plan_eval", `Plan written to ${planPath}`);
  return planContent;
}

async function runPlanPhase(
  deps: PhaseDeps,
  reader: WorkspaceFileSystem,
  ctx: BootContext,
): Promise<string> {
  let planContent = "";
  let planValid = false;
  let planAttempts = 0;

  while (!planValid && planAttempts < deps.config.retry.maxRetries) {
    const result = await attemptPlanGeneration(deps, ctx);
    if (result === null) return "[DRY RUN]";
    planContent = result;
    planValid = planEval(planContent);

    if (!planValid) {
      planAttempts++;
      handlePlanRejection(deps, planAttempts, deps.config.retry.maxRetries);
    }
  }

  return validateAndSavePlan(planContent, planValid, reader);
}

// ── Phase Runners ──

async function runComponentPhase(
  deps: PhaseDeps,
  fs: WorkspaceFileSystem,
  planContent: string,
  ctx: BootContext,
): Promise<void> {
  log("component_loop", "Starting component loop...");
  await componentLoop(fs, fs, deps, {
    planContent,
    bootCtx: ctx,
    scanner: fs,
    extReader: fs,
  });
}

async function runIntegrationPhase(
  deps: PhaseDeps,
  fs: WorkspaceFileSystem,
  ctx: BootContext,
): Promise<void> {
  log("integration", "Starting integration phase...");
  await integration(fs, fs, deps, ctx);
}

async function runAuditPhase(
  deps: PhaseDeps,
  fs: WorkspaceFileSystem,
  ctx: BootContext,
): Promise<void> {
  log("final_audit", "Starting final audit...");
  const { message: auditMsg } = await buildSystemMessage(deps.config, "final_audit", ctx);
  deps.history.setSystemMessage(auditMsg);
  await finalAudit(fs, fs, deps, ctx);
}

// ── Services Initialization ──

import { TokenTracker } from "./llm/index.js";

interface Services {
  config: AgentConfig;
  fs: WorkspaceFileSystem;
  deps: PhaseDeps;
  tokenTracker: TokenTracker;
}

async function initializeServices(): Promise<Services> {
  const config = loadConfig();

  if (config.dryRun) {
    log("boot", "DRY RUN mode — prompts will be dumped, no LLM calls will be made.");
  }
  log("boot", `Starting storr-agent provider=${config.llm.provider} model=${config.llm.model}`);
  log("boot", `Workspace: ${config.paths.workspacePath}`);
  log("boot", `Rules: ${config.paths.rulesPath}`);

  const fs = new WorkspaceFileSystem(config);

  log("boot", "Initializing LLM client...");
  const { client: llm, tracker: tokenTracker } = await createLLMClient(config);
  log("boot", "LLM client ready.");

  const terminal = createTerminal(config);
  const history = new ConversationHistory("");

  const deps: PhaseDeps = { llm, history, terminal, config };

  return { config, fs, deps, tokenTracker };
}

// ── Main ──

async function runPhases(
  deps: PhaseDeps,
  fs: WorkspaceFileSystem,
  ctx: BootContext,
): Promise<void> {
  const { message: planMsg } = await buildSystemMessage(deps.config, "plan", ctx);
  deps.history.setSystemMessage(planMsg);

  const planContent = await runPlanPhase(deps, fs, ctx);
  await runComponentPhase(deps, fs, planContent, ctx);
  await runIntegrationPhase(deps, fs, ctx);

  if (!deps.config.dryRun) {
    await runAuditPhase(deps, fs, ctx);
  }
}

async function run(): Promise<void> {
  const { config, fs, deps, tokenTracker } = await initializeServices();

  const imageManifest = await fs.scanLocalImages();
  const ctx = await boot(
    { reader: fs, extReader: fs, scanner: fs },
    imageManifest,
  );

  log("foundation", "Starting foundation phase...");
  await foundation({
    reader: fs, writer: fs, copier: fs, listDirSync: (p) => fs.listDirSync(p),
  }, ctx);

  log("plan", "Starting plan phase...");
  await runPhases(deps, fs, ctx);

  log("done", "Agent run complete.");
  if (config.dryRun) {
    const outputDir = resolve(config.paths.workspacePath, '.figma/dry-run');
    process.stdout.write(`\nDRY RUN complete. Prompts written to: ${outputDir}\n`);
  } else {
    process.stdout.write(tokenTracker.formatSummary(config.llm.model));
  }
}

run().catch((err: Error) => {
  const { message, stack } = formatFatalError(err);
  process.stderr.write(`\nFATAL: ${message}\n`);
  if (stack) process.stderr.write(`${stack}\n`);
  process.exit(1);
});
