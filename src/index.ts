/**
 * Nexus — An open-source, MCP-native personal AI agent framework.
 *
 * Secure. Composable. Multi-agent.
 */

// Core
export { NexusEngine } from "./core/engine.js";

// Providers
export { AnthropicProvider } from "./core/providers/anthropic.js";
export { OpenAIProvider } from "./core/providers/openai.js";
export { OllamaProvider } from "./core/providers/ollama.js";
export { GeminiProvider } from "./core/providers/gemini.js";
export { BedrockProvider } from "./core/providers/bedrock.js";
export { FallbackProvider } from "./core/providers/fallback.js";
export { AuditLogger } from "./core/audit-logger.js";
export { ContextCompressor } from "./core/context-compressor.js";
export { PlanExecutor } from "./core/plan-mode.js";
export type { Plan, PlannedAction } from "./core/plan-mode.js";
export { RateLimiter } from "./core/rate-limiter.js";

// Skills
export { SkillLoader } from "./skills/loader.js";
export { createSkillTool } from "./skills/skill-tool.js";

// Types (re-export everything)
export type {
  // Messages
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  Role,

  // LLM
  LLMProvider,
  LLMRequest,
  LLMEvent,
  TokenUsage,
  StopReason,

  // Tools
  Tool,
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolProgress,

  // Permissions
  PermissionMode,
  PermissionBehavior,
  PermissionRule,
  PermissionDecision,
  PermissionContext,

  // RBAC
  RBACRole,
  RBACPolicy,
  RBACAssignment,

  // Agents
  AgentConfig,
  AgentState,

  // Memory
  MemoryType,
  MemoryEntry,
  MemoryStore,
  EncryptionConfig,

  // Platforms
  PlatformAdapter,
  IncomingMessage,

  // Plugins
  Plugin,
  NexusRuntime,

  // Config
  NexusConfig,
  MCPServerConfig,
  MCPOAuthConfig,
  MCPAuthConfig,
  SandboxConfig,

  // Rate Limiting
  RateLimitConfig,
  RateLimitRule,
  RateLimitDecision,

  // Engine Events
  EngineEvent,
} from "./types/index.js";

// Tools
export { createDefaultTools } from "./tools/index.js";
export { DockerSandbox } from "./tools/sandbox.js";
export type { SandboxExecResult } from "./tools/sandbox.js";

// Permissions
export { PermissionManager } from "./permissions/index.js";
export { RBACManager } from "./permissions/rbac.js";

// MCP
export { MCPClientManager } from "./mcp/client.js";
export { OAuthTokenManager } from "./mcp/oauth.js";
export type { OAuthToken } from "./mcp/oauth.js";
export { MCPServer } from "./mcp/server.js";

// Agents
export { AgentCoordinator } from "./agents/coordinator.js";
export { AgentDefinitionLoader } from "./agents/definitions.js";
export type { AgentDefinition } from "./agents/definitions.js";
export { WorktreeManager } from "./agents/worktree.js";
export type { WorktreeInfo } from "./agents/worktree.js";
export { BackgroundAgentManager } from "./agents/background.js";
export type {
  BackgroundAgentStatus,
  BackgroundAgentInfo,
  BackgroundAgentNotification,
} from "./agents/background.js";

// Memory
export { MemoryManager } from "./memory/index.js";
export { MemoryEncryption } from "./memory/encryption.js";

// Plugins
export { PluginLoader } from "./plugins/index.js";

// Platforms
export { createPlatform } from "./platforms/index.js";

// Config
export { loadConfig } from "./config/index.js";

// Self-Hosting
export {
  findNexusRoot,
  buildSelfHostSystemPrompt,
  getSelfHostPermissionRules,
  buildSelfHostConfig,
} from "./selfhost/index.js";
export type { SelfHostOptions } from "./selfhost/index.js";
