import { v4 as uuid } from "uuid";
import { NexusEngine } from "../core/engine.js";
import type {
  AgentConfig,
  AgentState,
  EngineEvent,
  LLMProvider,
  Message,
  NexusConfig,
  PermissionContext,
  TextBlock,
  TokenUsage,
  Tool,
} from "../types/index.js";

/**
 * AgentCoordinator — manages spawning, tracking, and communication of sub-agents.
 *
 * Each sub-agent runs its own NexusEngine instance with an isolated conversation
 * history. The coordinator tracks parent-child relationships and enforces
 * concurrency limits based on config.maxConcurrentTools.
 */
export class AgentCoordinator {
  private agents: Map<string, ManagedAgent> = new Map();
  private config: NexusConfig;
  private permissions: PermissionContext;
  private tools: Map<string, Tool> = new Map();
  private runningCount = 0;

  /** Messages sent between agents, keyed by recipient agent ID */
  private mailboxes: Map<string, Array<{ from: string; message: string }>> =
    new Map();

  constructor(config: NexusConfig, permissions: PermissionContext) {
    this.config = config;
    this.permissions = permissions;
  }

  // ---------------------------------------------------------------------------
  // Tool Registration (tools available to sub-agents)
  // ---------------------------------------------------------------------------

  /**
   * Register a tool that will be available to newly spawned sub-agents.
   * Only tools whose names appear in AgentConfig.tools will be registered
   * on a given sub-agent's engine. If AgentConfig.tools is omitted, all
   * registered tools are provided.
   */
  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  // ---------------------------------------------------------------------------
  // Agent Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new sub-agent. Returns the agent ID.
   *
   * The agent is created in the "idle" state with its own NexusEngine
   * instance. Tools are filtered according to `config.tools` when provided.
   */
  spawnAgent(config: AgentConfig, provider: LLMProvider): string {
    const id = config.id || uuid();
    const agentConfig: AgentConfig = { ...config, id };

    // Build a per-agent NexusConfig, inheriting defaults from the coordinator
    const engineConfig: NexusConfig = {
      ...this.config,
      defaultModel: config.model || this.config.defaultModel,
    };

    const engine = new NexusEngine(provider, engineConfig, this.permissions);

    // Register tools on the engine, filtering by config.tools when specified
    const allowedTools = config.tools
      ? new Set(config.tools)
      : undefined;

    for (const tool of this.tools.values()) {
      if (!allowedTools || allowedTools.has(tool.name)) {
        engine.registerTool(tool);
      }
    }

    const abortController = new AbortController();

    const state: AgentState = {
      id,
      status: "idle",
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      children: [],
    };

    const managed: ManagedAgent = {
      config: agentConfig,
      engine,
      state,
      abortController,
    };

    this.agents.set(id, managed);

    // Track parent-child relationship
    if (config.parentId) {
      const parent = this.agents.get(config.parentId);
      if (parent) {
        parent.state.children.push(id);
      }
    }

    // Initialize mailbox
    this.mailboxes.set(id, []);

    return id;
  }

  /**
   * Run an agent with a prompt. Yields EngineEvents from the sub-agent's
   * engine. Respects the max concurrency limit derived from
   * config.maxConcurrentTools.
   */
  async *runAgent(id: string, prompt: string): AsyncGenerator<EngineEvent> {
    const managed = this.agents.get(id);
    if (!managed) {
      yield { type: "error", error: new Error(`Agent "${id}" not found`) };
      return;
    }

    // Enforce concurrency limit
    if (this.runningCount >= this.config.maxConcurrentTools) {
      yield {
        type: "error",
        error: new Error(
          `Concurrency limit reached (${this.config.maxConcurrentTools}). ` +
            "Wait for a running agent to finish before spawning more.",
        ),
      };
      return;
    }

    managed.state.status = "running";
    this.runningCount++;

    try {
      const generator = managed.engine.run(prompt, {
        systemPrompt: managed.config.systemPrompt,
        maxTurns: managed.config.maxTurns,
        signal: managed.abortController.signal,
      });

      for await (const event of generator) {
        yield event;

        // Capture final text as the agent result
        if (event.type === "text") {
          // Accumulate text output — last text content becomes the result
          managed.state.result =
            (managed.state.result ?? "") + event.text;
        }
      }

      managed.state.status = "completed";
      managed.state.messages = managed.engine.getMessages();
      managed.state.usage = managed.engine.getUsage();
    } catch (err) {
      managed.state.status = "error";
      managed.state.error =
        err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      this.runningCount--;
    }
  }

  /**
   * Get the state of a specific agent.
   */
  getAgent(id: string): AgentState | undefined {
    return this.agents.get(id)?.state;
  }

  /**
   * List all tracked agent states.
   */
  listAgents(): AgentState[] {
    return Array.from(this.agents.values()).map((m) => m.state);
  }

  /**
   * Abort a running agent.
   */
  stopAgent(id: string): void {
    const managed = this.agents.get(id);
    if (!managed) return;

    managed.abortController.abort();
    if (managed.state.status === "running") {
      managed.state.status = "error";
      managed.state.error = "Agent stopped by coordinator";
    }
  }

  /**
   * Collect completed results from all agents.
   * Returns a map of agentId -> result string.
   */
  collectResults(): Map<string, string> {
    const results = new Map<string, string>();
    for (const [id, managed] of this.agents) {
      if (
        managed.state.status === "completed" &&
        managed.state.result !== undefined
      ) {
        results.set(id, managed.state.result);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Inter-Agent Messaging
  // ---------------------------------------------------------------------------

  /**
   * Send a message from one agent to another.
   */
  sendMessage(fromAgentId: string, toAgentId: string, message: string): void {
    const mailbox = this.mailboxes.get(toAgentId);
    if (!mailbox) {
      throw new Error(`Agent "${toAgentId}" not found`);
    }
    mailbox.push({ from: fromAgentId, message });
  }

  /**
   * Read and drain the mailbox for an agent.
   */
  readMessages(
    agentId: string,
  ): Array<{ from: string; message: string }> {
    const mailbox = this.mailboxes.get(agentId);
    if (!mailbox) return [];
    const messages = [...mailbox];
    mailbox.length = 0;
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface ManagedAgent {
  config: AgentConfig;
  engine: NexusEngine;
  state: AgentState;
  abortController: AbortController;
}
