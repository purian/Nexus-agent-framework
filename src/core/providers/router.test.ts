import { describe, it, expect } from "vitest";
import { ModelRouter } from "./router.js";
import type { ModelRoute, RouterConfig } from "./router.js";
import type { LLMEvent, LLMProvider, LLMRequest } from "../../types/index.js";

function createMockProvider(
  name: string,
  opts?: { captureRequest?: (req: LLMRequest) => void },
): LLMProvider {
  return {
    name,
    async *chat(request: LLMRequest): AsyncGenerator<LLMEvent> {
      opts?.captureRequest?.(request);
      yield { type: "message_start", messageId: "msg_1" };
      yield { type: "text_delta", text: `Hello from ${name}` };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

function createRoute(overrides: Partial<ModelRoute> & { model: string }): ModelRoute {
  return {
    provider: createMockProvider(overrides.model),
    inputCostPer1K: 0.01,
    outputCostPer1K: 0.03,
    capability: 5,
    maxContextTokens: 100000,
    supportsTools: true,
    supportsThinking: false,
    ...overrides,
  };
}

function simpleRequest(text = "hi"): LLMRequest {
  return {
    model: "auto",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

async function collectEvents(gen: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function defaultRoutes(): ModelRoute[] {
  return [
    createRoute({
      model: "cheap-model",
      inputCostPer1K: 0.0001,
      outputCostPer1K: 0.0003,
      capability: 2,
      supportsTools: false,
      supportsThinking: false,
    }),
    createRoute({
      model: "mid-model",
      inputCostPer1K: 0.003,
      outputCostPer1K: 0.015,
      capability: 6,
      supportsTools: true,
      supportsThinking: false,
    }),
    createRoute({
      model: "powerful-model",
      inputCostPer1K: 0.015,
      outputCostPer1K: 0.075,
      capability: 10,
      supportsTools: true,
      supportsThinking: true,
    }),
  ];
}

describe("ModelRouter", () => {
  it("constructor - accepts config", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    expect(router.name).toBe("router");
  });

  it("constructor - requires at least one route", () => {
    expect(() => new ModelRouter({ routes: [] })).toThrow(
      "at least one route",
    );
  });

  it("selectRoute - routes simple query to cheapest model", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const decision = router.selectRoute(simpleRequest("hello"));
    expect(decision.route.model).toBe("cheap-model");
    expect(decision.reason).toContain("Low complexity");
  });

  it("selectRoute - routes complex query to most capable", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    // Long conversation + thinking = high complexity
    const request: LLMRequest = {
      model: "auto",
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: "A".repeat(500) }],
      })),
      thinking: { enabled: true },
      systemPrompt: "A".repeat(8000),
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("powerful-model");
    expect(decision.reason).toContain("High complexity");
  });

  it("selectRoute - routes mid-complexity to mid-range", () => {
    const router = new ModelRouter({
      routes: defaultRoutes(),
      simpleThresholdTokens: 50,
    });
    // Moderate length + tools = mid complexity
    const request: LLMRequest = {
      model: "auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "A".repeat(400) }] },
      ],
      tools: [{ name: "test", description: "d", inputSchema: {} }],
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("mid-model");
    expect(decision.reason).toContain("Medium complexity");
  });

  it("selectRoute - requires tool support when tools present", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const request: LLMRequest = {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "bash", description: "run", inputSchema: {} }],
    };
    const decision = router.selectRoute(request);
    // cheap-model doesn't support tools, so it should pick mid or powerful
    expect(decision.route.supportsTools).toBe(true);
  });

  it("selectRoute - requires thinking support when thinking enabled", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const request: LLMRequest = {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { enabled: true },
    };
    const decision = router.selectRoute(request);
    expect(decision.route.supportsThinking).toBe(true);
    expect(decision.route.model).toBe("powerful-model");
  });

  it("selectRoute - filters by context window size", () => {
    const routes = [
      createRoute({ model: "small-ctx", maxContextTokens: 10, capability: 2 }),
      createRoute({
        model: "big-ctx",
        maxContextTokens: 1000000,
        capability: 5,
      }),
    ];
    const router = new ModelRouter({ routes });
    const request: LLMRequest = {
      model: "auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "A".repeat(200) }] },
      ],
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("big-ctx");
  });

  it("selectRoute - falls back to default when no routes match", () => {
    const routes = [
      createRoute({
        model: "no-tools",
        supportsTools: false,
        maxContextTokens: 10,
      }),
    ];
    const router = new ModelRouter({
      routes,
      defaultModel: "no-tools",
    });
    const request: LLMRequest = {
      model: "auto",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "A".repeat(1000) }],
        },
      ],
      tools: [{ name: "t", description: "d", inputSchema: {} }],
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("no-tools");
    expect(decision.reason).toContain("fallback");
  });

  it("selectRoute - returns reason in decision", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const decision = router.selectRoute(simpleRequest());
    expect(decision.reason).toBeTruthy();
    expect(typeof decision.reason).toBe("string");
  });

  it("selectRoute - estimates cost in decision", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const decision = router.selectRoute(simpleRequest());
    expect(decision.estimatedCost).toBeGreaterThanOrEqual(0);
    expect(typeof decision.estimatedCost).toBe("number");
  });

  it("estimateComplexity - low for short messages", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const decision = router.selectRoute(simpleRequest("hi"));
    // Short message -> low complexity -> cheapest model
    expect(decision.route.model).toBe("cheap-model");
  });

  it("estimateComplexity - high for long conversations", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: "A".repeat(1000) }],
    }));
    const decision = router.selectRoute({
      model: "auto",
      messages,
      thinking: { enabled: true },
    });
    expect(decision.route.model).toBe("powerful-model");
  });

  it("estimateComplexity - adds for tools", () => {
    const router = new ModelRouter({
      routes: defaultRoutes(),
      simpleThresholdTokens: 10000,
    });
    const withTools: LLMRequest = {
      ...simpleRequest(),
      tools: [{ name: "a", description: "d", inputSchema: {} }],
    };
    const withoutTools = simpleRequest();
    const dWith = router.selectRoute(withTools);
    const dWithout = router.selectRoute(withoutTools);
    // With tools should route to at least a model that supports tools
    expect(dWith.route.supportsTools).toBe(true);
    // Without tools can go to cheapest
    expect(dWithout.route.model).toBe("cheap-model");
  });

  it("estimateComplexity - adds for thinking", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const request: LLMRequest = {
      ...simpleRequest(),
      thinking: { enabled: true },
    };
    const decision = router.selectRoute(request);
    // Thinking adds +3 complexity, so it should go to a thinking-capable model
    expect(decision.route.supportsThinking).toBe(true);
  });

  it("chat - delegates to selected provider", async () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const events = await collectEvents(router.chat(simpleRequest()));
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it("chat - overrides model in request", async () => {
    let capturedModel = "";
    const provider = createMockProvider("test", {
      captureRequest: (req) => {
        capturedModel = req.model;
      },
    });
    const routes = [
      createRoute({ model: "target-model", provider, capability: 2 }),
    ];
    const router = new ModelRouter({ routes });
    await collectEvents(
      router.chat({ ...simpleRequest(), model: "original" }),
    );
    expect(capturedModel).toBe("target-model");
  });

  it("chat - records usage from message_end", async () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    await collectEvents(router.chat(simpleRequest()));
    expect(router.getTotalCost()).toBeGreaterThan(0);
  });

  it("getTotalCost - accumulates across requests", async () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    await collectEvents(router.chat(simpleRequest()));
    const cost1 = router.getTotalCost();
    await collectEvents(router.chat(simpleRequest()));
    const cost2 = router.getTotalCost();
    expect(cost2).toBeGreaterThan(cost1);
  });

  it("getUsageBreakdown - per-model stats", async () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    await collectEvents(router.chat(simpleRequest()));
    await collectEvents(router.chat(simpleRequest()));
    const breakdown = router.getUsageBreakdown();
    expect(breakdown.length).toBeGreaterThan(0);
    expect(breakdown[0].requests).toBe(2);
    expect(breakdown[0].totalInputTokens).toBe(200);
    expect(breakdown[0].totalOutputTokens).toBe(100);
    expect(breakdown[0].totalCost).toBeGreaterThan(0);
  });

  it("listModels - returns all route models", async () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    const models = await router.listModels();
    expect(models).toEqual(["cheap-model", "mid-model", "powerful-model"]);
  });

  it("filterEligibleRoutes - excludes incapable routes", () => {
    const routes = [
      createRoute({
        model: "no-tools",
        supportsTools: false,
        capability: 2,
      }),
      createRoute({
        model: "with-tools",
        supportsTools: true,
        capability: 5,
      }),
    ];
    const router = new ModelRouter({ routes });
    const request: LLMRequest = {
      ...simpleRequest(),
      tools: [{ name: "t", description: "d", inputSchema: {} }],
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("with-tools");
  });

  it("selectCheapest - picks lowest cost", () => {
    const routes = [
      createRoute({
        model: "expensive",
        inputCostPer1K: 0.1,
        outputCostPer1K: 0.3,
        capability: 2,
      }),
      createRoute({
        model: "cheap",
        inputCostPer1K: 0.001,
        outputCostPer1K: 0.003,
        capability: 2,
      }),
    ];
    const router = new ModelRouter({ routes });
    const decision = router.selectRoute(simpleRequest());
    expect(decision.route.model).toBe("cheap");
  });

  it("selectMostCapable - picks highest capability", () => {
    const routes = [
      createRoute({ model: "basic", capability: 3 }),
      createRoute({
        model: "advanced",
        capability: 9,
        supportsThinking: true,
      }),
    ];
    const router = new ModelRouter({ routes });
    // Force high complexity
    const request: LLMRequest = {
      model: "auto",
      messages: Array.from({ length: 20 }, () => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: "A".repeat(500) }],
      })),
      thinking: { enabled: true },
      systemPrompt: "A".repeat(8000),
    };
    const decision = router.selectRoute(request);
    expect(decision.route.model).toBe("advanced");
  });

  it("routing with history - longer history = higher complexity", () => {
    const router = new ModelRouter({
      routes: defaultRoutes(),
      simpleThresholdTokens: 100,
    });
    const shortHistory = router.selectRoute(simpleRequest("hello"));

    const longHistory = router.selectRoute({
      model: "auto",
      messages: Array.from({ length: 15 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: [{ type: "text" as const, text: "A".repeat(200) }],
      })),
    });

    // Longer history should route to a more capable model
    expect(longHistory.route.capability).toBeGreaterThanOrEqual(
      shortHistory.route.capability,
    );
  });

  it("router implements LLMProvider interface", () => {
    const router = new ModelRouter({ routes: defaultRoutes() });
    // Check it has the required LLMProvider shape
    expect(typeof router.name).toBe("string");
    expect(typeof router.chat).toBe("function");
    expect(typeof router.listModels).toBe("function");
  });
});
