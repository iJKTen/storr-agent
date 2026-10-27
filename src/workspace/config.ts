import { resolve } from 'node:path';
import type {
  AgentConfig,
  LLMConfig,
  LLMProvider,
  PathConfig,
  RetryConfig,
  TerminalConfig,
  TerminalMode,
} from '../types.js';

const VALID_PROVIDERS = new Set<LLMProvider>(['openai', 'ollama', 'anthropic']);
const VALID_TERMINAL_MODES = new Set<TerminalMode>(['local', 'docker']);

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: 'gpt-4o',
  ollama: 'qwen3.6:35b',
  anthropic: 'claude-sonnet-5',
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
};

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.set(key, next);
        i++;
      } else {
        args.set(key, 'true');
      }
    }
  }
  return args;
}

function resolveLLMConfig(
  args: Map<string, string>,
  provider: LLMProvider,
): LLMConfig {
  const model = args.get('model')
    ?? (provider === 'anthropic' ? process.env['ANTHROPIC_MODEL'] : process.env['OPENAI_MODEL'])
    ?? DEFAULT_MODELS[provider];

  const rawKey = provider === 'anthropic'
    ? (process.env['ANTHROPIC_API_KEY'] ?? '')
    : (process.env['OPENAI_API_KEY'] ?? '');
  const apiKey = provider === 'ollama' && !rawKey ? 'ollama' : rawKey;

  const baseURL = provider === 'ollama'
    ? (process.env['OPENAI_BASE_URL'] ?? DEFAULT_BASE_URLS['ollama'])
    : provider === 'openai'
      ? process.env['OPENAI_BASE_URL']
      : undefined;

  const temperature = parseFloat(process.env['LLM_TEMPERATURE'] ?? '0.3');

  return { provider, model, apiKey, baseURL, temperature };
}

function resolvePathConfig(args: Map<string, string>): PathConfig {
  return {
    workspacePath: resolve(
      args.get('workspace') ?? process.env['WORKSPACE_PATH'] ?? '../eve',
    ),
    rulesPath: resolve(
      args.get('rules') ?? process.env['RULES_PATH'] ?? '../storr-prompt/rules',
    ),
  };
}

function resolveTerminalConfig(args: Map<string, string>): TerminalConfig {
  const mode = (args.get('terminal') ?? process.env['TERMINAL_MODE'] ?? 'local') as TerminalMode;
  if (!VALID_TERMINAL_MODES.has(mode)) {
    throw new Error(`Invalid TERMINAL_MODE: "${mode}". Must be one of: ${[...VALID_TERMINAL_MODES].join(', ')}`);
  }

  const dockerContainer = process.env['DOCKER_CONTAINER'];
  if (mode === 'docker' && !dockerContainer) {
    throw new Error('TERMINAL_MODE=docker requires DOCKER_CONTAINER to be set.');
  }

  return { mode, dockerContainer };
}

function resolveRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env['MAX_RETRIES'] ?? '3', 10),
    maxEvalRetries: parseInt(process.env['MAX_EVAL_RETRIES'] ?? '5', 10),
  };
}

export function loadConfig(): AgentConfig {
  const args = parseArgs(process.argv);

  const dryRun = args.get('dry-run') === 'true' || process.env['DRY_RUN'] === '1';

  const providerStr = args.get('provider') ?? process.env['LLM_PROVIDER'] ?? 'openai';
  if (!VALID_PROVIDERS.has(providerStr as LLMProvider)) {
    throw new Error(`Invalid LLM_PROVIDER: "${providerStr}". Must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
  }
  const provider = providerStr as LLMProvider;

  return {
    llm: resolveLLMConfig(args, provider),
    paths: resolvePathConfig(args),
    terminal: resolveTerminalConfig(args),
    retry: resolveRetryConfig(),
    dryRun,
  };
}
