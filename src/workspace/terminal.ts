import { exec } from 'node:child_process';
import type { AgentConfig, TerminalExecutor, TerminalResult } from '../types.js';

const STRIP_ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(str: string): string {
  return str.replace(STRIP_ANSI_REGEX, '');
}

function createLocalTerminal(workspacePath: string): TerminalExecutor {
  return (command: string): Promise<TerminalResult> => {
    return new Promise((resolve) => {
      exec(command, {
        cwd: workspacePath,
        env: { ...process.env, FORCE_COLOR: '0' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode: error?.code ?? (typeof error?.code === 'number' ? error.code : 0),
        });
      });
    });
  };
}

function createDockerTerminal(container: string, workDir: string): TerminalExecutor {
  return (command: string): Promise<TerminalResult> => {
    const escaped = command.replace(/'/g, "'\\''");
    const dockerCmd = `docker exec -w ${workDir} ${container} sh -c '${escaped}'`;

    return new Promise((resolve) => {
      exec(dockerCmd, {
        env: { ...process.env, FORCE_COLOR: '0' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode: error?.code ?? (typeof error?.code === 'number' ? error.code : 0),
        });
      });
    });
  };
}

export function createTerminal(config: AgentConfig): TerminalExecutor {
  if (config.terminal.mode === 'docker') {
    if (!config.terminal.dockerContainer) {
      throw new Error('Docker terminal mode requires a container name.');
    }
    return createDockerTerminal(config.terminal.dockerContainer, config.paths.workspacePath);
  }
  return createLocalTerminal(config.paths.workspacePath);
}
