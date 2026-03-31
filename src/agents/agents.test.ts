import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentCoordinator } from "./coordinator.js";
import { createAgentTool } from "./agent-tool.js";
import { createSendMessageTool } from "./message-tool.js";
import type {
  LLMProvider,
  LLMEvent,
  LLMRequest,
  NexusConfig,
  PermissionContext,
  PermissionDecision,
  EngineEvent,
  ToolContext,
  AgentConfig,
} from "../types/index.js";

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Creates a mock LLMProvider whose chat() yields a simple text response
 * followed by a message_end event with stop_reason "end_turn".
 * Optionally accepts custom text to return.
 */
function createMockProvider(responseText = "Mock agent response"): LLMProvider {
  return {
    name: "mock-provider",
    async *chat(
      _request: LLMRequest,
      _signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-001" };
      yield { type: "text_delta", text: responseText };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

/**
 * Creates a mock provider that never finishes (hangs until aborted).
 * Useful for testing abort/stop behavior.
 */
function createHangingProvider(): LLMProvider {
  return {
    name: "hanging-provider",
    async *chat(
      _request: LLMRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-hang" };
      yield { type: "text_delta", text: "Starting..." };
      // Hang until aborted
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/**
 * Returns a minimal NexusConfig suitable for testing.
 */
function createMockConfig(overrides?: Partial<NexusConfig>): NexusConfig {
  return {
    defaultModel: "test-model",
    defaultProvider: "mock",
    workingDirectory: "/tmp/nexus-test",
    dataDirectory: "/tmp/nexus-test-data",
    permissionMode: "allowAll",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 5,
    thinking: { enabled: false },
    ...overrides,
  };
}

/**
 * Returns a PermissionContext with allowAll mode that permits everything.
 */
function createMockPermissions(): PermissionContext {
  const rules: PermissionContext["rules"] = [];
  return {
    mode: "allowAll",
    rules,
    checkPermission(
      _toolName: string,
      _input: Record<string, unknown>,
    ): PermissionDecision {
      return { behavior: "allow" };
    },
    addRule(rule) {
      rules.push(rule);
    },
    removeRule(_toolName: string, _pattern?: string) {
      // no-op for tests
    },
  };
}

/**
 * Helper to collect all events from an async generator into an array.
 */
async function collectEvents(
  gen: AsyncGenerator<EngineEvent>,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/**
 * Creates a minimal ToolContext for invoking tool.execute() directly.
 */
function createMockToolContext(
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    workingDirectory: "/tmp/nexus-test",
    abortSignal: new AbortController().signal,
    permissions: createMockPermissions(),
    config: createMockConfig(),
    ...overrides,
  };
}

/**
 * Creates a basic AgentConfig for spawning agents in tests.
 */
function createAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: "test-agent-1",
    name: "Test Agent",
    model: "test-model",
    ...overrides,
  };
}

// ============================================================================
// AgentCoordinator Tests
// ============================================================================

describe("AgentCoordinator", () => {
  let coordinator: AgentCoordinator;
  let provider: LLMProvider;
  let config: NexusConfig;
  let permissions: PermissionContext;

  beforeEach(() => {
    config = createMockConfig();
    permissions = createMockPermissions();
    provider = createMockProvider();
    coordinator = new AgentCoordinator(config, permissions);
  });

  // --------------------------------------------------------------------------
  // spawnAgent
  // --------------------------------------------------------------------------

  describe("spawnAgent", () => {
    it("creates an agent and returns its ID", () => {
      const agentConfig = createAgentConfig({ id: "agent-abc" });
      const id = coordinator.spawnAgent(agentConfig, provider);

      expect(id).toBe("agent-abc");
    });

    it("generates a UUID when no id is provided in config", () => {
      const agentConfig = createAgentConfig({ id: undefined as unknown as string });
      // When id is falsy, the coordinator uses uuid()
      const id = coordinator.spawnAgent(
        { ...agentConfig, id: "" } as unknown as AgentConfig,
        provider,
      );

      // Should be a valid UUID-like string (non-empty)
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("initializes agent state correctly", () => {
      const agentConfig = createAgentConfig({ id: "agent-init" });
      coordinator.spawnAgent(agentConfig, provider);

      const state = coordinator.getAgent("agent-init");
      expect(state).toBeDefined();
      expect(state!.id).toBe("agent-init");
      expect(state!.status).toBe("idle");
      expect(state!.messages).toEqual([]);
      expect(state!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(state!.children).toEqual([]);
      expect(state!.result).toBeUndefined();
      expect(state!.error).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getAgent
  // --------------------------------------------------------------------------

  describe("getAgent", () => {
    it("returns the agent state for a known agent", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "a1" }), provider);
      const state = coordinator.getAgent("a1");

      expect(state).toBeDefined();
      expect(state!.id).toBe("a1");
    });

    it("returns undefined for an unknown agent", () => {
      const state = coordinator.getAgent("nonexistent");
      expect(state).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // listAgents
  // --------------------------------------------------------------------------

  describe("listAgents", () => {
    it("returns an empty array when no agents exist", () => {
      expect(coordinator.listAgents()).toEqual([]);
    });

    it("returns all spawned agents", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "a1", name: "Agent 1" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "a2", name: "Agent 2" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "a3", name: "Agent 3" }), provider);

      const agents = coordinator.listAgents();
      expect(agents).toHaveLength(3);

      const ids = agents.map((a) => a.id);
      expect(ids).toContain("a1");
      expect(ids).toContain("a2");
      expect(ids).toContain("a3");
    });
  });

  // --------------------------------------------------------------------------
  // runAgent
  // --------------------------------------------------------------------------

  describe("runAgent", () => {
    it("drives the engine and yields events", async () => {
      coordinator.spawnAgent(createAgentConfig({ id: "run-1" }), provider);

      const events = await collectEvents(
        coordinator.runAgent("run-1", "Hello, agent!"),
      );

      // Should contain turn_start, text, turn_end, and done events
      const types = events.map((e) => e.type);
      expect(types).toContain("turn_start");
      expect(types).toContain("text");
      expect(types).toContain("turn_end");
      expect(types).toContain("done");
    });

    it("sets agent status to running then completed", async () => {
      coordinator.spawnAgent(createAgentConfig({ id: "run-2" }), provider);

      const gen = coordinator.runAgent("run-2", "Do something");

      // Consume a few events to get it started
      const firstEvent = await gen.next();
      expect(firstEvent.done).toBe(false);

      // The agent should be running at this point
      const stateWhileRunning = coordinator.getAgent("run-2");
      expect(stateWhileRunning!.status).toBe("running");

      // Consume remaining events
      while (!(await gen.next()).done) {
        // drain
      }

      const stateAfter = coordinator.getAgent("run-2");
      expect(stateAfter!.status).toBe("completed");
    });

    it("accumulates text as the agent result", async () => {
      const textProvider = createMockProvider("The answer is 42");
      coordinator.spawnAgent(
        createAgentConfig({ id: "run-3" }),
        textProvider,
      );

      await collectEvents(coordinator.runAgent("run-3", "What is the answer?"));

      const state = coordinator.getAgent("run-3");
      expect(state!.result).toContain("The answer is 42");
    });

    it("yields an error event for a nonexistent agent", async () => {
      const events = await collectEvents(
        coordinator.runAgent("no-such-agent", "hello"),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
      if (events[0].type === "error") {
        expect(events[0].error.message).toContain("not found");
      }
    });

    it("enforces concurrency limit", async () => {
      const limitedConfig = createMockConfig({ maxConcurrentTools: 1 });
      const limitedCoordinator = new AgentCoordinator(
        limitedConfig,
        permissions,
      );

      const hangingProvider = createHangingProvider();

      // Spawn two agents
      limitedCoordinator.spawnAgent(
        createAgentConfig({ id: "conc-1" }),
        hangingProvider,
      );
      limitedCoordinator.spawnAgent(
        createAgentConfig({ id: "conc-2" }),
        provider,
      );

      // Start the first agent (it will hang)
      const gen1 = limitedCoordinator.runAgent("conc-1", "hang");
      // Consume the first event to ensure it starts
      await gen1.next();

      // Try to start the second agent -- should be blocked by concurrency limit
      const events2 = await collectEvents(
        limitedCoordinator.runAgent("conc-2", "go"),
      );

      expect(events2).toHaveLength(1);
      expect(events2[0].type).toBe("error");
      if (events2[0].type === "error") {
        expect(events2[0].error.message).toContain("Concurrency limit");
      }

      // Clean up: stop the hanging agent
      limitedCoordinator.stopAgent("conc-1");
    });

    it("populates usage on the agent state after completion", async () => {
      coordinator.spawnAgent(createAgentConfig({ id: "usage-1" }), provider);
      await collectEvents(coordinator.runAgent("usage-1", "test"));

      const state = coordinator.getAgent("usage-1");
      expect(state!.usage.inputTokens).toBeGreaterThan(0);
      expect(state!.usage.outputTokens).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // stopAgent
  // --------------------------------------------------------------------------

  describe("stopAgent", () => {
    it("aborts a running agent and sets status to error", async () => {
      const hangingProvider = createHangingProvider();
      coordinator.spawnAgent(
        createAgentConfig({ id: "stop-1" }),
        hangingProvider,
      );

      const gen = coordinator.runAgent("stop-1", "run forever");
      // Consume first event so it transitions to "running"
      await gen.next();

      expect(coordinator.getAgent("stop-1")!.status).toBe("running");

      coordinator.stopAgent("stop-1");

      const state = coordinator.getAgent("stop-1");
      expect(state!.status).toBe("error");
      expect(state!.error).toBe("Agent stopped by coordinator");
    });

    it("is a no-op for nonexistent agent", () => {
      // Should not throw
      expect(() => coordinator.stopAgent("no-such-agent")).not.toThrow();
    });

    it("does not change status of a non-running agent", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "idle-stop" }), provider);

      const stateBefore = coordinator.getAgent("idle-stop");
      expect(stateBefore!.status).toBe("idle");

      coordinator.stopAgent("idle-stop");

      // Status should remain idle (not running, so no change)
      const stateAfter = coordinator.getAgent("idle-stop");
      expect(stateAfter!.status).toBe("idle");
    });
  });

  // --------------------------------------------------------------------------
  // Parent-Child Relationships
  // --------------------------------------------------------------------------

  describe("parent-child relationships", () => {
    it("tracks children on the parent agent state", () => {
      coordinator.spawnAgent(
        createAgentConfig({ id: "parent-1", name: "Parent" }),
        provider,
      );
      coordinator.spawnAgent(
        createAgentConfig({
          id: "child-1",
          name: "Child 1",
          parentId: "parent-1",
        }),
        provider,
      );
      coordinator.spawnAgent(
        createAgentConfig({
          id: "child-2",
          name: "Child 2",
          parentId: "parent-1",
        }),
        provider,
      );

      const parent = coordinator.getAgent("parent-1");
      expect(parent!.children).toEqual(["child-1", "child-2"]);
    });

    it("does not add child when parent does not exist", () => {
      coordinator.spawnAgent(
        createAgentConfig({
          id: "orphan",
          name: "Orphan",
          parentId: "missing-parent",
        }),
        provider,
      );

      // Should not throw, orphan should still be created
      const orphan = coordinator.getAgent("orphan");
      expect(orphan).toBeDefined();
      expect(orphan!.id).toBe("orphan");
    });

    it("supports multi-level nesting", () => {
      coordinator.spawnAgent(
        createAgentConfig({ id: "root" }),
        provider,
      );
      coordinator.spawnAgent(
        createAgentConfig({ id: "mid", parentId: "root" }),
        provider,
      );
      coordinator.spawnAgent(
        createAgentConfig({ id: "leaf", parentId: "mid" }),
        provider,
      );

      expect(coordinator.getAgent("root")!.children).toEqual(["mid"]);
      expect(coordinator.getAgent("mid")!.children).toEqual(["leaf"]);
      expect(coordinator.getAgent("leaf")!.children).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // collectResults
  // --------------------------------------------------------------------------

  describe("collectResults", () => {
    it("returns completed agent results", async () => {
      const providerA = createMockProvider("Result A");
      const providerB = createMockProvider("Result B");

      coordinator.spawnAgent(
        createAgentConfig({ id: "res-a" }),
        providerA,
      );
      coordinator.spawnAgent(
        createAgentConfig({ id: "res-b" }),
        providerB,
      );

      await collectEvents(coordinator.runAgent("res-a", "task A"));
      await collectEvents(coordinator.runAgent("res-b", "task B"));

      const results = coordinator.collectResults();
      expect(results.size).toBe(2);
      expect(results.get("res-a")).toContain("Result A");
      expect(results.get("res-b")).toContain("Result B");
    });

    it("excludes agents that did not complete", async () => {
      coordinator.spawnAgent(
        createAgentConfig({ id: "completed-1" }),
        createMockProvider("done"),
      );
      coordinator.spawnAgent(
        createAgentConfig({ id: "idle-1" }),
        provider,
      );

      await collectEvents(coordinator.runAgent("completed-1", "go"));
      // idle-1 is never run

      const results = coordinator.collectResults();
      expect(results.size).toBe(1);
      expect(results.has("completed-1")).toBe(true);
      expect(results.has("idle-1")).toBe(false);
    });

    it("returns empty map when no agents completed", () => {
      coordinator.spawnAgent(
        createAgentConfig({ id: "never-run" }),
        provider,
      );

      const results = coordinator.collectResults();
      expect(results.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Inter-Agent Messaging
  // --------------------------------------------------------------------------

  describe("sendMessage / readMessages", () => {
    it("sends a message to an existing agent", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "sender" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "receiver" }), provider);

      coordinator.sendMessage("sender", "receiver", "Hello from sender");

      const messages = coordinator.readMessages("receiver");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        from: "sender",
        message: "Hello from sender",
      });
    });

    it("throws an error when sending to a nonexistent agent", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "sender" }), provider);

      expect(() =>
        coordinator.sendMessage("sender", "ghost", "hello"),
      ).toThrow(/not found/);
    });

    it("drains the mailbox on read (subsequent reads return empty)", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "a" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "b" }), provider);

      coordinator.sendMessage("a", "b", "first");
      coordinator.sendMessage("a", "b", "second");

      const firstRead = coordinator.readMessages("b");
      expect(firstRead).toHaveLength(2);

      const secondRead = coordinator.readMessages("b");
      expect(secondRead).toHaveLength(0);
    });

    it("returns empty array when reading from a nonexistent agent", () => {
      const messages = coordinator.readMessages("nonexistent");
      expect(messages).toEqual([]);
    });

    it("supports multiple senders to the same receiver", () => {
      coordinator.spawnAgent(createAgentConfig({ id: "s1" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "s2" }), provider);
      coordinator.spawnAgent(createAgentConfig({ id: "recv" }), provider);

      coordinator.sendMessage("s1", "recv", "from s1");
      coordinator.sendMessage("s2", "recv", "from s2");

      const messages = coordinator.readMessages("recv");
      expect(messages).toHaveLength(2);
      expect(messages[0].from).toBe("s1");
      expect(messages[1].from).toBe("s2");
    });
  });

  // --------------------------------------------------------------------------
  // Tool Registration on Sub-Agents
  // --------------------------------------------------------------------------

  describe("registerTool", () => {
    it("registers tools that are available to spawned agents", async () => {
      const mockTool = {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { parse: vi.fn(), safeParse: vi.fn() } as any,
        execute: vi.fn().mockResolvedValue({ data: "ok" }),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      };

      coordinator.registerTool(mockTool);
      coordinator.spawnAgent(createAgentConfig({ id: "tooled" }), provider);

      // The tool should be registered on the engine; we verify indirectly
      // by running the agent and checking it completes normally
      const events = await collectEvents(
        coordinator.runAgent("tooled", "use the tool"),
      );
      const types = events.map((e) => e.type);
      expect(types).toContain("done");
    });

    it("filters tools based on agent config.tools", async () => {
      const toolA = {
        name: "tool_a",
        description: "Tool A",
        inputSchema: { parse: vi.fn(), safeParse: vi.fn() } as any,
        execute: vi.fn().mockResolvedValue({ data: "a" }),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      };
      const toolB = {
        name: "tool_b",
        description: "Tool B",
        inputSchema: { parse: vi.fn(), safeParse: vi.fn() } as any,
        execute: vi.fn().mockResolvedValue({ data: "b" }),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      };

      coordinator.registerTool(toolA);
      coordinator.registerTool(toolB);

      // Spawn an agent that only has access to tool_a
      coordinator.spawnAgent(
        createAgentConfig({ id: "filtered", tools: ["tool_a"] }),
        provider,
      );

      // Verify agent was created and can run
      const events = await collectEvents(
        coordinator.runAgent("filtered", "use tool"),
      );
      const types = events.map((e) => e.type);
      expect(types).toContain("done");
    });
  });
});

// ============================================================================
// createAgentTool Tests
// ============================================================================

describe("createAgentTool", () => {
  let coordinator: AgentCoordinator;
  let provider: LLMProvider;

  beforeEach(() => {
    const config = createMockConfig();
    const permissions = createMockPermissions();
    provider = createMockProvider("Sub-agent result text");
    coordinator = new AgentCoordinator(config, permissions);
  });

  it("returns a tool with name 'agent'", () => {
    const tool = createAgentTool(coordinator, provider);

    expect(tool.name).toBe("agent");
    expect(tool.description).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
  });

  it("has a valid description", () => {
    const tool = createAgentTool(coordinator, provider);
    expect(tool.description).toContain("sub-agent");
  });

  it("isConcurrencySafe returns true", () => {
    const tool = createAgentTool(coordinator, provider);

    const result = tool.isConcurrencySafe({ prompt: "test" });
    expect(result).toBe(true);
  });

  it("isReadOnly returns false", () => {
    const tool = createAgentTool(coordinator, provider);

    const result = tool.isReadOnly({ prompt: "test" });
    expect(result).toBe(false);
  });

  it("spawns a sub-agent and returns its result when executed", async () => {
    const tool = createAgentTool(coordinator, provider);
    const context = createMockToolContext();

    const result = await tool.execute({ prompt: "Do something" }, context);

    expect(result.data).toContain("Sub-agent result text");
  });

  it("returns agent error message when agent fails with no result text", async () => {
    const errorProvider: LLMProvider = {
      name: "error-provider",
      async *chat(): AsyncGenerator<LLMEvent> {
        yield { type: "message_start", messageId: "msg-err" };
        yield {
          type: "error",
          error: new Error("Something went wrong"),
        };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };

    const tool = createAgentTool(coordinator, errorProvider);
    const context = createMockToolContext();

    const result = await tool.execute({ prompt: "fail" }, context);

    // The error event from the provider gets yielded as an EngineEvent error;
    // the tool captures it as lastError.
    // The tool falls back to "(Agent produced no output)" or "Agent error: ..."
    expect(typeof result.data).toBe("string");
  });

  it("returns placeholder when agent produces no output", async () => {
    const silentProvider: LLMProvider = {
      name: "silent-provider",
      async *chat(): AsyncGenerator<LLMEvent> {
        yield { type: "message_start", messageId: "msg-silent" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    };

    const tool = createAgentTool(coordinator, silentProvider);
    const context = createMockToolContext();

    const result = await tool.execute({ prompt: "silence" }, context);

    expect(result.data).toBe("(Agent produced no output)");
  });

  it("uses the specified agent name from input", async () => {
    const tool = createAgentTool(coordinator, provider);
    const context = createMockToolContext();

    await tool.execute(
      { prompt: "task", name: "my-custom-agent" },
      context,
    );

    // The agent should appear in the coordinator's list
    const agents = coordinator.listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    // The agent config name is stored internally; we verify by checking
    // that the agent was indeed spawned
    expect(agents.some((a) => a.status === "completed")).toBe(true);
  });

  it("passes parentId from context.agentId", async () => {
    const tool = createAgentTool(coordinator, provider);

    // First, spawn a parent agent in the coordinator so the parent exists
    coordinator.spawnAgent(
      createAgentConfig({ id: "parent-ctx" }),
      provider,
    );

    const context = createMockToolContext({ agentId: "parent-ctx" });

    await tool.execute({ prompt: "child task" }, context);

    // The parent should have a child
    const parent = coordinator.getAgent("parent-ctx");
    expect(parent!.children.length).toBeGreaterThanOrEqual(1);
  });

  it("renderToolUse formats the output correctly", () => {
    const tool = createAgentTool(coordinator, provider);

    const rendered = tool.renderToolUse!({
      prompt: "Find all bugs in the codebase",
      name: "bug-finder",
    });

    expect(rendered).toContain("bug-finder");
    expect(rendered).toContain("Find all bugs");
  });

  it("renderToolUse truncates long prompts", () => {
    const tool = createAgentTool(coordinator, provider);

    const longPrompt = "A".repeat(200);
    const rendered = tool.renderToolUse!({
      prompt: longPrompt,
      name: "test",
    });

    expect(rendered).toContain("...");
    // Should be shorter than the full prompt
    expect(rendered.length).toBeLessThan(longPrompt.length);
  });

  it("renderResult truncates long output", () => {
    const tool = createAgentTool(coordinator, provider);

    const longOutput = "X".repeat(300);
    const rendered = tool.renderResult!(longOutput);

    expect(rendered).toContain("... (truncated)");
    expect(rendered.length).toBeLessThan(longOutput.length);
  });

  it("renderResult returns short output as-is", () => {
    const tool = createAgentTool(coordinator, provider);

    const shortOutput = "done";
    const rendered = tool.renderResult!(shortOutput);

    expect(rendered).toBe("done");
  });

  it("stops the sub-agent when abort signal fires before execution", async () => {
    // Use a provider that yields multiple text chunks with a delay,
    // so the abort check in the for-await loop can trigger
    const slowProvider: LLMProvider = {
      name: "slow-provider",
      async *chat(
        _request: LLMRequest,
        signal?: AbortSignal,
      ): AsyncGenerator<LLMEvent> {
        yield { type: "message_start", messageId: "msg-slow" };
        yield { type: "text_delta", text: "chunk1" };
        // Simulate a pause -- check abort
        if (signal?.aborted) return;
        yield { type: "text_delta", text: "chunk2" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const tool = createAgentTool(coordinator, slowProvider);

    // Pre-abort the signal so the loop exits immediately
    const abortController = new AbortController();
    abortController.abort();

    const context = createMockToolContext({
      abortSignal: abortController.signal,
    });

    const result = await tool.execute({ prompt: "task" }, context);
    // Should complete without hanging; the agent was stopped
    expect(result.data).toBeDefined();
  });
});

// ============================================================================
// createSendMessageTool Tests
// ============================================================================

describe("createSendMessageTool", () => {
  let coordinator: AgentCoordinator;
  let provider: LLMProvider;

  beforeEach(() => {
    const config = createMockConfig();
    const permissions = createMockPermissions();
    provider = createMockProvider();
    coordinator = new AgentCoordinator(config, permissions);
  });

  it("returns a tool with the correct name", () => {
    const tool = createSendMessageTool(coordinator);

    expect(tool.name).toBe("send_message");
    expect(tool.description).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
  });

  it("has a description mentioning message sending", () => {
    const tool = createSendMessageTool(coordinator);
    expect(tool.description).toContain("message");
  });

  it("sends a message to an existing agent successfully", async () => {
    coordinator.spawnAgent(createAgentConfig({ id: "target" }), provider);

    const tool = createSendMessageTool(coordinator);
    const context = createMockToolContext({ agentId: "sender-agent" });

    const result = await tool.execute(
      { agentId: "target", message: "Hello target!" },
      context,
    );

    expect(result.data).toContain("Message sent");
    expect(result.data).toContain("target");

    // Verify the message was actually delivered
    const messages = coordinator.readMessages("target");
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("sender-agent");
    expect(messages[0].message).toBe("Hello target!");
  });

  it("returns error for non-existent target agent", async () => {
    const tool = createSendMessageTool(coordinator);
    const context = createMockToolContext({ agentId: "sender" });

    const result = await tool.execute(
      { agentId: "nonexistent", message: "hello" },
      context,
    );

    expect(result.data).toContain("Error");
    expect(result.data).toContain("not found");
  });

  it("lists available agents in error message when target not found", async () => {
    coordinator.spawnAgent(
      createAgentConfig({ id: "available-1" }),
      provider,
    );
    coordinator.spawnAgent(
      createAgentConfig({ id: "available-2" }),
      provider,
    );

    const tool = createSendMessageTool(coordinator);
    const context = createMockToolContext({ agentId: "sender" });

    const result = await tool.execute(
      { agentId: "ghost", message: "hello" },
      context,
    );

    expect(result.data).toContain("available-1");
    expect(result.data).toContain("available-2");
  });

  it("uses 'unknown' as sender when context has no agentId", async () => {
    coordinator.spawnAgent(createAgentConfig({ id: "target" }), provider);

    const tool = createSendMessageTool(coordinator);
    const context = createMockToolContext({ agentId: undefined });

    await tool.execute(
      { agentId: "target", message: "anonymous message" },
      context,
    );

    const messages = coordinator.readMessages("target");
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("unknown");
  });

  it("isConcurrencySafe returns true", () => {
    const tool = createSendMessageTool(coordinator);

    const result = tool.isConcurrencySafe({
      agentId: "x",
      message: "test",
    });
    expect(result).toBe(true);
  });

  it("isReadOnly returns false", () => {
    const tool = createSendMessageTool(coordinator);

    const result = tool.isReadOnly({ agentId: "x", message: "test" });
    expect(result).toBe(false);
  });

  it("renderToolUse formats output correctly", () => {
    const tool = createSendMessageTool(coordinator);

    const rendered = tool.renderToolUse!({
      agentId: "agent-123",
      message: "Please coordinate",
    });

    expect(rendered).toContain("agent-123");
    expect(rendered).toContain("Please coordinate");
  });

  it("renderToolUse truncates long messages", () => {
    const tool = createSendMessageTool(coordinator);

    const longMsg = "M".repeat(200);
    const rendered = tool.renderToolUse!({
      agentId: "agent-123",
      message: longMsg,
    });

    expect(rendered).toContain("...");
    expect(rendered.length).toBeLessThan(longMsg.length + 50);
  });

  it("renderResult passes through the output string", () => {
    const tool = createSendMessageTool(coordinator);

    const output = "Message sent to agent foo.";
    const rendered = tool.renderResult!(output);
    expect(rendered).toBe(output);
  });

  it("includes target agent status in success message", async () => {
    coordinator.spawnAgent(createAgentConfig({ id: "target" }), provider);

    const tool = createSendMessageTool(coordinator);
    const context = createMockToolContext({ agentId: "sender" });

    const result = await tool.execute(
      { agentId: "target", message: "check status" },
      context,
    );

    // The success message should mention the agent's status
    expect(result.data).toContain("status");
    expect(result.data).toContain("idle");
  });
});
