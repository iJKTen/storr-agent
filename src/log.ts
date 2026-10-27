import type { AgentState } from './types.js';

export function log(state: AgentState, message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${timestamp}] [${state}] ${message}\n`);
}
