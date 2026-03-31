import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  MCPServerConfig,
} from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  config: MCPServerConfig;
  tools: MCPToolInfo[];
}

interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ============================================================================
// MCP Client Manager
// ============================================================================

export class MCPClientManager {
  private connections = new Map<string, MCPConnection>();

  /**
   * Connect to an MCP server and discover its tools.
   */
  async connectServer(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already connected`);
    }

    const transport = this.createTransport(config);
    const client = new Client(
      { name: "nexus", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } as Record<string, unknown> },
    );

    await client.connect(transport);

    // Discover tools from the server
    const toolsResult = await client.listTools();
    const tools: MCPToolInfo[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));

    this.connections.set(config.name, { client, transport, config, tools });
  }

  /**
   * Disconnect from an MCP server by name.
   */
  async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) {
      throw new Error(`MCP server "${name}" is not connected`);
    }
    await conn.client.close();
    this.connections.delete(name);
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((name) => this.disconnectServer(name)));
  }

  /**
   * Returns all discovered MCP tools wrapped as Nexus Tool objects.
   *
   * Each tool is named "mcp__{serverName}__{toolName}" following the
   * double-underscore convention used by Claude Code.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [];

    for (const [serverName, conn] of this.connections) {
      for (const mcpTool of conn.tools) {
        tools.push(this.wrapMCPTool(serverName, conn.client, mcpTool));
      }
    }

    return tools;
  }

  /**
   * List resources available on a specific MCP server.
   */
  async getResources(serverName: string): Promise<Resource[]> {
    const conn = this.requireConnection(serverName);
    const result = await conn.client.listResources();
    return (result.resources ?? []).map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /**
   * Read a resource from a specific MCP server by URI.
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    const conn = this.requireConnection(serverName);
    const result = await conn.client.readResource({ uri });
    const contents = result.contents ?? [];
    return contents
      .map((c) => {
        if ("text" in c && typeof c.text === "string") {
          return c.text;
        }
        if ("blob" in c && typeof c.blob === "string") {
          return c.blob;
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private requireConnection(serverName: string): MCPConnection {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return conn;
  }

  private createTransport(
    config: MCPServerConfig,
  ): StdioClientTransport | SSEClientTransport {
    switch (config.transport) {
      case "stdio": {
        if (!config.command) {
          throw new Error(
            `MCP server "${config.name}": stdio transport requires "command"`,
          );
        }
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env
            ? { ...process.env, ...config.env } as Record<string, string>
            : undefined,
        });
      }

      case "http":
      case "sse": {
        if (!config.url) {
          throw new Error(
            `MCP server "${config.name}": ${config.transport} transport requires "url"`,
          );
        }
        return new SSEClientTransport(new URL(config.url));
      }

      default:
        throw new Error(
          `MCP server "${config.name}": unsupported transport "${config.transport}"`,
        );
    }
  }

  /**
   * Wrap a single MCP tool as a Nexus Tool object.
   */
  private wrapMCPTool(
    serverName: string,
    client: Client,
    mcpTool: MCPToolInfo,
  ): Tool {
    const nexusName = `mcp__${serverName}__${mcpTool.name}`;

    // Build a zod schema from the MCP tool's JSON Schema.
    // MCP tools declare JSON Schema objects; we translate the top-level
    // properties into a z.object with z.any() for each field so that
    // validation is lenient while still providing structure.
    const zodSchema = this.jsonSchemaToZod(mcpTool.inputSchema);

    return {
      name: nexusName,
      description: `[MCP: ${serverName}] ${mcpTool.description}`,
      inputSchema: zodSchema,

      async execute(
        input: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolResult> {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        });

        // Normalize MCP tool result into a string
        const content = result.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        const text = content
          ? content
              .map((block) => {
                if (block.type === "text" && typeof block.text === "string") {
                  return block.text;
                }
                return JSON.stringify(block);
              })
              .join("\n")
          : JSON.stringify(result);

        if (result.isError) {
          throw new Error(text);
        }

        return { data: text };
      },

      isConcurrencySafe(_input: Record<string, unknown>): boolean {
        return true;
      },

      isReadOnly(_input: Record<string, unknown>): boolean {
        return false;
      },

      renderToolUse(input: Partial<Record<string, unknown>>): string {
        return `${nexusName}(${JSON.stringify(input)})`;
      },

      renderResult(output: unknown): string {
        return typeof output === "string" ? output : JSON.stringify(output);
      },
    };
  }

  /**
   * Convert a JSON Schema object to a zod schema.
   *
   * For top-level objects with known properties we create a z.object with
   * each property typed as z.any(). For anything else we fall back to
   * z.record(z.any()).
   */
  private jsonSchemaToZod(
    schema: Record<string, unknown>,
  ): z.ZodType<Record<string, unknown>> {
    if (
      schema.type === "object" &&
      schema.properties &&
      typeof schema.properties === "object"
    ) {
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
      );

      for (const [key, _propSchema] of Object.entries(
        schema.properties as Record<string, unknown>,
      )) {
        shape[key] = required.has(key) ? z.any() : z.any().optional();
      }

      return z.object(shape).passthrough() as unknown as z.ZodType<
        Record<string, unknown>
      >;
    }

    // Fallback: accept any object
    return z.record(z.string(), z.any()) as unknown as z.ZodType<
      Record<string, unknown>
    >;
  }
}
