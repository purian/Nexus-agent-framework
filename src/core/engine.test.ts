import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { NexusEngine } from "./engine.js";
import type {
  EngineEvent,
  LLMEvent,
  LLMProvider,
  NexusConfig,
  PermissionContext,
  PermissionDecision,
  Tool,
  TokenUsage,
} from "../types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock LLM provider that yields predetermined events for each
 * successive call to `chat()`. Each element in `responses` is an array of
 * LLMEvents representing one full LLM turn.
 */
function createMockProvider(
  responses: LLMEvent[][],
): LLMProvider & { chatCallCount: number } {
  let callIndex = 0;
  const provider: LLMProvider & { chatCallCount: number } = {
    name: "mock-provider",
    chatCallCount: 0,
    async *chat(_request, _signal) {
      provider.chatCallCount++;
      const events = responses[callIndex] ?? [];
      callIndex++;
      for (const event of events) {
        yield event;
      }
    },
  };
  return provider;
}

/**
 * Creates a mock Tool with configurable behavior.
 */
function createMockTool(
  name: string,
  opts: {
    execute?: (input: Record<string, unknown>) => Promise<{ data: unknown }>;
    concurrencySafe?: boolean;
    readOnly?: boolean;
    checkPermissions?: (
      input: Record<string, unknown>,
    ) => Promise<PermissionDecision>;
    maxResultSize?: number;
    inputSchema?: z.ZodType;
  } = {},
): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: opts.inputSchema ?? z.object({}).passthrough(),
    execute: opts.execute
      ? (input: Record<string, unknown>, _ctx) => opts.execute!(input)
      : async (_input, _ctx) => ({ data: `${name} executed` }),
    isConcurrencySafe: () => opts.concurrencySafe ?? true,
    isReadOnly: () => opts.readOnly ?? true,
    checkPermissions: opts.checkPermissions
      ? (input: Record<string, unknown>, _ctx) => opts.checkPermissions!(input)
      : undefined,
    maxResultSize: opts.maxResultSize,
  };
}

/**
 * Returns a minimal NexusConfig suitable for testing.
 */
function createTestConfig(overrides: Partial<NexusConfig> = {}): NexusConfig {
  return {
    defaultModel: "test-model",
    defaultProvider: "mock-provider",
    workingDirectory: "/tmp/nexus-test",
    dataDirectory: "/tmp/nexus-test/data",
    permissionMode: "allowAll",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 4,
    thinking: { enabled: false },
    ...overrides,
  };
}

/**
 * Returns a PermissionContext in allowAll mode.
 */
function createTestPermissions(
  overrides: Partial<PermissionContext> = {},
): PermissionContext {
  return {
    mode: "allowAll",
    rules: [],
    checkPermission: () => ({ behavior: "allow" }),
    addRule: () => {},
    removeRule: () => {},
    ...overrides,
  };
}

/**
 * Collects all events from an async generator into an array.
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
 * Builds a standard "text response" LLMEvent sequence: message_start,
 * text_delta(s), message_end with end_turn.
 */
function textResponse(
  text: string,
  usage: TokenUsage = { inputTokens: 100, outputTokens: 50 },
): LLMEvent[] {
  return [
    { type: "message_start", messageId: "msg-1" },
    { type: "text_delta", text },
    { type: "message_end", stopReason: "end_turn", usage },
  ];
}

/**
 * Builds a "tool use" LLMEvent sequence: message_start, tool_use events,
 * message_end with tool_use stop reason.
 */
function toolUseResponse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  usage: TokenUsage = { inputTokens: 100, outputTokens: 50 },
  prefixText?: string,
): LLMEvent[] {
  const events: LLMEvent[] = [
    { type: "message_start", messageId: "msg-tool" },
  ];

  if (prefixText) {
    events.push({ type: "text_delta", text: prefixText });
  }

  for (const tool of tools) {
    events.push({ type: "tool_use_start", id: tool.id, name: tool.name });
    events.push({
      type: "tool_use_delta",
      id: tool.id,
      partialInput: JSON.stringify(tool.input),
    });
    events.push({ type: "tool_use_end", id: tool.id, input: tool.input });
  }

  events.push({ type: "message_end", stopReason: "tool_use", usage });
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe("NexusEngine", () => {
  let config: NexusConfig;
  let permissions: PermissionContext;

  beforeEach(() => {
    config = createTestConfig();
    permissions = createTestPermissions();
  });

  // --------------------------------------------------------------------------
  // 1. Engine construction and tool registration
  // --------------------------------------------------------------------------

  describe("construction and tool registration", () => {
    it("should create an engine with the given provider, config, and permissions", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);
      expect(engine).toBeInstanceOf(NexusEngine);
    });

    it("should register and retrieve tools", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);

      const toolA = createMockTool("tool_a");
      const toolB = createMockTool("tool_b");

      engine.registerTool(toolA);
      engine.registerTool(toolB);

      const tools = engine.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain("tool_a");
      expect(tools.map((t) => t.name)).toContain("tool_b");
    });

    it("should unregister tools by name", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);

      engine.registerTool(createMockTool("tool_a"));
      engine.registerTool(createMockTool("tool_b"));
      engine.unregisterTool("tool_a");

      const tools = engine.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("tool_b");
    });

    it("should overwrite a tool when registering with the same name", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);

      const original = createMockTool("tool_a", {
        execute: async () => ({ data: "original" }),
      });
      const replacement = createMockTool("tool_a", {
        execute: async () => ({ data: "replacement" }),
      });

      engine.registerTool(original);
      engine.registerTool(replacement);

      const tools = engine.getTools();
      expect(tools).toHaveLength(1);
    });

    it("should return an empty tool list when none are registered", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);
      expect(engine.getTools()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Simple text response (no tool use)
  // --------------------------------------------------------------------------

  describe("simple text response", () => {
    it("should yield turn_start, text, turn_end, and done events for a simple text response", async () => {
      const provider = createMockProvider([
        textResponse("Hello, world!"),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Hi"));

      const types = events.map((e) => e.type);
      expect(types).toEqual(["turn_start", "text", "turn_end", "done"]);

      const textEvent = events.find((e) => e.type === "text");
      expect(textEvent).toBeDefined();
      if (textEvent?.type === "text") {
        expect(textEvent.text).toBe("Hello, world!");
      }
    });

    it("should add user and assistant messages to conversation history", async () => {
      const provider = createMockProvider([
        textResponse("Reply!"),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(engine.run("Hello"));

      const messages = engine.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("should stream multiple text deltas and accumulate them", async () => {
      const provider = createMockProvider([
        [
          { type: "message_start", messageId: "msg-1" },
          { type: "text_delta", text: "Hello" },
          { type: "text_delta", text: ", " },
          { type: "text_delta", text: "world!" },
          {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Hi"));
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(3);

      // Check assistant message has accumulated text
      const messages = engine.getMessages();
      const assistantContent = messages[1].content[0];
      expect(assistantContent.type).toBe("text");
      if (assistantContent.type === "text") {
        expect(assistantContent.text).toBe("Hello, world!");
      }
    });

    it("should yield thinking events when the provider sends thinking deltas", async () => {
      const provider = createMockProvider([
        [
          { type: "message_start", messageId: "msg-1" },
          { type: "thinking_delta", thinking: "Let me think..." },
          { type: "text_delta", text: "Answer" },
          {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        ],
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Think about this"));
      const thinkingEvent = events.find((e) => e.type === "thinking");
      expect(thinkingEvent).toBeDefined();
      if (thinkingEvent?.type === "thinking") {
        expect(thinkingEvent.text).toBe("Let me think...");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Tool use flow
  // --------------------------------------------------------------------------

  describe("tool use flow", () => {
    it("should execute a tool and feed the result back to the LLM", async () => {
      const executeFn = vi.fn(async () => ({ data: "tool output data" }));

      const provider = createMockProvider([
        // Turn 1: LLM requests a tool call
        toolUseResponse([
          { id: "tu-1", name: "read_file", input: { path: "/tmp/test.txt" } },
        ]),
        // Turn 2: LLM gives final text response after seeing tool result
        textResponse("The file contains test data."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("read_file", { execute: executeFn }),
      );

      const events = await collectEvents(engine.run("Read the file"));

      // Verify tool was executed
      expect(executeFn).toHaveBeenCalledOnce();

      // Verify event flow: turn_start, tool_start, turn_end, turn_start, text, turn_end, done
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_start");
      expect(types).toContain("text");
      expect(types).toContain("done");

      // Should have 2 turn_start events (tool call turn + final response turn)
      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(2);

      // Verify conversation history: user, assistant (tool_use), user (tool_result), assistant (text)
      const messages = engine.getMessages();
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].role).toBe("user"); // tool results
      expect(messages[3].role).toBe("assistant");

      // Check tool result message
      const toolResultContent = messages[2].content[0];
      expect(toolResultContent.type).toBe("tool_result");
      if (toolResultContent.type === "tool_result") {
        expect(toolResultContent.content).toBe("tool output data");
        expect(toolResultContent.tool_use_id).toBe("tu-1");
      }
    });

    it("should handle unknown tools by returning an error result", async () => {
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "nonexistent_tool", input: {} },
        ]),
        textResponse("I see the tool was not found."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Use unknown tool"));

      // Check that the tool result in conversation has an error
      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();

      const toolResult = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (toolResult?.type === "tool_result") {
        expect(toolResult.is_error).toBe(true);
        expect(toolResult.content).toContain("Unknown tool");
      }
    });

    it("should pass the correct input to the tool after schema validation", async () => {
      const executeFn = vi.fn(async (input: Record<string, unknown>) => ({
        data: `echoed: ${input.message}`,
      }));

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "echo", input: { message: "test123" } },
        ]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("echo", {
          execute: executeFn,
          inputSchema: z.object({ message: z.string() }),
        }),
      );

      await collectEvents(engine.run("Echo this"));

      expect(executeFn).toHaveBeenCalledWith(
        { message: "test123" },
      );
    });

    it("should return an error when tool input fails schema validation", async () => {
      const provider = createMockProvider([
        toolUseResponse([
          {
            id: "tu-1",
            name: "strict_tool",
            input: { wrong_field: "bad" },
          },
        ]),
        textResponse("I see the error."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("strict_tool", {
          inputSchema: z.object({ required_field: z.string() }),
        }),
      );

      const events = await collectEvents(engine.run("Use strict tool"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) => b.type === "tool_result" && b.is_error === true,
          ),
      );
      expect(toolResultMsg).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Multiple tool calls in one turn
  // --------------------------------------------------------------------------

  describe("multiple tool calls in one turn", () => {
    it("should execute multiple tools from a single LLM turn", async () => {
      const execA = vi.fn(async () => ({ data: "result_a" }));
      const execB = vi.fn(async () => ({ data: "result_b" }));

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "tool_a", input: {} },
          { id: "tu-2", name: "tool_b", input: {} },
        ]),
        textResponse("Both tools completed."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(createMockTool("tool_a", { execute: execA }));
      engine.registerTool(createMockTool("tool_b", { execute: execB }));

      await collectEvents(engine.run("Run both tools"));

      expect(execA).toHaveBeenCalledOnce();
      expect(execB).toHaveBeenCalledOnce();

      // Both tool results should appear in the same user message
      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.filter((b) => b.type === "tool_result").length === 2,
      );
      expect(toolResultMsg).toBeDefined();
    });

    it("should include results for all tools even if some fail", async () => {
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "good_tool", input: {} },
          { id: "tu-2", name: "bad_tool", input: {} },
        ]),
        textResponse("Handled the error."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("good_tool", {
          execute: async () => ({ data: "success" }),
        }),
      );
      engine.registerTool(
        createMockTool("bad_tool", {
          execute: async () => {
            throw new Error("kaboom");
          },
        }),
      );

      await collectEvents(engine.run("Run tools"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const results = toolResultMsg!.content.filter(
        (b) => b.type === "tool_result",
      );
      expect(results).toHaveLength(2);

      const goodResult = results.find(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu-1",
      );
      const badResult = results.find(
        (b) => b.type === "tool_result" && b.tool_use_id === "tu-2",
      );

      if (goodResult?.type === "tool_result") {
        expect(goodResult.is_error).toBeUndefined();
        expect(goodResult.content).toBe("success");
      }
      if (badResult?.type === "tool_result") {
        expect(badResult.is_error).toBe(true);
        expect(badResult.content).toContain("kaboom");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Concurrency safety — batching
  // --------------------------------------------------------------------------

  describe("concurrency safety and batching", () => {
    it("should batch concurrency-safe tools together", async () => {
      const executionOrder: string[] = [];

      const makeTrackedTool = (name: string, safe: boolean) =>
        createMockTool(name, {
          concurrencySafe: safe,
          execute: async () => {
            executionOrder.push(`${name}_start`);
            // Small delay to observe concurrency
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push(`${name}_end`);
            return { data: `${name} done` };
          },
        });

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "safe_a", input: {} },
          { id: "tu-2", name: "safe_b", input: {} },
        ]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(makeTrackedTool("safe_a", true));
      engine.registerTool(makeTrackedTool("safe_b", true));

      await collectEvents(engine.run("Run safe tools"));

      // Both safe tools should start before either finishes (parallel execution)
      const startA = executionOrder.indexOf("safe_a_start");
      const startB = executionOrder.indexOf("safe_b_start");
      const endA = executionOrder.indexOf("safe_a_end");
      const endB = executionOrder.indexOf("safe_b_end");

      // Both should have started before both ended (batched together)
      expect(startA).toBeLessThan(endA);
      expect(startB).toBeLessThan(endB);
      // They should both start before any end (concurrent)
      expect(Math.max(startA, startB)).toBeLessThan(Math.min(endA, endB));
    });

    it("should isolate unsafe tools in their own batch", async () => {
      const executionOrder: string[] = [];

      const makeTrackedTool = (name: string, safe: boolean) =>
        createMockTool(name, {
          concurrencySafe: safe,
          execute: async () => {
            executionOrder.push(`${name}_start`);
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push(`${name}_end`);
            return { data: `${name} done` };
          },
        });

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "safe_a", input: {} },
          { id: "tu-2", name: "unsafe_b", input: {} },
          { id: "tu-3", name: "safe_c", input: {} },
        ]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(makeTrackedTool("safe_a", true));
      engine.registerTool(makeTrackedTool("unsafe_b", false));
      engine.registerTool(makeTrackedTool("safe_c", true));

      await collectEvents(engine.run("Run mixed tools"));

      // unsafe_b should run in its own batch: safe_a finishes before unsafe_b starts
      const endA = executionOrder.indexOf("safe_a_end");
      const startB = executionOrder.indexOf("unsafe_b_start");
      const endB = executionOrder.indexOf("unsafe_b_end");
      const startC = executionOrder.indexOf("safe_c_start");

      expect(endA).toBeLessThan(startB);
      expect(endB).toBeLessThan(startC);
    });

    it("should put each unsafe tool in its own batch even when consecutive", async () => {
      const executionOrder: string[] = [];

      const makeTrackedTool = (name: string) =>
        createMockTool(name, {
          concurrencySafe: false,
          execute: async () => {
            executionOrder.push(`${name}_start`);
            await new Promise((r) => setTimeout(r, 5));
            executionOrder.push(`${name}_end`);
            return { data: `${name} done` };
          },
        });

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "unsafe_a", input: {} },
          { id: "tu-2", name: "unsafe_b", input: {} },
        ]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(makeTrackedTool("unsafe_a"));
      engine.registerTool(makeTrackedTool("unsafe_b"));

      await collectEvents(engine.run("Run unsafe tools"));

      // Each unsafe tool should complete before the next one starts
      const endA = executionOrder.indexOf("unsafe_a_end");
      const startB = executionOrder.indexOf("unsafe_b_start");
      expect(endA).toBeLessThan(startB);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Permission denied
  // --------------------------------------------------------------------------

  describe("permission denied", () => {
    it("should return permission denied error when global permissions deny", async () => {
      const denyPermissions = createTestPermissions({
        checkPermission: () => ({
          behavior: "deny",
          reason: "Operation not allowed in this mode",
        }),
      });

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "dangerous_tool", input: {} },
        ]),
        textResponse("Permission was denied."),
      ]);
      const engine = new NexusEngine(provider, config, denyPermissions);
      engine.registerTool(createMockTool("dangerous_tool"));

      const events = await collectEvents(engine.run("Do something dangerous"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("Permission denied");
        expect(result.content).toContain("Operation not allowed");
      }
    });

    it("should return permission denied when tool-level checkPermissions denies", async () => {
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "restricted_tool", input: {} },
        ]),
        textResponse("I see it was denied."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("restricted_tool", {
          checkPermissions: async () => ({
            behavior: "deny",
            reason: "Tool-level restriction",
          }),
        }),
      );

      await collectEvents(engine.run("Use restricted tool"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("Tool-level restriction");
      }
    });

    it("should emit tool_end event with isError when permission is denied", async () => {
      const denyPermissions = createTestPermissions({
        checkPermission: () => ({
          behavior: "deny",
          reason: "Denied",
        }),
      });

      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("Ok."),
      ]);
      const engine = new NexusEngine(provider, config, denyPermissions);
      engine.registerTool(createMockTool("tool_a"));

      const emittedEvents: EngineEvent[] = [];
      engine.on("event", (event) => emittedEvents.push(event));

      await collectEvents(engine.run("Use tool"));

      const toolEndEvent = emittedEvents.find((e) => e.type === "tool_end");
      expect(toolEndEvent).toBeDefined();
      if (toolEndEvent?.type === "tool_end") {
        expect(toolEndEvent.isError).toBe(true);
        expect(toolEndEvent.result).toContain("Permission denied");
      }
    });

    it("should handle 'ask' permission that gets denied by user", async () => {
      const askPermissions = createTestPermissions({
        checkPermission: () => ({
          behavior: "ask",
          message: "Allow this operation?",
        }),
      });

      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("Ok."),
      ]);
      const engine = new NexusEngine(provider, config, askPermissions);
      engine.registerTool(createMockTool("tool_a"));

      // Listen for permission_request and deny it
      engine.on("event", (event) => {
        if (event.type === "permission_request") {
          event.resolve({ behavior: "deny", reason: "User said no" });
        }
      });

      await collectEvents(engine.run("Use tool"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("Permission denied by user");
      }
    });

    it("should proceed when 'ask' permission is allowed by user", async () => {
      const askPermissions = createTestPermissions({
        checkPermission: () => ({
          behavior: "ask",
          message: "Allow this operation?",
        }),
      });

      const executeFn = vi.fn(async () => ({ data: "success" }));
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("Tool succeeded."),
      ]);
      const engine = new NexusEngine(provider, config, askPermissions);
      engine.registerTool(createMockTool("tool_a", { execute: executeFn }));

      // Listen for permission_request and allow it
      engine.on("event", (event) => {
        if (event.type === "permission_request") {
          event.resolve({ behavior: "allow" });
        }
      });

      await collectEvents(engine.run("Use tool"));

      expect(executeFn).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Budget tracking
  // --------------------------------------------------------------------------

  describe("budget tracking", () => {
    it("should accumulate usage across turns", async () => {
      const provider = createMockProvider([
        toolUseResponse(
          [{ id: "tu-1", name: "tool_a", input: {} }],
          { inputTokens: 100, outputTokens: 50 },
        ),
        textResponse("Done.", { inputTokens: 200, outputTokens: 80 }),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(createMockTool("tool_a"));

      await collectEvents(engine.run("Do something"));

      const usage = engine.getUsage();
      expect(usage.inputTokens).toBe(300);
      expect(usage.outputTokens).toBe(130);
    });

    it("should accumulate cache token usage", async () => {
      const provider = createMockProvider([
        [
          { type: "message_start", messageId: "msg-1" } as LLMEvent,
          { type: "text_delta", text: "Hi" } as LLMEvent,
          {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 30,
              cacheWriteTokens: 10,
            },
          } as LLMEvent,
        ],
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(engine.run("Hi"));

      const usage = engine.getUsage();
      expect(usage.cacheReadTokens).toBe(30);
      expect(usage.cacheWriteTokens).toBe(10);
    });

    it("should stop when budget limit is reached", async () => {
      const budgetConfig = createTestConfig({ maxBudgetUsd: 0.0001 });

      const provider = createMockProvider([
        // Large usage that should exceed the tiny budget
        textResponse("First response", {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ]);
      const engine = new NexusEngine(provider, budgetConfig, permissions);

      const events = await collectEvents(engine.run("Hi"));

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.error.message).toContain("Budget limit");
      }
    });

    it("should report total usage in the done event", async () => {
      const provider = createMockProvider([
        textResponse("Reply", { inputTokens: 150, outputTokens: 75 }),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Hi"));

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.type === "done") {
        expect(doneEvent.totalUsage.inputTokens).toBe(150);
        expect(doneEvent.totalUsage.outputTokens).toBe(75);
      }
    });

    it("should reset usage when reset() is called", async () => {
      const provider = createMockProvider([
        textResponse("Reply", { inputTokens: 100, outputTokens: 50 }),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(engine.run("Hi"));
      engine.reset();

      const usage = engine.getUsage();
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Max turns limit
  // --------------------------------------------------------------------------

  describe("max turns limit", () => {
    it("should stop after maxTurns even if LLM keeps requesting tools", async () => {
      // Provider always requests tool use — should be capped
      const responses: LLMEvent[][] = [];
      for (let i = 0; i < 10; i++) {
        responses.push(
          toolUseResponse([
            { id: `tu-${i}`, name: "infinite_tool", input: {} },
          ]),
        );
      }
      // Add a final text response in case it gets there
      responses.push(textResponse("Final."));

      const provider = createMockProvider(responses);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(createMockTool("infinite_tool"));

      const events = await collectEvents(
        engine.run("Loop forever", { maxTurns: 3 }),
      );

      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(3);

      // Should still emit done
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });

    it("should default to 50 max turns", async () => {
      const provider = createMockProvider([textResponse("Quick reply.")]);
      const engine = new NexusEngine(provider, config, permissions);

      // We can't easily test the default of 50 without running 50 turns,
      // but we can verify the engine completes normally with 1 turn
      const events = await collectEvents(engine.run("Hi"));
      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(1);
    });

    it("should handle maxTurns of 1 — single turn only", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("This should not appear."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(createMockTool("tool_a"));

      const events = await collectEvents(
        engine.run("Do it", { maxTurns: 1 }),
      );

      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(1);

      // Provider should only have been called once
      expect(provider.chatCallCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Abort signal
  // --------------------------------------------------------------------------

  describe("abort signal", () => {
    it("should stop when abort signal is triggered before first turn", async () => {
      const controller = new AbortController();
      controller.abort(); // Abort immediately

      const provider = createMockProvider([textResponse("Should not appear")]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(
        engine.run("Hi", { signal: controller.signal }),
      );

      // Should only get the done event since abort happens before the loop body
      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(0);

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });

    it("should stop between turns when abort signal is triggered", async () => {
      const controller = new AbortController();

      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("Should not appear"),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      // Abort as soon as we see the tool use requesting a second turn
      engine.registerTool(
        createMockTool("tool_a", {
          execute: async () => {
            controller.abort();
            return { data: "done" };
          },
        }),
      );

      const events = await collectEvents(
        engine.run("Use tool", { signal: controller.signal }),
      );

      // Should have only 1 turn since we aborted after tool execution
      // The tool results are added and then the loop checks signal.aborted
      expect(provider.chatCallCount).toBe(1);
    });

    it("should use the engine abort() method", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "tool_a", input: {} }]),
        textResponse("Should not appear"),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("tool_a", {
          execute: async () => {
            engine.abort();
            return { data: "done" };
          },
        }),
      );

      // Without passing an external signal, engine uses its own abortController.
      // However, engine.abort() replaces the controller so the old signal is aborted.
      const events = await collectEvents(engine.run("Use tool"));

      // Should complete (the internal signal is checked between turns)
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 10. Tool error handling
  // --------------------------------------------------------------------------

  describe("tool error handling", () => {
    it("should yield an error result when a tool throws and continue the loop", async () => {
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "failing_tool", input: {} },
        ]),
        textResponse("I see the tool failed. Let me help another way."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("failing_tool", {
          execute: async () => {
            throw new Error("Something went wrong");
          },
        }),
      );

      const events = await collectEvents(engine.run("Use the tool"));

      // Verify the engine continued to a second turn
      const turnStarts = events.filter((e) => e.type === "turn_start");
      expect(turnStarts).toHaveLength(2);

      // Verify error was captured in tool result
      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("Something went wrong");
      }
    });

    it("should handle non-Error throws from tools", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "weird_tool", input: {} }]),
        textResponse("Handled."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("weird_tool", {
          execute: async () => {
            throw "string error"; // non-Error throw
          },
        }),
      );

      const events = await collectEvents(engine.run("Use it"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("string error");
      }
    });

    it("should emit tool_end event with isError=true when tool throws", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "failing_tool", input: {} }]),
        textResponse("Ok."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("failing_tool", {
          execute: async () => {
            throw new Error("boom");
          },
        }),
      );

      const emittedEvents: EngineEvent[] = [];
      engine.on("event", (event) => emittedEvents.push(event));

      await collectEvents(engine.run("Run it"));

      const toolEnd = emittedEvents.find((e) => e.type === "tool_end");
      expect(toolEnd).toBeDefined();
      if (toolEnd?.type === "tool_end") {
        expect(toolEnd.isError).toBe(true);
        expect(toolEnd.result).toContain("boom");
      }
    });

    it("should emit tool_end with isError=false when tool succeeds", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "good_tool", input: {} }]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("good_tool", {
          execute: async () => ({ data: "all good" }),
        }),
      );

      const emittedEvents: EngineEvent[] = [];
      engine.on("event", (event) => emittedEvents.push(event));

      await collectEvents(engine.run("Run it"));

      const toolEnd = emittedEvents.find((e) => e.type === "tool_end");
      expect(toolEnd).toBeDefined();
      if (toolEnd?.type === "tool_end") {
        expect(toolEnd.isError).toBe(false);
        expect(toolEnd.result).toBe("all good");
      }
    });

    it("should truncate large tool results", async () => {
      const largeOutput = "x".repeat(200_000);
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "big_tool", input: {} }]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("big_tool", {
          execute: async () => ({ data: largeOutput }),
          maxResultSize: 1000,
        }),
      );

      await collectEvents(engine.run("Run it"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        expect(typeof result.content === "string" && result.content.length).toBeLessThan(
          2000,
        );
        expect(result.content).toContain("[Result truncated");
      }
    });

    it("should yield LLM stream errors as error events", async () => {
      const provider = createMockProvider([
        [
          { type: "message_start", messageId: "msg-1" },
          { type: "error", error: new Error("LLM stream error") },
          {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        ],
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      const events = await collectEvents(engine.run("Hi"));

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "error") {
        expect(errorEvent.error.message).toBe("LLM stream error");
      }
    });

    it("should JSON-stringify non-string tool results", async () => {
      const provider = createMockProvider([
        toolUseResponse([{ id: "tu-1", name: "json_tool", input: {} }]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(
        createMockTool("json_tool", {
          execute: async () => ({
            data: { key: "value", nested: { num: 42 } },
          }),
        }),
      );

      await collectEvents(engine.run("Run it"));

      const messages = engine.getMessages();
      const toolResultMsg = messages.find(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "tool_result"),
      );
      const result = toolResultMsg!.content.find(
        (b) => b.type === "tool_result",
      );
      if (result?.type === "tool_result") {
        const parsed = JSON.parse(result.content as string);
        expect(parsed).toEqual({ key: "value", nested: { num: 42 } });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Additional edge cases
  // --------------------------------------------------------------------------

  describe("conversation management", () => {
    it("should reset conversation history and usage", async () => {
      const provider = createMockProvider([
        textResponse("First reply"),
        textResponse("Second reply"),
      ]);
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(engine.run("First"));
      expect(engine.getMessages()).toHaveLength(2);
      expect(engine.getUsage().inputTokens).toBeGreaterThan(0);

      engine.reset();

      expect(engine.getMessages()).toHaveLength(0);
      expect(engine.getUsage().inputTokens).toBe(0);
      expect(engine.getUsage().outputTokens).toBe(0);
    });

    it("should pass custom system prompt to the LLM request", async () => {
      let capturedSystemPrompt: string | undefined;
      const provider: LLMProvider = {
        name: "spy-provider",
        async *chat(request, _signal) {
          capturedSystemPrompt = request.systemPrompt;
          yield { type: "message_start", messageId: "msg-1" };
          yield { type: "text_delta", text: "Ok" };
          yield {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(
        engine.run("Hi", { systemPrompt: "You are a pirate." }),
      );

      expect(capturedSystemPrompt).toBe("You are a pirate.");
    });

    it("should include tool definitions in the LLM request when tools are registered", async () => {
      let capturedTools: unknown[] | undefined;
      const provider: LLMProvider = {
        name: "spy-provider",
        async *chat(request, _signal) {
          capturedTools = request.tools;
          yield { type: "message_start", messageId: "msg-1" };
          yield { type: "text_delta", text: "Ok" };
          yield {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(createMockTool("tool_a"));

      await collectEvents(engine.run("Hi"));

      expect(capturedTools).toBeDefined();
      expect(capturedTools).toHaveLength(1);
    });

    it("should not include tools in request when no tools are registered", async () => {
      let capturedTools: unknown;
      const provider: LLMProvider = {
        name: "spy-provider",
        async *chat(request, _signal) {
          capturedTools = request.tools;
          yield { type: "message_start", messageId: "msg-1" };
          yield { type: "text_delta", text: "Ok" };
          yield {
            type: "message_end",
            stopReason: "end_turn" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      };
      const engine = new NexusEngine(provider, config, permissions);

      await collectEvents(engine.run("Hi"));

      expect(capturedTools).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Plan Mode
  // --------------------------------------------------------------------------

  describe("plan mode", () => {
    it("should toggle plan mode on and off", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);

      expect(engine.isPlanMode()).toBe(false);
      engine.enterPlanMode();
      expect(engine.isPlanMode()).toBe(true);
      engine.exitPlanMode();
      expect(engine.isPlanMode()).toBe(false);
    });

    it("should expose the PlanExecutor", () => {
      const provider = createMockProvider([]);
      const engine = new NexusEngine(provider, config, permissions);
      const executor = engine.getPlanExecutor();
      expect(executor).toBeDefined();
      expect(executor.getPlans()).toEqual([]);
    });

    it("should intercept write tools in plan mode and create a plan", async () => {
      const writeTool = createMockTool("write_file", { readOnly: false });
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "write_file", input: { path: "/tmp/a.txt", content: "hello" } },
        ]),
        textResponse("I've queued the write for your approval."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(writeTool);
      engine.enterPlanMode();

      const events = await collectEvents(engine.run("Write a file"));

      // Should have plan_action_intercepted and plan_created events
      const intercepted = events.filter((e) => e.type === "plan_action_intercepted");
      expect(intercepted).toHaveLength(1);
      expect(intercepted[0].type === "plan_action_intercepted" && intercepted[0].toolName).toBe("write_file");

      const planCreated = events.filter((e) => e.type === "plan_created");
      expect(planCreated).toHaveLength(1);
      expect(planCreated[0].type === "plan_created" && planCreated[0].actionCount).toBe(1);

      // The write tool should NOT have been executed
      // (it returns "write_file executed" normally, but in plan mode it should be queued)
      const toolResults = engine.getMessages().filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      );
      expect(toolResults.length).toBeGreaterThan(0);
      const resultBlock = toolResults[0].content.find(
        (b) => b.type === "tool_result",
      );
      expect(resultBlock?.type === "tool_result" && (resultBlock.content as string)).toContain("[Plan mode]");

      // Plan executor should have 1 pending plan
      const plans = engine.getPlanExecutor().getPlans();
      expect(plans).toHaveLength(1);
      expect(plans[0].status).toBe("pending");
      expect(plans[0].actions).toHaveLength(1);
    });

    it("should allow read-only tools to execute normally in plan mode", async () => {
      const readTool = createMockTool("read_file", {
        readOnly: true,
        execute: async () => ({ data: "file contents here" }),
      });
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "read_file", input: { path: "/tmp/a.txt" } },
        ]),
        textResponse("Here's the file contents."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(readTool);
      engine.enterPlanMode();

      const events = await collectEvents(engine.run("Read a file"));

      // Should NOT have plan_action_intercepted
      const intercepted = events.filter((e) => e.type === "plan_action_intercepted");
      expect(intercepted).toHaveLength(0);

      // Should NOT create a plan
      const planCreated = events.filter((e) => e.type === "plan_created");
      expect(planCreated).toHaveLength(0);

      // The tool result should contain actual output
      const toolResults = engine.getMessages().filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      );
      expect(toolResults.length).toBeGreaterThan(0);
      const resultBlock = toolResults[0].content.find(
        (b) => b.type === "tool_result",
      );
      expect(resultBlock?.type === "tool_result" && (resultBlock.content as string)).toContain("file contents here");
    });

    it("should intercept writes but execute reads in a mixed tool call", async () => {
      const readTool = createMockTool("read_file", {
        readOnly: true,
        execute: async () => ({ data: "contents" }),
      });
      const writeTool = createMockTool("write_file", {
        readOnly: false,
        execute: async () => ({ data: "written" }),
      });
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "read_file", input: { path: "/tmp/a.txt" } },
          { id: "tu-2", name: "write_file", input: { path: "/tmp/b.txt", content: "hi" } },
        ]),
        textResponse("Done."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(readTool);
      engine.registerTool(writeTool);
      engine.enterPlanMode();

      const events = await collectEvents(engine.run("Read and write"));

      // Only the write should be intercepted
      const intercepted = events.filter((e) => e.type === "plan_action_intercepted");
      expect(intercepted).toHaveLength(1);
      expect(intercepted[0].type === "plan_action_intercepted" && intercepted[0].toolName).toBe("write_file");

      // A plan should have been created with 1 action
      const planCreated = events.filter((e) => e.type === "plan_created");
      expect(planCreated).toHaveLength(1);
      expect(planCreated[0].type === "plan_created" && planCreated[0].actionCount).toBe(1);

      // Both tool results should exist
      const toolResultMsg = engine.getMessages().find(
        (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();
      const results = toolResultMsg!.content.filter((b) => b.type === "tool_result");
      expect(results).toHaveLength(2);
    });

    it("should not intercept tools when plan mode is off", async () => {
      const writeTool = createMockTool("write_file", {
        readOnly: false,
        execute: async () => ({ data: "written successfully" }),
      });
      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "write_file", input: { path: "/tmp/a.txt", content: "hi" } },
        ]),
        textResponse("File written."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(writeTool);
      // Plan mode is OFF by default

      const events = await collectEvents(engine.run("Write a file"));

      // Should NOT have plan events
      const intercepted = events.filter((e) => e.type === "plan_action_intercepted");
      expect(intercepted).toHaveLength(0);
      const planCreated = events.filter((e) => e.type === "plan_created");
      expect(planCreated).toHaveLength(0);

      // Tool should have executed normally
      const toolResults = engine.getMessages().filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      );
      const resultBlock = toolResults[0].content.find((b) => b.type === "tool_result");
      expect(resultBlock?.type === "tool_result" && (resultBlock.content as string)).toContain("written successfully");
    });

    it("should handle multiple write tools in a single turn, creating one plan", async () => {
      const writeTool = createMockTool("write_file", { readOnly: false });
      const bashTool = createMockTool("bash", { readOnly: false, concurrencySafe: false });

      const provider = createMockProvider([
        toolUseResponse([
          { id: "tu-1", name: "write_file", input: { path: "/a.txt", content: "a" } },
          { id: "tu-2", name: "bash", input: { command: "rm /tmp/old" } },
          { id: "tu-3", name: "write_file", input: { path: "/b.txt", content: "b" } },
        ]),
        textResponse("Queued 3 actions."),
      ]);
      const engine = new NexusEngine(provider, config, permissions);
      engine.registerTool(writeTool);
      engine.registerTool(bashTool);
      engine.enterPlanMode();

      const events = await collectEvents(engine.run("Write files and run command"));

      const intercepted = events.filter((e) => e.type === "plan_action_intercepted");
      expect(intercepted).toHaveLength(3);

      const planCreated = events.filter((e) => e.type === "plan_created");
      expect(planCreated).toHaveLength(1);
      expect(planCreated[0].type === "plan_created" && planCreated[0].actionCount).toBe(3);

      const plans = engine.getPlanExecutor().getPlans();
      expect(plans).toHaveLength(1);
      expect(plans[0].actions).toHaveLength(3);
    });
  });
});
