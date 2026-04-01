import type { z } from "zod";

// ============================================================================
// Core Message Types
// ============================================================================

export type Role = "user" | "assistant" | "system" | "tool";

export interface Message {
  role: Role;
  content: ContentBlock[];
  metadata?: Record<string, unknown>;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type: string;
    data: string;
  };
}

// ============================================================================
// LLM Provider Types
// ============================================================================

export interface LLMProvider {
  name: string;
  chat(request: LLMRequest, signal?: AbortSignal): AsyncGenerator<LLMEvent>;
  listModels?(): Promise<string[]>;
}

export interface LLMRequest {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingConfig;
  stopSequences?: string[];
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
}

export type LLMEvent =
  | { type: "message_start"; messageId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialInput: string }
  | { type: "tool_use_end"; id: string; input: Record<string, unknown> }
  | { type: "message_end"; stopReason: StopReason; usage: TokenUsage }
  | { type: "error"; error: Error };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ============================================================================
// Tool Types
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Tool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> {
  /** Unique tool name */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** Zod schema for input validation */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodType<TInput, any, any>;
  /** Execute the tool */
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
  /** Check if this tool can run concurrently with others */
  isConcurrencySafe(input: TInput): boolean;
  /** Check if this tool only reads (no side effects) */
  isReadOnly(input: TInput): boolean;
  /** Check permissions before execution */
  checkPermissions?(
    input: TInput,
    context: ToolContext,
  ): Promise<PermissionDecision>;
  /** Render tool use for display */
  renderToolUse?(input: Partial<TInput>): string;
  /** Render tool result for display */
  renderResult?(output: TOutput): string;
  /** Max characters for result before truncation */
  maxResultSize?: number;
}

export interface ToolResult<T = unknown> {
  data: T;
  /** Additional messages to inject into conversation */
  newMessages?: Message[];
}

export interface ToolContext {
  workingDirectory: string;
  abortSignal: AbortSignal;
  agentId?: string;
  permissions: PermissionContext;
  config: NexusConfig;
  /** Report progress during long-running operations */
  onProgress?(data: ToolProgress): void;
}

export interface ToolProgress {
  toolUseId: string;
  message: string;
  percent?: number;
}

// ============================================================================
// Permission Types
// ============================================================================

export type PermissionMode =
  | "default" // Prompt user
  | "allowAll" // Auto-allow everything
  | "denyAll" // Auto-deny everything
  | "plan"; // Planning mode (read-only)

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  toolName: string;
  pattern?: string; // e.g., "git *" for Bash tool
  behavior: PermissionBehavior;
  source: PermissionSource;
}

export type PermissionSource =
  | "user" // User settings
  | "project" // Project-level config
  | "session" // In-memory session
  | "cli"; // CLI argument

export type PermissionDecision =
  | { behavior: "allow"; modifiedInput?: Record<string, unknown> }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; message: string; suggestions?: PermissionRule[] };

export interface PermissionContext {
  mode: PermissionMode;
  rules: PermissionRule[];
  checkPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision;
  addRule(rule: PermissionRule): void;
  removeRule(toolName: string, pattern?: string): void;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  systemPrompt?: string;
  tools?: string[]; // Tool names to enable
  maxTokens?: number;
  maxTurns?: number;
  parentId?: string;
}

export interface AgentState {
  id: string;
  status: "idle" | "running" | "paused" | "completed" | "error";
  messages: Message[];
  usage: TokenUsage;
  children: string[]; // Child agent IDs
  result?: string;
  error?: string;
}

// ============================================================================
// Memory Types
// ============================================================================

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  name: string;
  description: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
}

// ============================================================================
// Platform Types
// ============================================================================

export interface PlatformAdapter {
  name: string;
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (message: IncomingMessage) => void): void;
  sendMessage(chatId: string, content: string): Promise<void>;
}

export interface IncomingMessage {
  platform: string;
  chatId: string;
  userId: string;
  text: string;
  attachments?: Array<{
    type: string;
    url: string;
    data?: Buffer;
  }>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Plugin Types
// ============================================================================

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: Tool[];
  platforms?: PlatformAdapter[];
  setup?(nexus: NexusRuntime): Promise<void>;
  teardown?(): Promise<void>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface NexusConfig {
  /** Default LLM provider and model */
  defaultModel: string;
  defaultProvider: string;
  /** Working directory */
  workingDirectory: string;
  /** Data directory for memory, config, etc. */
  dataDirectory: string;
  /** Permission mode */
  permissionMode: PermissionMode;
  /** Permission rules */
  permissionRules: PermissionRule[];
  /** MCP servers to connect to */
  mcpServers: MCPServerConfig[];
  /** Platform connections */
  platforms: Record<string, Record<string, unknown>>;
  /** Plugin paths to load */
  plugins: string[];
  /** Max budget in USD per session */
  maxBudgetUsd?: number;
  /** Max context window tokens for compression (default: 100000) */
  contextTokens?: number;
  /** Max concurrent tool executions */
  maxConcurrentTools: number;
  /** Enable extended thinking */
  thinking: ThinkingConfig;
}

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ============================================================================
// Runtime Interface (exposed to plugins)
// ============================================================================

export interface NexusRuntime {
  config: NexusConfig;
  registerTool(tool: Tool): void;
  registerPlatform(platform: PlatformAdapter): void;
  getMemory(): MemoryStore;
  getAgent(id: string): AgentState | undefined;
}

export interface MemoryStore {
  save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  search(query: string, type?: MemoryType): Promise<MemoryEntry[]>;
  list(type?: MemoryType): Promise<MemoryEntry[]>;
  update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry>;
  delete(id: string): Promise<void>;
}

// ============================================================================
// Engine Events (for UI/logging)
// ============================================================================

export type EngineEvent =
  | { type: "turn_start"; turnNumber: number }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; toolName: string; toolUseId: string; input: Record<string, unknown> }
  | { type: "tool_progress"; toolUseId: string; progress: ToolProgress }
  | { type: "tool_end"; toolUseId: string; result: string; isError: boolean }
  | { type: "permission_request"; toolName: string; input: Record<string, unknown>; resolve: (decision: PermissionDecision) => void }
  | { type: "plan_action_intercepted"; toolName: string; toolUseId: string; input: Record<string, unknown>; description: string }
  | { type: "plan_created"; planId: string; summary: string; actionCount: number }
  | { type: "turn_end"; stopReason: StopReason; usage: TokenUsage }
  | { type: "error"; error: Error }
  | { type: "done"; totalUsage: TokenUsage };
