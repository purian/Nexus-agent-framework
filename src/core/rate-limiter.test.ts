import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { RateLimiter } from "./rate-limiter.js";
import { NexusEngine } from "./engine.js";
import type {
  RateLimitConfig,
  EngineEvent,
  LLMEvent,
  LLMProvider,
  NexusConfig,
  PermissionContext,
  Tool,
} from "../types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    enabled: true,
    defaultLimit: { maxExecutions: 5, windowSeconds: 60 },
    ...overrides,
  };
}

function createMockProvider(responses: LLMEvent[][]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock-provider",
    async *chat() {
      const events = responses[callIndex] ?? [];
      callIndex++;
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: z.object({}).passthrough(),
    execute: async () => ({ data: `${name} executed` }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
  };
}

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

function createTestPermissions(): PermissionContext {
  return {
    mode: "allowAll",
    rules: [],
    checkPermission: () => ({ behavior: "allow" }),
    addRule: () => {},
    removeRule: () => {},
  };
}

async function collectEvents(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe("RateLimiter", () => {
  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe("constructor", () => {
    it("accepts config", () => {
      const config = createConfig();
      const limiter = new RateLimiter(config);
      expect(limiter).toBeDefined();
    });

    it("works with minimal config", () => {
      const limiter = new RateLimiter({ enabled: true });
      expect(limiter).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // checkAndRecord
  // --------------------------------------------------------------------------

  describe("checkAndRecord", () => {
    it("allows when under limit", () => {
      const limiter = new RateLimiter(createConfig());
      const decision = limiter.checkAndRecord("bash");
      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(1);
      expect(decision.maxCount).toBe(5);
    });

    it("denies when at limit", () => {
      const limiter = new RateLimiter(
        createConfig({ defaultLimit: { maxExecutions: 2, windowSeconds: 60 } }),
      );
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("bash");
      const decision = limiter.checkAndRecord("bash");
      expect(decision.allowed).toBe(false);
      expect(decision.currentCount).toBe(2);
      expect(decision.maxCount).toBe(2);
    });

    it("records the execution", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("bash");
      const usage = limiter.getUsage("bash");
      expect(usage.tool.currentCount).toBe(2);
    });

    it("sliding window expires old entries", () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter(
          createConfig({ defaultLimit: { maxExecutions: 2, windowSeconds: 10 } }),
        );
        limiter.checkAndRecord("bash");
        limiter.checkAndRecord("bash");

        // Move past the window
        vi.advanceTimersByTime(11_000);

        const decision = limiter.checkAndRecord("bash");
        expect(decision.allowed).toBe(true);
        expect(decision.currentCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("retryAfterSeconds calculation", () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter(
          createConfig({ defaultLimit: { maxExecutions: 1, windowSeconds: 10 } }),
        );
        limiter.checkAndRecord("bash");

        // 3 seconds later
        vi.advanceTimersByTime(3_000);
        const decision = limiter.checkAndRecord("bash");
        expect(decision.allowed).toBe(false);
        expect(decision.retryAfterSeconds).toBeCloseTo(7, 0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("tool-specific limit", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: { maxExecutions: 10, windowSeconds: 60 },
          toolLimits: {
            bash: { maxExecutions: 2, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("bash");
      const decision = limiter.checkAndRecord("bash");
      expect(decision.allowed).toBe(false);
      expect(decision.maxCount).toBe(2);
    });

    it("falls back to default limit", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: { maxExecutions: 3, windowSeconds: 60 },
          toolLimits: {
            bash: { maxExecutions: 10, windowSeconds: 60 },
          },
        }),
      );
      // "grep" has no specific limit, uses default
      limiter.checkAndRecord("grep");
      limiter.checkAndRecord("grep");
      limiter.checkAndRecord("grep");
      const decision = limiter.checkAndRecord("grep");
      expect(decision.allowed).toBe(false);
      expect(decision.maxCount).toBe(3);
    });

    it("agent-specific limit", () => {
      const limiter = new RateLimiter(
        createConfig({
          agentLimits: {
            "agent-1": { maxExecutions: 2, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("bash", "agent-1");
      limiter.checkAndRecord("grep", "agent-1");
      const decision = limiter.checkAndRecord("read", "agent-1");
      expect(decision.allowed).toBe(false);
      expect(decision.maxCount).toBe(2);
    });

    it("checks both tool and agent limits", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: { maxExecutions: 10, windowSeconds: 60 },
          agentLimits: {
            "agent-1": { maxExecutions: 2, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("bash", "agent-1");
      limiter.checkAndRecord("bash", "agent-1");
      // Agent limit (2) hit even though tool limit (10) is fine
      const decision = limiter.checkAndRecord("bash", "agent-1");
      expect(decision.allowed).toBe(false);
    });

    it("most restrictive wins", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: { maxExecutions: 5, windowSeconds: 60 },
          agentLimits: {
            "agent-1": { maxExecutions: 10, windowSeconds: 60 },
          },
        }),
      );
      // Tool limit is 5, agent limit is 10 — tool is more restrictive
      for (let i = 0; i < 4; i++) {
        limiter.checkAndRecord("bash", "agent-1");
      }
      const decision = limiter.checkAndRecord("bash", "agent-1");
      // After 5 calls: tool count 5/5, agent count 5/10
      // Tool remaining = 0, agent remaining = 5 → tool is returned
      expect(decision.allowed).toBe(true);
      expect(decision.maxCount).toBe(5); // tool's max
    });
  });

  // --------------------------------------------------------------------------
  // check (peek)
  // --------------------------------------------------------------------------

  describe("check", () => {
    it("does not record (peek only)", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.check("bash");
      limiter.check("bash");
      limiter.check("bash");
      const usage = limiter.getUsage("bash");
      expect(usage.tool.currentCount).toBe(0);
    });

    it("returns correct current count", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("bash");
      const decision = limiter.check("bash");
      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getUsage
  // --------------------------------------------------------------------------

  describe("getUsage", () => {
    it("returns tool and agent usage", () => {
      const limiter = new RateLimiter(
        createConfig({
          agentLimits: {
            "agent-1": { maxExecutions: 10, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("bash", "agent-1");
      const usage = limiter.getUsage("bash", "agent-1");
      expect(usage.tool.currentCount).toBe(1);
      expect(usage.agent).toBeDefined();
      expect(usage.agent!.currentCount).toBe(1);
    });

    it("returns undefined agent when no agentId", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.checkAndRecord("bash");
      const usage = limiter.getUsage("bash");
      expect(usage.tool.currentCount).toBe(1);
      expect(usage.agent).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // reset
  // --------------------------------------------------------------------------

  describe("reset", () => {
    it("clears specific key", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("grep");
      limiter.reset("tool:bash");
      expect(limiter.getUsage("bash").tool.currentCount).toBe(0);
      expect(limiter.getUsage("grep").tool.currentCount).toBe(1);
    });

    it("clears all keys when no argument", () => {
      const limiter = new RateLimiter(createConfig());
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("grep");
      limiter.reset();
      expect(limiter.getUsage("bash").tool.currentCount).toBe(0);
      expect(limiter.getUsage("grep").tool.currentCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // matchRule (tested through public API)
  // --------------------------------------------------------------------------

  describe("matchRule", () => {
    it("exact match", () => {
      const limiter = new RateLimiter(
        createConfig({
          toolLimits: {
            bash: { maxExecutions: 1, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("bash");
      const decision = limiter.checkAndRecord("bash");
      expect(decision.allowed).toBe(false);
      expect(decision.maxCount).toBe(1);
    });

    it("glob pattern match", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: undefined,
          toolLimits: {
            "file_*": { maxExecutions: 2, windowSeconds: 60 },
          },
        }),
      );
      limiter.checkAndRecord("file_read");
      limiter.checkAndRecord("file_read");
      const decision = limiter.checkAndRecord("file_read");
      expect(decision.allowed).toBe(false);
      expect(decision.maxCount).toBe(2);
    });

    it("no match returns undefined (no limit applied)", () => {
      const limiter = new RateLimiter(
        createConfig({
          defaultLimit: undefined,
          toolLimits: {
            bash: { maxExecutions: 1, windowSeconds: 60 },
          },
        }),
      );
      // "grep" has no matching rule and no default
      const decision = limiter.checkAndRecord("grep");
      expect(decision.allowed).toBe(true);
      expect(decision.maxCount).toBe(Infinity);
    });
  });

  // --------------------------------------------------------------------------
  // evaluateWindow (tested through public API)
  // --------------------------------------------------------------------------

  describe("evaluateWindow", () => {
    it("prunes expired entries", () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter(
          createConfig({ defaultLimit: { maxExecutions: 3, windowSeconds: 5 } }),
        );
        limiter.checkAndRecord("bash");
        limiter.checkAndRecord("bash");

        // Move past the window
        vi.advanceTimersByTime(6_000);

        // Old entries should be pruned
        const usage = limiter.getUsage("bash");
        expect(usage.tool.currentCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("empty window always allows", () => {
      const limiter = new RateLimiter(createConfig());
      const decision = limiter.check("never-called-tool");
      expect(decision.allowed).toBe(true);
      expect(decision.currentCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Sliding window with fake timers
  // --------------------------------------------------------------------------

  describe("sliding window", () => {
    it("allows after window expires", () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter(
          createConfig({ defaultLimit: { maxExecutions: 1, windowSeconds: 10 } }),
        );
        limiter.checkAndRecord("bash");
        expect(limiter.checkAndRecord("bash").allowed).toBe(false);

        vi.advanceTimersByTime(11_000);
        expect(limiter.checkAndRecord("bash").allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("partial window expiry", () => {
      vi.useFakeTimers();
      try {
        const limiter = new RateLimiter(
          createConfig({ defaultLimit: { maxExecutions: 2, windowSeconds: 10 } }),
        );
        limiter.checkAndRecord("bash"); // t=0
        vi.advanceTimersByTime(5_000);
        limiter.checkAndRecord("bash"); // t=5s
        expect(limiter.checkAndRecord("bash").allowed).toBe(false); // full

        // At t=11s, the first entry expires but the second doesn't
        vi.advanceTimersByTime(6_000);
        const decision = limiter.checkAndRecord("bash");
        expect(decision.allowed).toBe(true);
        expect(decision.currentCount).toBe(2); // one old + one new
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent tools
  // --------------------------------------------------------------------------

  describe("concurrent tools", () => {
    it("independent rate limits", () => {
      const limiter = new RateLimiter(
        createConfig({ defaultLimit: { maxExecutions: 2, windowSeconds: 60 } }),
      );
      limiter.checkAndRecord("bash");
      limiter.checkAndRecord("bash");
      // bash is at limit
      expect(limiter.checkAndRecord("bash").allowed).toBe(false);
      // grep is independent
      expect(limiter.checkAndRecord("grep").allowed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Disabled
  // --------------------------------------------------------------------------

  describe("rate limiter disabled", () => {
    it("always allows", () => {
      const limiter = new RateLimiter({ enabled: false });
      for (let i = 0; i < 100; i++) {
        expect(limiter.checkAndRecord("bash").allowed).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Engine integration
  // --------------------------------------------------------------------------

  describe("engine integration", () => {
    it("rate limited tool returns error result", async () => {
      const provider = createMockProvider([
        [
          { type: "message_start", messageId: "msg-1" },
          { type: "tool_use_start", id: "tu-1", name: "bash" },
          { type: "tool_use_end", id: "tu-1", input: { command: "ls" } },
          { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 10 } },
        ],
        // Second LLM call after rate limit error — ends the turn
        [
          { type: "message_start", messageId: "msg-2" },
          { type: "text_delta", text: "Rate limited" },
          { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5 } },
        ],
      ]);

      const config = createTestConfig({
        rateLimits: {
          enabled: true,
          defaultLimit: { maxExecutions: 0, windowSeconds: 60 },
        },
      });

      const engine = new NexusEngine(provider, config, createTestPermissions());
      engine.registerTool(createMockTool("bash"));

      // Capture emitted events (rate limit errors go through the EventEmitter)
      const emittedEvents: EngineEvent[] = [];
      engine.on("event", (event) => emittedEvents.push(event));

      await collectEvents(engine.run("test"));

      // Should have an error event for rate limiting emitted via EventEmitter
      const errorEvent = emittedEvents.find(
        (e) => e.type === "error" && e.error.message.includes("Rate limited"),
      );
      expect(errorEvent).toBeDefined();
    });
  });
});
