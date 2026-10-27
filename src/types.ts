// ── LLM Provider ──

export type LLMProvider = 'openai' | 'ollama' | 'anthropic';

export type TerminalMode = 'local' | 'docker';

// ── Configuration (decomposed from 10-property AgentConfig) ──

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseURL: string | undefined;
  temperature: number;
}

export interface PathConfig {
  workspacePath: string;
  rulesPath: string;
}

export interface TerminalConfig {
  mode: TerminalMode;
  dockerContainer: string | undefined;
}

export interface RetryConfig {
  maxRetries: number;
  maxEvalRetries: number;
}

export interface AgentRuntimeConfig {
  llm: LLMConfig;
  terminal: TerminalConfig;
}

export interface AgentPipelineConfig {
  paths: PathConfig;
  retry: RetryConfig;
  dryRun: boolean;
}

export type AgentConfig = AgentRuntimeConfig & AgentPipelineConfig;

// ── Tool Call Payloads ──

export interface WriteComponentPayload {
  componentName: string;
  tsxContent: string;
  cssContent?: string;
  contentTsContent?: string;
}

export interface UpdateFilePayload {
  filePath: string;
  content: string;
}

// ── Eval Results ──

export interface EvalError {
  rule: string;
  message: string;
}

export type EvalResult =
  | { pass: true }
  | { pass: false; errors: EvalError[] };

// ── LLM Messages ──

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  stopReason: 'stop' | 'tool_use' | 'length' | 'unknown';
  usage?: TokenUsage;
}

export type ToolChoiceOption = 'auto' | 'required' | 'none';

// ── LLM Client Interface ──

export interface LLMClient {
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    toolChoice?: ToolChoiceOption,
  ): Promise<ChatResponse>;
}

// ── Tool Definition (typed parameter schema) ──

export interface ToolPropertyDef {
  type: string;
  description: string;
  enum?: string[];
}

export type ToolSchemaValue = string | boolean | string[] | Record<string, ToolPropertyDef>;

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolPropertyDef>;
  required: string[];
  additionalProperties?: boolean;
  [key: string]: ToolSchemaValue | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ── Integration ──

export interface IntegrationTarget {
  targetFile: string;
  targetType: 'pageLayout' | 'route' | 'template';
  componentNames: string[];
  pageYamlPaths: string[];
  hasDataBindings?: boolean;
  instanceProps?: Record<string, Record<string, string>>;
}

// ── State Machine ──

export type AgentState =
  | 'boot'
  | 'foundation'
  | 'plan'
  | 'plan_eval'
  | 'component_loop'
  | 'component_eval'
  | 'integration'
  | 'final_audit'
  | 'done';

// ── YAML Data Structures ──

export interface InventoryDevStatus {
  type: string;
  description?: string;
}

export interface InventoryItem {
  name: string;
  slug: string;
  type: string;
  childCount: number;
  devStatus?: InventoryDevStatus;
}

export interface ComponentInventory {
  page: string;
  components: InventoryItem[];
}

export interface PageInventory {
  page: string;
  pages: InventoryItem[];
}

export type Inventory = ComponentInventory | PageInventory;

// ── Terminal ──

export interface TerminalResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type TerminalExecutor = (command: string) => Promise<TerminalResult>;

// ── File System ──

export interface YAMLFileEntry {
  directory: string;
  filename: string;
  relativePath: string;
}

export interface EvalLogEntry {
  componentName: string;
  attempt: number;
  yamlContent: string;
  payload: WriteComponentPayload;
}

export interface IFileReader {
  readonly workspacePath: string;
  fileExists(relativePath: string): boolean;
  readFile(relativePath: string): Promise<string>;
  readYAML<T = Record<string, string>>(relativePath: string): Promise<T>;
}

export interface IFileWriter {
  writeFile(relativePath: string, content: string): Promise<void>;
  writeComponentFiles(payload: WriteComponentPayload, componentDir: string): Promise<string[]>;
  writePlan(planContent: string): Promise<string>;
  writeEvalLog(entry: EvalLogEntry, errors: EvalError[]): Promise<void>;
}

export interface IFileScanner {
  listYAMLTree(): Promise<YAMLFileEntry[]>;
  readAllInventories(): Promise<Inventory[]>;
  scanExistingComponents(): Promise<Map<string, ExistingComponent>>;
  scanSingleComponent(componentDir: string): Promise<ExistingComponent | undefined>;
}

export interface IExtendedReader {
  readAbsoluteFile(absolutePath: string): Promise<string>;
  directoryExists(absolutePath: string): boolean;
  readDir(relativeDirPath: string, extension: string): Promise<Array<{ filename: string; content: string }>>;
  listDir(absolutePath: string): Promise<string[]>;
}

export interface IFileCopier {
  copyFile(sourcePath: string, destPath: string): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
}

// ── Existing Scaffold Components ──

export interface ExistingComponent {
  name: string;           // PascalCase directory name, e.g. "Header"
  directory: string;      // Workspace-relative path, e.g. "app/components/Header"
  files: Map<string, string>;  // filename -> content for .tsx, .ts, .css files
}

// ── SVG Node Entry ──

export interface SvgNodeEntry {
  name: string;
  assetPath?: string;  // e.g. "app/assets/search-2.svg"
}

// ── Semantic HTML Element ──

export interface SemanticElement {
  element: string;
  type?: string;
  className?: string;
}

// ── Parsed YAML Design Data ──

export interface PropTextEntry {
  text: string;
  propName: string;
}

export interface YAMLDesignData {
  texts: string[];          // display text from TEXT nodes
  propTexts: PropTextEntry[];  // TEXT nodes driven by componentPropertyReferences
  svgNodes: SvgNodeEntry[]; // IMAGE-SVG nodes with optional assetPath
  classNames: string[];     // generatedCSS.className values from YAML nodes
}
