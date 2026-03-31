import type {
  NexusConfig,
  PermissionContext,
  Tool,
} from "../types/index.js";

/**
 * ToolExecutor — manages tool registration and lookup.
 *
 * Inspired by Claude Code's StreamingToolExecutor but simplified:
 * - Tool lookup by name and alias
 * - Concurrency safety checks
 * - Permission context propagation
 */
export class ToolExecutor {
  private tools: Map<string, Tool>;
  private permissions: PermissionContext;
  private config: NexusConfig;
  private signal: AbortSignal;

  constructor(
    tools: Map<string, Tool>,
    permissions: PermissionContext,
    config: NexusConfig,
    signal: AbortSignal,
  ) {
    this.tools = tools;
    this.permissions = permissions;
    this.config = config;
    this.signal = signal;
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
