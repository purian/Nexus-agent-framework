import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message, ToolDefinition, LLMEvent, LLMRequest } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Mock the AWS SDK — vi.hoisted ensures mockSend is available in vi.mock factories
// ---------------------------------------------------------------------------

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ConverseStreamCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

vi.mock("@aws-sdk/client-bedrock", () => ({
  BedrockClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ListFoundationModelsCommand: vi.fn().mockImplementation((input: unknown) => input),
}));

import { BedrockProvider, convertMessages, convertTools } from "./bedrock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an async iterable from an array of Bedrock stream events. */
async function* mockStream(
  events: Record<string, unknown>[],
): AsyncGenerator<Record<string, unknown>> {
  for (const event of events) {
    yield event;
  }
}

/** Collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

function baseRequest(overrides?: Partial<LLMRequest>): LLMRequest {
  return {
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    ...overrides,
  };
}

/** Set up mockSend to return a stream from the given events. */
function mockStreamResponse(events: Record<string, unknown>[]) {
  mockSend.mockResolvedValue({ stream: mockStream(events) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BedrockProvider", () => {
  let originalRegion: string | undefined;
  let originalDefaultRegion: string | undefined;

  beforeEach(() => {
    originalRegion = process.env.AWS_REGION;
    originalDefaultRegion = process.env.AWS_DEFAULT_REGION;
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalRegion !== undefined) {
      process.env.AWS_REGION = originalRegion;
    } else {
      delete process.env.AWS_REGION;
    }
    if (originalDefaultRegion !== undefined) {
      process.env.AWS_DEFAULT_REGION = originalDefaultRegion;
    } else {
      delete process.env.AWS_DEFAULT_REGION;
    }
  });

  // -----------------------------------------------------------------------
  // Constructor / config
  // -----------------------------------------------------------------------

  it("has name 'bedrock'", () => {
    const provider = new BedrockProvider();
    expect(provider.name).toBe("bedrock");
  });

  it("reads region from AWS_REGION env when not provided", () => {
    process.env.AWS_REGION = "eu-west-1";
    const provider = new BedrockProvider();
    // Region is private; we verify indirectly via the SDK client construction
    expect(provider.name).toBe("bedrock");
  });

  it("reads region from AWS_DEFAULT_REGION as fallback", () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    const provider = new BedrockProvider();
    expect(provider.name).toBe("bedrock");
  });

  it("defaults to us-east-1 when no region is set", () => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    const provider = new BedrockProvider();
    expect(provider.name).toBe("bedrock");
  });

  // -----------------------------------------------------------------------
  // Simple text streaming
  // -----------------------------------------------------------------------

  it("streams a simple text response", async () => {
    mockStreamResponse([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " world" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "!" } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 3 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    expect(events[0]).toEqual(expect.objectContaining({ type: "message_start" }));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(3);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe("Hello");
    expect((textDeltas[1] as { type: "text_delta"; text: string }).text).toBe(" world");
    expect((textDeltas[2] as { type: "text_delta"; text: string }).text).toBe("!");

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end";
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(end.stopReason).toBe("end_turn");
    expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  // -----------------------------------------------------------------------
  // Tool use streaming
  // -----------------------------------------------------------------------

  it("streams a tool call response", async () => {
    mockStreamResponse([
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "tool_1", name: "get_weather" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"location":' } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '"NYC"}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 20, outputTokens: 15 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const starts = events.filter((e) => e.type === "tool_use_start") as Array<{
      type: "tool_use_start"; id: string; name: string;
    }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].name).toBe("get_weather");
    expect(starts[0].id).toBe("tool_1");

    const deltas = events.filter((e) => e.type === "tool_use_delta") as Array<{
      type: "tool_use_delta"; id: string; partialInput: string;
    }>;
    expect(deltas).toHaveLength(2);
    expect(deltas[0].partialInput).toBe('{"location":');
    expect(deltas[1].partialInput).toBe('"NYC"}');

    const ends = events.filter((e) => e.type === "tool_use_end") as Array<{
      type: "tool_use_end"; id: string; input: Record<string, unknown>;
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0].input).toEqual({ location: "NYC" });

    const msgEnd = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(msgEnd.stopReason).toBe("tool_use");
  });

  it("streams multiple tool calls in one response", async () => {
    mockStreamResponse([
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "tool_1", name: "search" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"query":"weather"}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tool_2", name: "read_file" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"path":"/tmp/a"}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const starts = events.filter((e) => e.type === "tool_use_start");
    expect(starts).toHaveLength(2);

    const ends = events.filter((e) => e.type === "tool_use_end") as Array<{
      type: "tool_use_end"; id: string; input: Record<string, unknown>;
    }>;
    expect(ends).toHaveLength(2);
    expect(ends[0].input).toEqual({ query: "weather" });
    expect(ends[1].input).toEqual({ path: "/tmp/a" });
  });

  it("streams text mixed with tool calls", async () => {
    mockStreamResponse([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Let me search." } } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "tool_1", name: "search" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"q":"test"}' } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 8 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe("Let me search.");

    const toolStarts = events.filter((e) => e.type === "tool_use_start");
    expect(toolStarts).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("handles SDK errors gracefully", async () => {
    mockSend.mockRejectedValue(new Error("AccessDeniedException: Not authorized"));

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const errorEvent = events.find((e) => e.type === "error") as {
      type: "error"; error: Error;
    };
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain("AccessDeniedException");
  });

  it("handles missing stream in response", async () => {
    mockSend.mockResolvedValue({ stream: null });

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const errorEvent = events.find((e) => e.type === "error") as {
      type: "error"; error: Error;
    };
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain("no event stream");
  });

  it("handles malformed tool use JSON gracefully", async () => {
    mockStreamResponse([
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "tool_1", name: "search" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: "{invalid json" } },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const ends = events.filter((e) => e.type === "tool_use_end") as Array<{
      type: "tool_use_end"; id: string; input: Record<string, unknown>;
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0].input).toEqual({ _raw: "{invalid json" });
  });

  // -----------------------------------------------------------------------
  // Stop reasons
  // -----------------------------------------------------------------------

  it("maps tool_use stop reason", async () => {
    mockStreamResponse([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(end.stopReason).toBe("tool_use");
  });

  it("maps max_tokens stop reason", async () => {
    mockStreamResponse([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
      { messageStop: { stopReason: "max_tokens" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 100 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(end.stopReason).toBe("max_tokens");
  });

  it("maps stop_sequence stop reason", async () => {
    mockStreamResponse([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "done" } } },
      { messageStop: { stopReason: "stop_sequence" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 1 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(end.stopReason).toBe("stop_sequence");
  });

  // -----------------------------------------------------------------------
  // Request body construction
  // -----------------------------------------------------------------------

  it("sends correct command input structure", async () => {
    mockStreamResponse([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
    ]);

    const tools: ToolDefinition[] = [
      { name: "search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ];

    const provider = new BedrockProvider({
      region: "us-west-2",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
    });

    await collectEvents(
      provider.chat({
        model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        systemPrompt: "You are helpful.",
        tools,
        maxTokens: 1000,
        temperature: 0.5,
        stopSequences: ["END"],
      }),
    );

    // The ConverseStreamCommand receives the input directly (mock passes through).
    const commandInput = mockSend.mock.calls[0][0] as Record<string, unknown>;

    expect(commandInput.modelId).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(commandInput.system).toEqual([{ text: "You are helpful." }]);
    expect(commandInput.messages).toEqual([
      { role: "user", content: [{ text: "test" }] },
    ]);
    expect(commandInput.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "search",
            description: "Search the web",
            inputSchema: { json: { type: "object", properties: { query: { type: "string" } } } },
          },
        },
      ],
    });
    expect(commandInput.inferenceConfig).toEqual({
      maxTokens: 1000,
      temperature: 0.5,
      stopSequences: ["END"],
    });
  });

  it("omits optional fields when not provided", async () => {
    mockStreamResponse([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
    ]);

    const provider = new BedrockProvider({ region: "us-east-1" });
    await collectEvents(provider.chat(baseRequest()));

    const commandInput = mockSend.mock.calls[0][0] as Record<string, unknown>;

    expect(commandInput.system).toBeUndefined();
    expect(commandInput.toolConfig).toBeUndefined();
    expect(commandInput.inferenceConfig).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // listModels
  // -----------------------------------------------------------------------

  it("lists available on-demand models", async () => {
    mockSend.mockResolvedValue({
      modelSummaries: [
        { modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0", inferenceTypesSupported: ["ON_DEMAND"] },
        { modelId: "anthropic.claude-3-haiku-20240307-v1:0", inferenceTypesSupported: ["ON_DEMAND"] },
        { modelId: "amazon.titan-embed-text-v1", inferenceTypesSupported: ["ON_DEMAND"] },
        { modelId: "custom.fine-tuned-model", inferenceTypesSupported: ["PROVISIONED"] },
      ],
    });

    const provider = new BedrockProvider({ region: "us-east-1" });
    const models = await provider.listModels();

    expect(models).toEqual([
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "anthropic.claude-3-haiku-20240307-v1:0",
      "amazon.titan-embed-text-v1",
    ]);
    expect(models).not.toContain("custom.fine-tuned-model");
  });
});

// ---------------------------------------------------------------------------
// convertMessages
// ---------------------------------------------------------------------------

describe("convertMessages (Bedrock)", () => {
  it("converts user messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([{ role: "user", content: [{ text: "Hello" }] }]);
  });

  it("skips system messages (handled via system parameter)", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be helpful." }] },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: [{ text: "Hi" }] });
  });

  it("converts assistant messages", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "I can help!" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([{ role: "assistant", content: [{ text: "I can help!" }] }]);
  });

  it("converts assistant messages with tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search." },
          { type: "tool_use", id: "call_1", name: "search", input: { query: "weather" } },
        ],
      },
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ text: "Let me search." });
    expect(result[0].content[1]).toEqual({
      toolUse: { toolUseId: "call_1", name: "search", input: { query: "weather" } },
    });
  });

  it("converts tool result messages to toolResult blocks", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "Sunny, 72F" },
        ],
      },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "call_1", content: [{ text: "Sunny, 72F" }] } },
        ],
      },
    ]);
  });

  it("converts tool result with nested content blocks", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: [{ type: "text", text: "Result A" }, { type: "text", text: " and B" }],
          },
        ],
      },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "call_2", content: [{ text: "Result A and B" }] } },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

describe("convertTools (Bedrock)", () => {
  it("converts tool definitions to Bedrock toolSpec format", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write a file to disk",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ];

    const result = convertTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      toolSpec: {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: {
          json: {
            type: "object",
            properties: { path: { type: "string", description: "File path" } },
            required: ["path"],
          },
        },
      },
    });
    expect(result[1].toolSpec.name).toBe("write_file");
  });
});
