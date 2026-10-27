import type { TerminalExecutor } from '../types.js';
import { log } from '../log.js';

interface GitResult {
  success: boolean;
  output: string;
}

async function stageFiles(
  terminal: TerminalExecutor,
  path: string,
): Promise<GitResult> {
  const result = await terminal(`git add ${path}`);
  return {
    success: result.exitCode === 0,
    output: result.exitCode === 0 ? result.stdout : result.stderr,
  };
}

async function commitStagedFiles(
  terminal: TerminalExecutor,
  message: string,
): Promise<GitResult> {
  const result = await terminal(`git commit -m '${message}'`);
  return {
    success: result.exitCode === 0,
    output: result.exitCode === 0 ? result.stdout : result.stderr,
  };
}

export async function commitComponentBuild(
  terminal: TerminalExecutor,
  componentName: string,
  componentDir: string,
): Promise<void> {
  const staged = await stageFiles(terminal, componentDir);
  if (!staged.success) {
    log('component_loop', `Git stage failed for ${componentDir}: ${staged.output}`);
    return;
  }
  const committed = await commitStagedFiles(
    terminal,
    `pipeline: build ${componentName}`,
  );
  if (!committed.success) {
    log('component_loop', `Git commit failed for ${componentName}: ${committed.output}`);
    return;
  }
  log('component_loop', `Committed build: ${componentName}`);
}
