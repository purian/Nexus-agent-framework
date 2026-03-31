/**
 * Nexus — An open-source, MCP-native personal AI agent framework.
 *
 * Secure, composable, multi-agent.
 *
 * Inspired by the architectural patterns of Claude Code,
 * designed to surpass OpenClaw in security, composability, and extensibility.
 */

// Core
export { NexusEngine } from "./core/engine.js";
export { AnthropicProvider } from "./core/providers/anthropic.js";

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
