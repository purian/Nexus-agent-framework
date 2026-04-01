import { z } from "zod";
import { v4 as uuid } from "uuid";
import type {
  Tool,
  ToolContext,
  ToolResult,
  LLMProvider,
} from "../types/index.js";
import type { AgentCoordinator } from "./coordinator.js";

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const AgentToolInputSchema = z.object({
  prompt: z.string().describe("The task description / prompt for the sub-agent"),
  name: z.string().optional().describe("Human-readable name for the sub-agent"),
  model: z.string().optional().describe("LLM model override for the sub-agent"),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool names to make available to the sub-agent. Omit for all tools."),
  definition: z
    .string()
    .optional()
    .describe(
      "Name of an agent definition to use. When provided, the definition's " +
      "systemPrompt, tools, model, maxTurns, and temperature are applied.",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "When true, launch the agent in the background and return immediately. " +
      "You will be notified when it completes. Use for long-running tasks.",
    ),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe(
      "Isolation mode for the sub-agent. When set to 'worktree', the agent " +
      "runs in an isolated git worktree so it doesn't conflict with other agents.",
    ),
});

type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

// ---------------------------------------------------------------------------
// Agent Tool
// ---------------------------------------------------------------------------

/**
 * A Nexus Tool that allows the LLM to spawn sub-agents via the
 * AgentCoordinator. When executed it creates a new agent, runs it to
 * completion, and returns the result text.
 */
export function createAgentTool(
  coordinator: AgentCoordinator,
  provider: LLMProvider,
): Tool<AgentToolInput, string> {
  return {
    name: "agent",
    description:
      "Spawn a sub-agent to work on a task in parallel. The sub-agent gets " +
      "its own isolated conversation and tool set. Returns the agent's final " +
      "text output once it completes. Use this to delegate self-contained " +
      "sub-tasks that can be solved independently.",
    inputSchema: AgentToolInputSchema,

    async execute(
      input: AgentToolInput,
      context: ToolContext,
    ): Promise<ToolResult<string>> {
      const agentId = uuid();
      const agentName = input.name ?? `sub-agent-${agentId.slice(0, 8)}`;

      // Spawn the agent
      await coordinator.spawnAgent(
        {
          id: agentId,
          name: agentName,
          model: input.model ?? context.config.defaultModel,
          tools: input.tools,
          parentId: context.agentId,
          isolation: input.isolation,
        },
        provider,
        input.definition,
      );

      // Background mode: launch via BackgroundAgentManager and return immediately
      if (input.background) {
        const bgManager = coordinator.getBackgroundManager();
        const engine = coordinator.getAgentEngine(agentId);
        if (!engine) {
          return { data: `Agent error: failed to get engine for agent "${agentId}"` };
        }
        bgManager.launch(agentId, engine, input.prompt);
        return {
          data: `Agent launched in background (id: ${agentId.slice(0, 8)}). You'll be notified when it completes.`,
        };
      }

      // Run the agent and consume all events.
      // We accumulate text output to return as the result.
      let resultText = "";
      let lastError: string | undefined;

      const generator = coordinator.runAgent(agentId, input.prompt);

      for await (const event of generator) {
        if (context.abortSignal.aborted) {
          coordinator.stopAgent(agentId);
          break;
        }

        switch (event.type) {
          case "text":
            resultText += event.text;
            break;
          case "error":
            lastError = event.error.message;
            break;
        }

        // Report progress for long-running agents
        if (event.type === "turn_end" && context.onProgress) {
          context.onProgress({
            toolUseId: agentId,
            message: `Agent "${agentName}" completed turn (${event.stopReason})`,
          });
        }
      }

      if (lastError && !resultText) {
        return { data: `Agent error: ${lastError}` };
      }

      return {
        data: resultText || "(Agent produced no output)",
      };
    },

    isConcurrencySafe(_input: AgentToolInput): boolean {
      // Agents are fully isolated — safe to run concurrently
      return true;
    },

    isReadOnly(_input: AgentToolInput): boolean {
      // Agents can invoke arbitrary tools with side effects
      return false;
    },

    renderToolUse(input: Partial<AgentToolInput>): string {
      const name = input.name ?? "sub-agent";
      const promptPreview =
        input.prompt && input.prompt.length > 80
          ? input.prompt.slice(0, 80) + "..."
          : input.prompt ?? "";
      return `Spawning agent "${name}": ${promptPreview}`;
    },

    renderResult(output: string): string {
      if (output.length > 200) {
        return output.slice(0, 200) + "... (truncated)";
      }
      return output;
    },
  };
}
