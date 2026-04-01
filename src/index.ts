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

  // Agents
  AgentConfig,
  AgentState,

  // Memory
  MemoryType,
  MemoryEntry,
  MemoryStore,

  // Platforms
  PlatformAdapter,
  IncomingMessage,

  // Plugins
  Plugin,
  NexusRuntime,

  // Config
  NexusConfig,
  MCPServerConfig,

  // Engine Events
  EngineEvent,
} from "./types/index.js";

// Tools
export { createDefaultTools } from "./tools/index.js";

// Permissions
export { PermissionManager } from "./permissions/index.js";

// MCP
export { MCPClientManager } from "./mcp/client.js";
export { MCPServer } from "./mcp/server.js";

// Agents
export { AgentCoordinator } from "./agents/coordinator.js";

// Memory
export { MemoryManager } from "./memory/index.js";

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
