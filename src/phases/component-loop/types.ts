import type {
  AgentConfig,
  ExistingComponent,
  IExtendedReader,
  IFileScanner,
  LLMClient,
  TerminalExecutor,
} from '../../types.js';
import type { ConversationHistory } from '../../llm/index.js';
import type { BootContext } from '../../figma/context.js';

export interface PhaseDeps {
  llm: LLMClient;
  history: ConversationHistory;
  terminal: TerminalExecutor;
  config: AgentConfig;
}

export interface ComponentBuildInput {
  name: string;
  yaml: string;
  plan: string;
  existing?: ExistingComponent;
}

export interface PromptExtras {
  packageNames?: string[];
  hookSources?: Array<{ path: string; content: string }>;
  scaffoldDeps?: ExistingComponent[];
  variantUsageSection?: string[];
  previouslyBuiltInterfaces?: Map<string, string>;
}

export interface PreparedComponent {
  yaml: string;
  yamlPath: string;
  hookSources: Array<{ path: string; content: string }>;
  scaffoldDeps: ExistingComponent[];
}

export interface ComponentLoopInput {
  planContent: string;
  bootCtx: BootContext;
  scanner: IFileScanner;
  extReader: IExtendedReader;
}
