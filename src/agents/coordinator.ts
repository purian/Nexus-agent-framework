import { v4 as uuid } from "uuid";
import { NexusEngine } from "../core/engine.js";
import { BackgroundAgentManager } from "./background.js";
import type {
  AgentConfig,
  AgentMessage,
  AgentMessageMetadata,
  AgentMessageType,
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
import type { WorktreeManager } from "./worktree.js";
import { AgentDefinitionLoader } from "./definitions.js";
import type { AgentDefinition } from "./definitions.js";

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
  private worktreeManager?: WorktreeManager;
  private definitionLoader: AgentDefinitionLoader = new AgentDefinitionLoader();
  private backgroundManager: BackgroundAgentManager = new BackgroundAgentManager();

  /** Maps agent ID to worktree ID for agents spawned with isolation: "worktree" */
  private agentWorktrees: Map<string, string> = new Map();

  /** Structured message mailboxes, keyed by recipient agent ID */
  private mailboxes: Map<string, AgentMessage[]> = new Map();

  /** Global message history for audit / replay */
  private messageHistory: AgentMessage[] = [];

  /** Auto-incrementing counter for message IDs */
  private messageSeq = 0;

  constructor(
    config: NexusConfig,
    permissions: PermissionContext,
    worktreeManager?: WorktreeManager,
  ) {
    this.config = config;
    this.permissions = permissions;
    this.worktreeManager = worktreeManager;
  }

  /**
   * Get the WorktreeManager instance, if one was provided.
   */
  getWorktreeManager(): WorktreeManager | undefined {
    return this.worktreeManager;
  }

  // ---------------------------------------------------------------------------
  // Agent Definitions
  // ---------------------------------------------------------------------------

  /**
   * Load agent definitions from project and global directories.
   */
  loadDefinitions(projectDir: string): AgentDefinition[] {
    return this.definitionLoader.loadDefinitions(projectDir);
  }

  /**
   * List all loaded agent definitions.
   */
  listDefinitions(): AgentDefinition[] {
    return Array.from(this.definitionLoader["definitions"].values());
  }

  /**
   * Get a single agent definition by name.
   */
  getDefinition(name: string): AgentDefinition | undefined {
    return this.definitionLoader.getDefinition(name);
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
   *
   * When `definitionName` is provided, the matching AgentDefinition's
   * systemPrompt, tools, model, maxTurns, and temperature are applied
   * (config fields take precedence over definition defaults).
   *
   * When `config.isolation` is `"worktree"`, a git worktree is created
   * and the agent's working directory is set to the worktree path.
   */
  async spawnAgent(
    config: AgentConfig,
    provider: LLMProvider,
    definitionName?: string,
  ): Promise<string> {
    const id = config.id || uuid();
    let agentConfig: AgentConfig = { ...config, id };

    // Apply agent definition overrides when a definition name is provided
    if (definitionName) {
      const definition = this.definitionLoader.getDefinition(definitionName);
      if (definition) {
        agentConfig = {
          ...agentConfig,
          systemPrompt: agentConfig.systemPrompt ?? definition.systemPrompt,
          tools: agentConfig.tools ?? definition.tools,
          model: agentConfig.model || definition.model || agentConfig.model,
          maxTurns: agentConfig.maxTurns ?? definition.maxTurns,
        };
      }
    }

    // Build a per-agent NexusConfig, inheriting defaults from the coordinator
    const engineConfig: NexusConfig = {
      ...this.config,
      defaultModel: agentConfig.model || this.config.defaultModel,
    };

    // If worktree isolation is requested and a manager is available, create one
    if (config.isolation === "worktree" && this.worktreeManager) {
      const worktreeInfo = await this.worktreeManager.create({ agentId: id });
      engineConfig.workingDirectory = worktreeInfo.path;
      this.agentWorktrees.set(id, worktreeInfo.id);
    }

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

      // Handle worktree cleanup for isolated agents
      await this.handleWorktreeCompletion(id, managed.state);
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
   * Get the NexusEngine for a specific agent (used by background agent launching).
   */
  getAgentEngine(id: string): NexusEngine | undefined {
    return this.agents.get(id)?.engine;
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
   * Send a plain-text message from one agent to another.
   * Backward-compatible convenience wrapper around sendStructuredMessage.
   */
  sendMessage(fromAgentId: string, toAgentId: string, message: string): void {
    this.sendStructuredMessage(fromAgentId, toAgentId, {
      type: "notification",
      payload: message,
    });
  }

  /**
   * Read and drain the mailbox for an agent.
   * Backward-compatible — returns the legacy { from, message } shape.
   */
  readMessages(
    agentId: string,
  ): Array<{ from: string; message: string }> {
    const structured = this.readStructuredMessages(agentId);
    return structured.map((m) => ({
      from: m.from,
      message: typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload),
    }));
  }

  /**
   * Send a structured message from one agent to another.
   * Returns the generated message ID.
   */
  sendStructuredMessage(
    fromAgentId: string,
    toAgentId: string,
    options: {
      type?: AgentMessageType;
      payload: unknown;
      metadata?: AgentMessageMetadata;
    },
  ): string {
    const mailbox = this.mailboxes.get(toAgentId);
    if (!mailbox) {
      throw new Error(`Agent "${toAgentId}" not found`);
    }

    const id = `msg-${++this.messageSeq}`;
    const msg: AgentMessage = {
      id,
      from: fromAgentId,
      to: toAgentId,
      type: options.type ?? "notification",
      payload: options.payload,
      metadata: options.metadata ?? {},
      timestamp: new Date().toISOString(),
      status: "delivered",
    };

    mailbox.push(msg);
    this.messageHistory.push(msg);
    return id;
  }

  /**
   * Broadcast a message to all agents (except the sender).
   * Returns the generated message IDs.
   */
  broadcastMessage(
    fromAgentId: string,
    payload: unknown,
    metadata?: AgentMessageMetadata,
  ): string[] {
    const ids: string[] = [];
    for (const [agentId] of this.mailboxes) {
      if (agentId !== fromAgentId) {
        const id = this.sendStructuredMessage(fromAgentId, agentId, {
          type: "broadcast",
          payload,
          metadata,
        });
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Read and drain structured messages for an agent.
   * Optionally filter by message type or tags.
   */
  readStructuredMessages(
    agentId: string,
    filter?: { type?: AgentMessageType; tag?: string },
  ): AgentMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    if (!mailbox) return [];

    let matched: AgentMessage[];
    let remaining: AgentMessage[];

    if (filter) {
      matched = [];
      remaining = [];
      for (const msg of mailbox) {
        const typeMatch = !filter.type || msg.type === filter.type;
        const tagMatch =
          !filter.tag || (msg.metadata.tags?.includes(filter.tag) ?? false);
        if (typeMatch && tagMatch) {
          msg.status = "read";
          matched.push(msg);
        } else {
          remaining.push(msg);
        }
      }
      mailbox.length = 0;
      mailbox.push(...remaining);
    } else {
      matched = [...mailbox];
      for (const msg of matched) {
        msg.status = "read";
      }
      mailbox.length = 0;
    }

    return matched;
  }

  /**
   * Peek at messages without draining the mailbox.
   */
  peekMessages(
    agentId: string,
    filter?: { type?: AgentMessageType; tag?: string },
  ): AgentMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    if (!mailbox) return [];

    if (!filter) return [...mailbox];

    return mailbox.filter((msg) => {
      const typeMatch = !filter.type || msg.type === filter.type;
      const tagMatch =
        !filter.tag || (msg.metadata.tags?.includes(filter.tag) ?? false);
      return typeMatch && tagMatch;
    });
  }

  /**
   * Get the full message history (all messages ever sent), optionally
   * filtered by agent ID (as sender or recipient).
   */
  getMessageHistory(agentId?: string, limit?: number): AgentMessage[] {
    let history = this.messageHistory;
    if (agentId) {
      history = history.filter(
        (m) => m.from === agentId || m.to === agentId,
      );
    }
    if (limit !== undefined) {
      history = history.slice(-limit);
    }
    return history;
  }

  // ---------------------------------------------------------------------------
  // Background Agents
  // ---------------------------------------------------------------------------

  /**
   * Run an agent in the background. Spawns the agent and launches it
   * via the BackgroundAgentManager so execution happens asynchronously.
   * Returns the agent ID immediately.
   */
  async runAgentInBackground(
    id: string,
    prompt: string,
    provider: LLMProvider,
  ): Promise<string> {
    // Spawn the agent normally to get its engine set up
    const agentId = await this.spawnAgent({ id, name: id, model: this.config.defaultModel }, provider);

    const managed = this.agents.get(agentId);
    if (!managed) {
      throw new Error(`Failed to spawn background agent "${agentId}"`);
    }

    // Launch via the background manager (fire-and-forget)
    return this.backgroundManager.launch(agentId, managed.engine, prompt);
  }

  /**
   * Get the BackgroundAgentManager instance.
   */
  getBackgroundManager(): BackgroundAgentManager {
    return this.backgroundManager;
  }

  // ---------------------------------------------------------------------------
  // Worktree Helpers
  // ---------------------------------------------------------------------------

  /**
   * After an agent completes or is stopped, check its worktree for changes.
   * If no changes, auto-remove the worktree. If changes exist, keep it and
   * append the worktree path + branch to the agent result.
   */
  private async handleWorktreeCompletion(
    agentId: string,
    state: AgentState,
  ): Promise<void> {
    const worktreeId = this.agentWorktrees.get(agentId);
    if (!worktreeId || !this.worktreeManager) return;

    const info = this.worktreeManager.get(worktreeId);
    if (!info) return;

    try {
      const hasChanges = await this.worktreeManager.hasChanges(worktreeId);

      if (!hasChanges) {
        // No changes — clean up the worktree
        await this.worktreeManager.remove(worktreeId);
        this.agentWorktrees.delete(agentId);
      } else {
        // Changes exist — keep the worktree and report it
        const suffix =
          `\n[worktree] Changes preserved in branch "${info.branch}" at ${info.path}`;
        state.result = (state.result ?? "") + suffix;
      }
    } catch {
      // Best-effort — don't fail the agent result because of worktree cleanup
    }
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
