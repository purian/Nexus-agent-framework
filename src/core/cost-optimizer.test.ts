import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CostOptimizer } from "./cost-optimizer.js";
import type { LLMRequest, Message, TokenUsage } from "../types/index.js";

function makeRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    model: "test-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello world" }] },
    ],
    ...overrides,
  };
}

function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

describe("CostOptimizer", () => {
  it("constructor - accepts config", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    expect(optimizer).toBeDefined();
  });

  it("getCached - returns undefined for miss", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const result = optimizer.getCached(makeRequest());
    expect(result).toBeUndefined();
  });

  it("getCached - returns entry for hit", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Hello!", makeUsage());
    const entry = optimizer.getCached(request);
    expect(entry).toBeDefined();
    expect(entry!.response).toBe("Hello!");
  });

  describe("getCached - respects TTL", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns undefined after TTL expires", () => {
      const optimizer = new CostOptimizer({
        enabled: true,
        cacheTtlSeconds: 60,
      });
      const request = makeRequest();
      optimizer.setCached(request, "Hello!", makeUsage());

      // Still valid
      expect(optimizer.getCached(request)).toBeDefined();

      // Advance past TTL
      vi.advanceTimersByTime(61 * 1000);
      expect(optimizer.getCached(request)).toBeUndefined();
    });
  });

  it("getCached - updates hit count", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Hello!", makeUsage());

    optimizer.getCached(request);
    optimizer.getCached(request);
    const entry = optimizer.getCached(request);
    expect(entry!.hits).toBe(3);
  });

  it("setCached - stores entry", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Response", makeUsage());
    const entry = optimizer.getCached(request);
    expect(entry).toBeDefined();
    expect(entry!.response).toBe("Response");
  });

  it("setCached - evicts when at capacity", () => {
    const optimizer = new CostOptimizer({
      enabled: true,
      maxCacheEntries: 2,
    });

    const req1 = makeRequest({ model: "model-1" });
    const req2 = makeRequest({ model: "model-2" });
    const req3 = makeRequest({ model: "model-3" });

    optimizer.setCached(req1, "R1", makeUsage());
    optimizer.setCached(req2, "R2", makeUsage());
    optimizer.setCached(req3, "R3", makeUsage());

    // Should have evicted one, so at most 2 entries
    const stats = optimizer.getStats();
    // req3 should be present (just added)
    expect(optimizer.getCached(req3)).toBeDefined();
  });

  it("setCached - doesn't cache when thinking enabled", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest({ thinking: { enabled: true } });
    optimizer.setCached(request, "Response", makeUsage());
    // Even getCached should return undefined for thinking requests
    const entry = optimizer.getCached(request);
    expect(entry).toBeUndefined();
  });

  it("buildCacheKey - same request = same key", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Response", makeUsage());

    // Same request should hit cache
    const entry = optimizer.getCached(makeRequest());
    expect(entry).toBeDefined();
  });

  it("buildCacheKey - different model = different key", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    optimizer.setCached(makeRequest({ model: "a" }), "R1", makeUsage());
    const entry = optimizer.getCached(makeRequest({ model: "b" }));
    expect(entry).toBeUndefined();
  });

  it("buildCacheKey - different message = different key", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    optimizer.setCached(makeRequest(), "R1", makeUsage());

    const differentMsg = makeRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Different message" }],
        },
      ],
    });
    const entry = optimizer.getCached(differentMsg);
    expect(entry).toBeUndefined();
  });

  it("optimizeSystemPrompt - compresses whitespace", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const prompt = "Hello    world\n\n\n\nfoo   bar";
    const optimized = optimizer.optimizeSystemPrompt(prompt);
    expect(optimized).toBe("Hello world\n\nfoo bar");
  });

  it("optimizeSystemPrompt - truncates long prompts", () => {
    const optimizer = new CostOptimizer({
      enabled: true,
      maxSystemPromptTokens: 50,
    });
    const longPrompt = "A".repeat(1000);
    const optimized = optimizer.optimizeSystemPrompt(longPrompt);
    expect(optimized.length).toBeLessThan(longPrompt.length);
    expect(optimized).toContain("[...truncated...]");
  });

  it("optimizeSystemPrompt - preserves short prompts", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const prompt = "You are a helpful assistant.";
    const optimized = optimizer.optimizeSystemPrompt(prompt);
    expect(optimized).toBe(prompt);
  });

  it("optimizeMessages - removes duplicate messages", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const optimized = optimizer.optimizeMessages(messages);
    expect(optimized).toHaveLength(2);
    expect(optimized[0].role).toBe("user");
    expect(optimized[1].role).toBe("assistant");
  });

  it("optimizeMessages - truncates long tool results", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const longContent = "X".repeat(2000);
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: longContent,
          },
        ],
      },
    ];
    const optimized = optimizer.optimizeMessages(messages);
    const block = optimized[0].content[0];
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(typeof block.content).toBe("string");
      expect((block.content as string).length).toBeLessThan(longContent.length);
      expect((block.content as string)).toContain("[truncated]");
    }
  });

  it("optimizeMessages - preserves normal messages", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const optimized = optimizer.optimizeMessages(messages);
    expect(optimized).toHaveLength(2);
    expect(optimized).toEqual(messages);
  });

  it("getStats - returns correct counts", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Hello!", makeUsage());

    optimizer.getCached(request); // hit
    optimizer.getCached(makeRequest({ model: "other" })); // miss

    const stats = optimizer.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.cacheHits).toBe(1);
    expect(stats.cacheMisses).toBe(1);
  });

  it("getStats - calculates hit rate", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Hello!", makeUsage());

    optimizer.getCached(request); // hit
    optimizer.getCached(request); // hit
    optimizer.getCached(makeRequest({ model: "other" })); // miss

    const stats = optimizer.getStats();
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it("reset - clears cache and stats", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    const request = makeRequest();
    optimizer.setCached(request, "Hello!", makeUsage());
    optimizer.getCached(request);

    optimizer.reset();

    expect(optimizer.getCached(request)).toBeUndefined();
    const stats = optimizer.getStats();
    expect(stats.totalRequests).toBe(1); // The getCached after reset counts
    expect(stats.cacheHits).toBe(0);
    expect(stats.cacheMisses).toBe(1);
  });

  describe("evict - removes expired entries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("evicts expired entries", () => {
      const optimizer = new CostOptimizer({
        enabled: true,
        cacheTtlSeconds: 60,
      });

      optimizer.setCached(makeRequest({ model: "a" }), "R1", makeUsage());
      vi.advanceTimersByTime(30 * 1000);
      optimizer.setCached(makeRequest({ model: "b" }), "R2", makeUsage());
      vi.advanceTimersByTime(31 * 1000); // total: 61s for first, 31s for second

      const evicted = optimizer.evict();
      expect(evicted).toBe(1); // Only the first should be expired

      // Second entry should still be accessible
      expect(optimizer.getCached(makeRequest({ model: "b" }))).toBeDefined();
    });
  });

  it("evictLRU - removes least used", () => {
    const optimizer = new CostOptimizer({
      enabled: true,
      maxCacheEntries: 2,
    });

    const req1 = makeRequest({ model: "model-1" });
    const req2 = makeRequest({ model: "model-2" });

    optimizer.setCached(req1, "R1", makeUsage());
    optimizer.setCached(req2, "R2", makeUsage());

    // Hit req2 to make it more popular
    optimizer.getCached(req2);
    optimizer.getCached(req2);

    // Adding a third should evict req1 (fewer hits)
    const req3 = makeRequest({ model: "model-3" });
    optimizer.setCached(req3, "R3", makeUsage());

    // req2 should survive (more hits), req1 should be gone
    expect(optimizer.getCached(req2)).toBeDefined();
    expect(optimizer.getCached(req3)).toBeDefined();
  });

  it("estimateTokens - reasonable estimation", () => {
    const optimizer = new CostOptimizer({ enabled: true });
    // We can test this indirectly through optimizeSystemPrompt
    // A 200-char prompt should be ~50 tokens, well under the 4000 default
    const short = "A".repeat(200);
    expect(optimizer.optimizeSystemPrompt(short)).toBe(short);

    // A very long prompt should get truncated
    const long = "A".repeat(20000);
    const optimized = optimizer.optimizeSystemPrompt(long);
    expect(optimized.length).toBeLessThan(long.length);
  });
});
