import { describe, it, expect } from "vitest";
import { FallbackProvider } from "./fallback.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "../../types/index.js";

function createMockProvider(
  name: string,
  behavior: "success" | "error" | "throw",
): LLMProvider {
  return {
    name,
    async *chat(): AsyncGenerator<LLMEvent> {
      if (behavior === "throw") {
        throw new Error(`${name} threw`);
      }
      if (behavior === "error") {
        yield { type: "error", error: new Error(`${name} errored`) };
        return;
      }
      yield { type: "message_start", messageId: "msg_1" };
      yield { type: "text_delta", text: `Hello from ${name}` };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function dummyRequest(): LLMRequest {
  return {
    model: "test",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
}

async function collectEvents(gen: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("FallbackProvider", () => {
  it("requires at least one provider", () => {
    expect(() => new FallbackProvider([])).toThrow("at least one provider");
  });

  it("uses the first provider when it succeeds", async () => {
    const fb = new FallbackProvider([
      createMockProvider("primary", "success"),
      createMockProvider("backup", "success"),
    ]);

    const events = await collectEvents(fb.chat(dummyRequest()));
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as any).text).toBe("Hello from primary");
  });

  it("falls back when primary yields error event", async () => {
    const fb = new FallbackProvider([
      createMockProvider("primary", "error"),
      createMockProvider("backup", "success"),
    ]);

    const events = await collectEvents(fb.chat(dummyRequest()));
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as any).text).toBe("Hello from backup");
  });

  it("falls back when primary throws", async () => {
    const fb = new FallbackProvider([
      createMockProvider("primary", "throw"),
      createMockProvider("backup", "success"),
    ]);

    const events = await collectEvents(fb.chat(dummyRequest()));
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as any).text).toBe("Hello from backup");
  });

  it("yields error when all providers fail", async () => {
    const fb = new FallbackProvider([
      createMockProvider("a", "error"),
      createMockProvider("b", "throw"),
    ]);

    const events = await collectEvents(fb.chat(dummyRequest()));
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
  });

  it("chains through multiple fallbacks", async () => {
    const fb = new FallbackProvider([
      createMockProvider("a", "error"),
      createMockProvider("b", "throw"),
      createMockProvider("c", "success"),
    ]);

    const events = await collectEvents(fb.chat(dummyRequest()));
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as any).text).toBe("Hello from c");
  });

  it("has a descriptive name", () => {
    const fb = new FallbackProvider([
      createMockProvider("anthropic", "success"),
      createMockProvider("openai", "success"),
    ]);
    expect(fb.name).toBe("fallback(anthropic -> openai)");
  });

  it("listModels aggregates from all providers", async () => {
    const p1: LLMProvider = {
      name: "a",
      async *chat() {},
      async listModels() { return ["model-a1", "model-a2"]; },
    };
    const p2: LLMProvider = {
      name: "b",
      async *chat() {},
      async listModels() { return ["model-b1"]; },
    };
    const fb = new FallbackProvider([p1, p2]);
    const models = await fb.listModels();
    expect(models).toEqual(["model-a1", "model-a2", "model-b1"]);
  });

  it("listModels skips providers that fail", async () => {
    const p1: LLMProvider = {
      name: "a",
      async *chat() {},
      async listModels() { throw new Error("nope"); },
    };
    const p2: LLMProvider = {
      name: "b",
      async *chat() {},
      async listModels() { return ["model-b1"]; },
    };
    const fb = new FallbackProvider([p1, p2]);
    const models = await fb.listModels();
    expect(models).toEqual(["model-b1"]);
  });
});
