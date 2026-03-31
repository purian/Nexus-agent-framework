import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, NexusConfig, PermissionContext } from "../types/index.js";

// ============================================================================
// MCP Server — Exposes Nexus tools to external MCP clients
// ============================================================================

export class MCPServer {
  private server: Server;
  private transport: StdioServerTransport | null = null;
  private tools = new Map<string, Tool>();

  constructor() {
    this.server = new Server(
      { name: "nexus", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
  }

  /**
   * Start serving the provided Nexus tools over stdio.
   */
  async start(tools: Tool[]): Promise<void> {
    // Index tools by name
    this.tools.clear();
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }

    this.registerHandlers();

    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
  }

  /**
   * Stop the MCP server and close the transport.
   */
  async stop(): Promise<void> {
    await this.server.close();
    this.transport = null;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private registerHandlers(): void {
    // --- ListTools ---
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const mcpTools = [...this.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.zodToJsonSchema(tool),
      }));
      return { tools: mcpTools };
    });

    // --- CallTool ---
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = this.tools.get(name);

      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const input = (args ?? {}) as Record<string, unknown>;

      // Build a minimal ToolContext for execution
      const context = this.buildToolContext();

      try {
        const result = await tool.execute(input, context);
        const text =
          typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2);

        return {
          content: [{ type: "text" as const, text }],
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    });
  }

  /**
   * Extract a JSON Schema representation from a Nexus Tool.
   *
   * Zod schemas carry a _def that can be inspected, but for broad
   * compatibility we produce a permissive object schema and attach
   * whatever information we can pull from the zod definition.
   */
  private zodToJsonSchema(tool: Tool): Record<string, unknown> {
    // Attempt to pull shape from ZodObject
    const def = (tool.inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def;
    if (def?.shape) {
      try {
        const shape = def.shape();
        const properties: Record<string, unknown> = {};
        for (const key of Object.keys(shape)) {
          properties[key] = { type: "string" };
        }
        return {
          type: "object",
          properties,
        };
      } catch {
        // Fall through
      }
    }

    return { type: "object", properties: {} };
  }

  /**
   * Build a minimal ToolContext used when executing tools on behalf
   * of an external MCP client.
   */
  private buildToolContext(): ToolContext {
    const permissions: PermissionContext = {
      mode: "allowAll",
      rules: [],
      checkPermission: () => ({ behavior: "allow" as const }),
      addRule: () => {},
      removeRule: () => {},
    };

    const config: NexusConfig = {
      defaultModel: "",
      defaultProvider: "",
      workingDirectory: process.cwd(),
      dataDirectory: "",
      permissionMode: "allowAll",
      permissionRules: [],
      mcpServers: [],
      platforms: {},
      plugins: [],
      maxConcurrentTools: 4,
      thinking: { enabled: false },
    };

    return {
      workingDirectory: process.cwd(),
      abortSignal: new AbortController().signal,
      permissions,
      config,
    };
  }
}
