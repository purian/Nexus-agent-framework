import { z } from "zod";
import type {
  AgentMessageType,
  Tool,
  ToolContext,
  ToolResult,
} from "../types/index.js";
import type { AgentCoordinator } from "./coordinator.js";

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const SendMessageInputSchema = z.object({
  agentId: z
    .string()
    .describe(
      'The ID of the agent to send the message to, or "*" to broadcast to all agents',
    ),
  message: z
    .union([z.string(), z.record(z.unknown())])
    .describe("The message content — a string or a JSON object"),
  type: z
    .enum(["request", "response", "notification", "error"])
    .optional()
    .describe(
      'Message type: "request" expects a reply, "response" replies to a request, ' +
        '"notification" is one-way, "error" signals a problem. Default: "notification"',
    ),
  inReplyTo: z
    .string()
    .optional()
    .describe("Message ID this is replying to (for request-response patterns)"),
  correlationId: z
    .string()
    .optional()
    .describe("Correlation ID to group related messages together"),
  priority: z
    .enum(["high", "normal", "low"])
    .optional()
    .describe("Message priority. Default: normal"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags for filtering and categorization"),
});

type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

// ---------------------------------------------------------------------------
// SendMessage Tool
// ---------------------------------------------------------------------------

/**
 * A tool for sending structured messages between agents. Supports typed
 * messages (request/response/notification/error), broadcast, metadata
 * (priority, correlation, tags), and request-response patterns.
 */
export function createSendMessageTool(
  coordinator: AgentCoordinator,
): Tool<SendMessageInput, string> {
  return {
    name: "send_message",
    description:
      "Send a structured message to another agent by ID. Supports request/response " +
      "patterns, broadcast (agentId: \"*\"), priorities, correlation IDs, and tags. " +
      "Messages can be plain strings or structured JSON objects. " +
      "Use this for coordination, sharing results, and request-response flows between agents.",
    inputSchema: SendMessageInputSchema,

    async execute(
      input: SendMessageInput,
      context: ToolContext,
    ): Promise<ToolResult<string>> {
      const fromAgentId = context.agentId ?? "unknown";
      const messageType: AgentMessageType = input.type ?? "notification";

      // Broadcast mode
      if (input.agentId === "*") {
        try {
          const ids = coordinator.broadcastMessage(fromAgentId, input.message, {
            priority: input.priority,
            correlationId: input.correlationId,
            tags: input.tags,
          });
          return {
            data: `Broadcast sent to ${ids.length} agent(s). Message IDs: ${ids.join(", ")}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { data: `Error broadcasting: ${msg}` };
        }
      }

      // Verify the target agent exists
      const targetAgent = coordinator.getAgent(input.agentId);
      if (!targetAgent) {
        return {
          data: `Error: Agent "${input.agentId}" not found. Available agents: ${coordinator
            .listAgents()
            .map((a) => `${a.id} (${a.status})`)
            .join(", ")}`,
        };
      }

      try {
        const msgId = coordinator.sendStructuredMessage(
          fromAgentId,
          input.agentId,
          {
            type: messageType,
            payload: input.message,
            metadata: {
              priority: input.priority,
              inReplyTo: input.inReplyTo,
              correlationId: input.correlationId,
              tags: input.tags,
            },
          },
        );
        return {
          data:
            `Message sent to agent "${input.agentId}" (status: ${targetAgent.status}). ` +
            `Message ID: ${msgId}, type: ${messageType}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { data: `Error sending message: ${msg}` };
      }
    },

    isConcurrencySafe(_input: SendMessageInput): boolean {
      return true;
    },

    isReadOnly(_input: SendMessageInput): boolean {
      return false;
    },

    renderToolUse(input: Partial<SendMessageInput>): string {
      const rawMsg = input.message;
      const msgStr =
        typeof rawMsg === "string" ? rawMsg : JSON.stringify(rawMsg ?? "");
      const preview =
        msgStr.length > 60 ? msgStr.slice(0, 60) + "..." : msgStr;
      const target = input.agentId === "*" ? "all agents" : `agent ${input.agentId ?? "?"}`;
      const typeSuffix = input.type ? ` [${input.type}]` : "";
      return `Sending${typeSuffix} to ${target}: ${preview}`;
    },

    renderResult(output: string): string {
      return output;
    },
  };
}
