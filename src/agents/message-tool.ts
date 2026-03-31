import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";
import type { AgentCoordinator } from "./coordinator.js";

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const SendMessageInputSchema = z.object({
  agentId: z.string().describe("The ID of the agent to send the message to"),
  message: z.string().describe("The message content to send"),
});

type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

// ---------------------------------------------------------------------------
// SendMessage Tool
// ---------------------------------------------------------------------------

/**
 * A tool for sending messages between agents. The sending agent's ID is
 * taken from the ToolContext.agentId. The message is placed in the
 * recipient's mailbox and can be read on the recipient's next turn.
 */
export function createSendMessageTool(
  coordinator: AgentCoordinator,
): Tool<SendMessageInput, string> {
  return {
    name: "send_message",
    description:
      "Send a message to another agent by ID. The message will be placed " +
      "in the recipient agent's mailbox and can be read on its next turn. " +
      "Use this for coordination and sharing intermediate results between agents.",
    inputSchema: SendMessageInputSchema,

    async execute(
      input: SendMessageInput,
      context: ToolContext,
    ): Promise<ToolResult<string>> {
      const fromAgentId = context.agentId ?? "unknown";

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
        coordinator.sendMessage(fromAgentId, input.agentId, input.message);
        return {
          data: `Message sent to agent "${input.agentId}" (status: ${targetAgent.status}).`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { data: `Error sending message: ${msg}` };
      }
    },

    isConcurrencySafe(_input: SendMessageInput): boolean {
      // Message sends are isolated per-mailbox; safe to run concurrently
      return true;
    },

    isReadOnly(_input: SendMessageInput): boolean {
      // Sending a message is a side effect (mutates mailbox state)
      return false;
    },

    renderToolUse(input: Partial<SendMessageInput>): string {
      const preview =
        input.message && input.message.length > 60
          ? input.message.slice(0, 60) + "..."
          : input.message ?? "";
      return `Sending message to agent ${input.agentId ?? "?"}: ${preview}`;
    },

    renderResult(output: string): string {
      return output;
    },
  };
}
