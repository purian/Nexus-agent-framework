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
// RBAC Types
// ============================================================================

export interface RBACRole {
  /** Unique role name (e.g., "admin", "developer", "viewer") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Permission rules granted by this role */
  permissions: PermissionRule[];
  /** Roles this role inherits from (permissions are merged) */
  inherits?: string[];
}

export interface RBACPolicy {
  /** Available roles */
  roles: RBACRole[];
  /** Default role assigned when no specific assignment exists */
  defaultRole?: string;
  /** Agent-to-role assignments */
  assignments: RBACAssignment[];
}

export interface RBACAssignment {
  /** Agent ID or pattern (e.g., "agent-*" for all agents matching) */
  agentId: string;
  /** Assigned role names */
  roles: string[];
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
  isolation?: "worktree";
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
// Agent Messaging Types
// ============================================================================

/** Types of messages that can be sent between agents */
export type AgentMessageType =
  | "request"       // Ask another agent to do something; expects a response
  | "response"      // Reply to a request
  | "notification"  // One-way informational message
  | "error"         // Error notification
  | "broadcast";    // Message sent to multiple agents

/** Priority levels for agent messages */
export type AgentMessagePriority = "high" | "normal" | "low";

/** Delivery status of a message */
export type AgentMessageStatus = "pending" | "delivered" | "read";

/** Structured message exchanged between agents */
export interface AgentMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent ID */
  from: string;
  /** Recipient agent ID */
  to: string;
  /** Message type */
  type: AgentMessageType;
  /** Message content — plain text or structured JSON payload */
  payload: unknown;
  /** Optional metadata for routing, correlation, and filtering */
  metadata: AgentMessageMetadata;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Current delivery status */
  status: AgentMessageStatus;
}

/** Metadata attached to an agent message */
export interface AgentMessageMetadata {
  /** Priority level (default: "normal") */
  priority?: AgentMessagePriority;
  /** Message ID this is replying to (for request-response patterns) */
  inReplyTo?: string;
  /** Correlation ID to group related messages (e.g., same task) */
  correlationId?: string;
  /** Tags for filtering and categorization */
  tags?: string[];
  /** Arbitrary key-value data */
  custom?: Record<string, unknown>;
}

// ============================================================================
// Memory Types
// ============================================================================

export interface EncryptionConfig {
  /** Enable encryption for memory entries */
  enabled: boolean;
  /** Master key (hex-encoded) — if not provided, derived from passphrase */
  masterKey?: string;
  /** Passphrase for key derivation (used when masterKey is not set) */
  passphrase?: string;
  /** Fields to encrypt (default: ["content"]) */
  encryptedFields?: Array<"name" | "description" | "content" | "tags">;
}

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
  /** Sandbox configuration for running bash commands in Docker containers */
  sandbox?: SandboxConfig;
  /** Role-Based Access Control policy */
  rbac?: RBACPolicy;
  /** Encryption configuration for memory at-rest encryption */
  encryption?: EncryptionConfig;
  /** Rate limiting configuration */
  rateLimits?: RateLimitConfig;
}

export interface MCPOAuthConfig {
  /** OAuth provider type */
  provider: "oauth2";
  /** Authorization endpoint URL */
  authorizationUrl: string;
  /** Token endpoint URL */
  tokenUrl: string;
  /** Client ID */
  clientId: string;
  /** Client secret (should come from env vars) */
  clientSecret?: string;
  /** OAuth scopes */
  scopes?: string[];
  /** Token refresh buffer in seconds (refresh this many seconds before expiry, default 60) */
  refreshBufferSeconds?: number;
  /** Custom headers to include in token requests */
  tokenRequestHeaders?: Record<string, string>;
}

export type MCPAuthConfig = MCPOAuthConfig;

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  auth?: MCPAuthConfig;
}

// ============================================================================
// Sandbox Types
// ============================================================================

export interface SandboxConfig {
  /** Enable sandboxed execution */
  enabled: boolean;
  /** Docker image to use (default: "node:20-slim") */
  image?: string;
  /** Memory limit (e.g., "512m") */
  memoryLimit?: string;
  /** CPU limit (e.g., "1.0" for one CPU) */
  cpuLimit?: string;
  /** Network mode: "none" disables networking, "bridge" allows it (default: "none") */
  networkMode?: "none" | "bridge" | "host";
  /** Directories to mount read-only */
  readOnlyMounts?: string[];
  /** Directories to mount read-write (working directory is always mounted) */
  readWriteMounts?: string[];
  /** Additional environment variables for the container */
  env?: Record<string, string>;
  /** Max container lifetime in seconds (default: 300) */
  maxLifetime?: number;
}

// ============================================================================
// Rate Limiting Types
// ============================================================================

export interface RateLimitConfig {
  /** Enable rate limiting */
  enabled: boolean;
  /** Default rate limit applied to all tools (if no specific limit) */
  defaultLimit?: RateLimitRule;
  /** Per-tool rate limits (keyed by tool name or glob pattern) */
  toolLimits?: Record<string, RateLimitRule>;
  /** Per-agent rate limits (keyed by agent ID or glob pattern) */
  agentLimits?: Record<string, RateLimitRule>;
}

export interface RateLimitRule {
  /** Maximum number of executions allowed in the window */
  maxExecutions: number;
  /** Time window in seconds */
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next execution is allowed (when not allowed) */
  retryAfterSeconds?: number;
  /** Current count in the window */
  currentCount: number;
  /** Maximum allowed in the window */
  maxCount: number;
}

// ============================================================================
// Hub Types
// ============================================================================

export interface HubServerEntry {
  /** Unique identifier (e.g., "github/nexus-mcp-git") */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Author/organization */
  author: string;
  /** npm package name or git repo URL */
  source: string;
  /** Transport type */
  transport: "stdio" | "http" | "sse";
  /** Command to start (for stdio) */
  command?: string;
  /** Default args */
  args?: string[];
  /** Server URL (for http/sse) */
  url?: string;
  /** Required environment variables */
  requiredEnv?: string[];
  /** Categories/tags */
  tags?: string[];
  /** Security review status */
  securityStatus: "verified" | "community" | "unreviewed";
  /** Version */
  version: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Downloads/installs count */
  downloads?: number;
}

export interface HubRegistry {
  /** Registry version */
  version: string;
  /** Last synced timestamp */
  lastSynced?: string;
  /** Remote registry URL for syncing */
  remoteUrl?: string;
  /** Server entries */
  servers: HubServerEntry[];
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
