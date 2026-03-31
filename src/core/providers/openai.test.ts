import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider, convertMessages, convertTools } from "./openai.js";
import type { Message, ToolDefinition, LLMEvent, LLMRequest } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE text payload from an array of JSON chunks (or "[DONE]"). */
function makeSSE(chunks: (Record<string, unknown> | string)[]): string {
  return chunks
    .map((c) => {
      const data = typeof c === "string" ? c : JSON.stringify(c);
      return `data: ${data}\n\n`;
    })
    .join("");
}

/** Create a ReadableStream from an SSE string, optionally split into byte segments. */
function sseStream(sse: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(sse);
  return new ReadableStream({
    start(controller) {
      // Push in small chunks to exercise buffering.
      const chunkSize = 32;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

/** Create a mock fetch Response from an SSE string. */
function mockFetchResponse(sse: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    body: sseStream(sse),
    headers: new Headers(),
    text: async () => sse,
    json: async () => JSON.parse(sse),
    redirected: false,
    type: "basic",
    url: "",
    clone: () => mockFetchResponse(sse, status),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bodyUsed: false,
  } as unknown as Response;
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
    model: "gpt-4o",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAIProvider", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key-from-env";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  // -----------------------------------------------------------------------
  // Constructor / config
  // -----------------------------------------------------------------------

  it("has name 'openai'", () => {
    const provider = new OpenAIProvider({ apiKey: "k" });
    expect(provider.name).toBe("openai");
  });

  it("reads API key from env when not provided in constructor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { id: "x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
        "[DONE]",
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider(); // no apiKey
    await collectEvents(provider.chat(baseRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-key-from-env");
  });

  it("prefers constructor API key over env var", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        "[DONE]",
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({ apiKey: "constructor-key" });
    await collectEvents(provider.chat(baseRequest()));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer constructor-key");
  });

  it("uses custom baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        "[DONE]",
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIProvider({
      apiKey: "k",
      baseUrl: "https://custom.api.example.com/v1/",
    });
    await collectEvents(provider.chat(baseRequest()));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://custom.api.example.com/v1/chat/completions");
  });

  it("throws when no API key is available", async () => {
    delete process.env.OPENAI_API_KEY;
    const provider = new OpenAIProvider(); // no key anywhere
    const events = await collectEvents(provider.chat(baseRequest()));

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: "error"; error: Error }).error.message).toContain(
      "API key is required",
    );
  });

  // -----------------------------------------------------------------------
  // Simple text streaming
  // -----------------------------------------------------------------------

  it("streams a simple text response", async () => {
    const sse = makeSSE([
      { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
      { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      "[DONE]",
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    expect(events[0]).toEqual({ type: "message_start", messageId: "chatcmpl-1" });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe("Hello");
    expect((textDeltas[1] as { type: "text_delta"; text: string }).text).toBe(" world");

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end";
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(end.stopReason).toBe("end_turn");
    expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  // -----------------------------------------------------------------------
  // Tool use streaming
  // -----------------------------------------------------------------------

  it("streams a tool call response", async () => {
    const sse = makeSSE([
      { id: "chatcmpl-2", choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] },
      {
        id: "chatcmpl-2",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-2",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"loc' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-2",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'ation":"NYC"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: "chatcmpl-2",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 15 },
      },
      "[DONE]",
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const starts = events.filter((e) => e.type === "tool_use_start") as Array<{
      type: "tool_use_start"; id: string; name: string;
    }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].id).toBe("call_abc");
    expect(starts[0].name).toBe("get_weather");

    const deltas = events.filter((e) => e.type === "tool_use_delta") as Array<{
      type: "tool_use_delta"; id: string; partialInput: string;
    }>;
    expect(deltas).toHaveLength(2);
    expect(deltas[0].partialInput).toBe('{"loc');
    expect(deltas[1].partialInput).toBe('ation":"NYC"}');

    const ends = events.filter((e) => e.type === "tool_use_end") as Array<{
      type: "tool_use_end"; id: string; input: Record<string, unknown>;
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0].id).toBe("call_abc");
    expect(ends[0].input).toEqual({ location: "NYC" });

    const msgEnd = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string; usage: { inputTokens: number; outputTokens: number };
    };
    expect(msgEnd.stopReason).toBe("tool_use");
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("handles API error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse('{"error":{"message":"Rate limit exceeded"}}', 429),
      ),
    );

    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const errorEvent = events.find((e) => e.type === "error") as {
      type: "error"; error: Error;
    };
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain("429");
  });

  it("handles network errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const errorEvent = events.find((e) => e.type === "error") as {
      type: "error"; error: Error;
    };
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.message).toContain("Failed to fetch");
  });

  it("handles malformed SSE chunks gracefully", async () => {
    const sse = [
      "data: {invalid json}\n\n",
      `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new OpenAIProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    // Should still produce valid events despite the malformed line.
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe("ok");
  });

  // -----------------------------------------------------------------------
  // Request body construction
  // -----------------------------------------------------------------------

  it("sends correct request body structure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { id: "x", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        "[DONE]",
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools: ToolDefinition[] = [
      { name: "search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ];

    const provider = new OpenAIProvider({ apiKey: "k" });
    await collectEvents(
      provider.chat({
        model: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        systemPrompt: "You are helpful.",
        tools,
        maxTokens: 1000,
        temperature: 0.5,
        stopSequences: ["END"],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(1000);
    expect(body.temperature).toBe(0.5);
    expect(body.stop).toEqual(["END"]);
    expect(body.stream_options).toEqual({ include_usage: true });

    // System prompt should be first message.
    expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(body.messages[1]).toEqual({ role: "user", content: "test" });

    // Tools should be in OpenAI format.
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertMessages
// ---------------------------------------------------------------------------

describe("convertMessages", () => {
  it("converts user messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("prepends system prompt", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ];
    const result = convertMessages(messages, "Be helpful.");
    expect(result[0]).toEqual({ role: "system", content: "Be helpful." });
    expect(result[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("converts inline system messages", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Context info" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const result = convertMessages(messages);
    expect(result[0]).toEqual({ role: "system", content: "Context info" });
    expect(result[1]).toEqual({ role: "user", content: "Hello" });
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
    expect(result[0].content).toBe("Let me search.");
    expect(result[0].tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: '{"query":"weather"}' },
      },
    ]);
  });

  it("converts tool result messages", () => {
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
      { role: "tool", tool_call_id: "call_1", content: "Sunny, 72F" },
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
      { role: "tool", tool_call_id: "call_2", content: "Result A and B" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

describe("convertTools", () => {
  it("converts tool definitions to OpenAI format", () => {
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
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from disk",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path" } },
          required: ["path"],
        },
      },
    });
    expect(result[1].function.name).toBe("write_file");
  });
});
