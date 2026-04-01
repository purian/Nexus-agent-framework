import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiProvider, convertMessages, convertTools } from "./gemini.js";
import type { Message, ToolDefinition, LLMEvent, LLMRequest } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE text payload from an array of JSON chunks. */
function makeSSE(chunks: (Record<string, unknown> | string)[]): string {
  return chunks
    .map((c) => {
      const data = typeof c === "string" ? c : JSON.stringify(c);
      return `data: ${data}\n\n`;
    })
    .join("");
}

/** Create a ReadableStream from an SSE string, split into small byte segments. */
function sseStream(sse: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(sse);
  return new ReadableStream({
    start(controller) {
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
    model: "gemini-2.0-flash",
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GeminiProvider", () => {
  let originalGoogleKey: string | undefined;
  let originalGeminiKey: string | undefined;

  beforeEach(() => {
    originalGoogleKey = process.env.GOOGLE_API_KEY;
    originalGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "test-google-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalGoogleKey !== undefined) {
      process.env.GOOGLE_API_KEY = originalGoogleKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  // -----------------------------------------------------------------------
  // Constructor / config
  // -----------------------------------------------------------------------

  it("has name 'gemini'", () => {
    const provider = new GeminiProvider({ apiKey: "k" });
    expect(provider.name).toBe("gemini");
  });

  it("reads API key from GOOGLE_API_KEY env when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider(); // no apiKey
    await collectEvents(provider.chat(baseRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("key=test-google-key");
  });

  it("reads API key from GEMINI_API_KEY env as fallback", async () => {
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";

    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider();
    await collectEvents(provider.chat(baseRequest()));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("key=test-gemini-key");
  });

  it("prefers constructor API key over env var", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider({ apiKey: "constructor-key" });
    await collectEvents(provider.chat(baseRequest()));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("key=constructor-key");
  });

  it("uses custom baseUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider({
      apiKey: "k",
      baseUrl: "https://custom.googleapis.com/v1/",
    });
    await collectEvents(provider.chat(baseRequest()));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("https://custom.googleapis.com/v1/models/");
  });

  it("throws when no API key is available", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider();
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
      { candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
      { candidates: [{ content: { parts: [{ text: " world" }] } }] },
      { candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
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
    const sse = makeSSE([
      {
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: "get_weather", args: { location: "NYC" } },
            }],
          },
        }],
      },
      {
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const starts = events.filter((e) => e.type === "tool_use_start") as Array<{
      type: "tool_use_start"; id: string; name: string;
    }>;
    expect(starts).toHaveLength(1);
    expect(starts[0].name).toBe("get_weather");

    const ends = events.filter((e) => e.type === "tool_use_end") as Array<{
      type: "tool_use_end"; id: string; input: Record<string, unknown>;
    }>;
    expect(ends).toHaveLength(1);
    expect(ends[0].input).toEqual({ location: "NYC" });

    const deltas = events.filter((e) => e.type === "tool_use_delta") as Array<{
      type: "tool_use_delta"; id: string; partialInput: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(JSON.parse(deltas[0].partialInput)).toEqual({ location: "NYC" });

    const msgEnd = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(msgEnd.stopReason).toBe("end_turn");
  });

  it("streams multiple tool calls in one response", async () => {
    const sse = makeSSE([
      {
        candidates: [{
          content: {
            parts: [
              { functionCall: { name: "search", args: { query: "weather" } } },
              { functionCall: { name: "read_file", args: { path: "/tmp/a" } } },
            ],
          },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
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

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("handles API error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse('{"error":{"message":"Quota exceeded"}}', 429),
      ),
    );

    const provider = new GeminiProvider({ apiKey: "k" });
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

    const provider = new GeminiProvider({ apiKey: "k" });
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
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })}\n\n`,
    ].join("");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(1);
    expect((textDeltas[0] as { type: "text_delta"; text: string }).text).toBe("ok");
  });

  // -----------------------------------------------------------------------
  // Finish reasons
  // -----------------------------------------------------------------------

  it("maps MAX_TOKENS finish reason", async () => {
    const sse = makeSSE([
      { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 } },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(end.stopReason).toBe("max_tokens");
  });

  it("maps STOP_SEQUENCE finish reason", async () => {
    const sse = makeSSE([
      { candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP_SEQUENCE" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } },
    ]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sse)));

    const provider = new GeminiProvider({ apiKey: "k" });
    const events = await collectEvents(provider.chat(baseRequest()));

    const end = events.find((e) => e.type === "message_end") as {
      type: "message_end"; stopReason: string;
    };
    expect(end.stopReason).toBe("stop_sequence");
  });

  // -----------------------------------------------------------------------
  // Request body construction
  // -----------------------------------------------------------------------

  it("sends correct request body structure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tools: ToolDefinition[] = [
      { name: "search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ];

    const provider = new GeminiProvider({ apiKey: "k" });
    await collectEvents(
      provider.chat({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        systemPrompt: "You are helpful.",
        tools,
        maxTokens: 1000,
        temperature: 0.5,
        stopSequences: ["END"],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    // System prompt should be in systemInstruction.
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "You are helpful." }],
    });

    // User message.
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "test" }] },
    ]);

    // Tools in Gemini format.
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
    ]);

    // Generation config.
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 1000,
      temperature: 0.5,
      stopSequences: ["END"],
    });
  });

  it("uses correct URL with model name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockFetchResponse(makeSSE([
        { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
      ])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider({ apiKey: "k" });
    await collectEvents(provider.chat(baseRequest({ model: "gemini-2.5-pro" })));

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/models/gemini-2.5-pro:streamGenerateContent");
    expect(url).toContain("alt=sse");
  });

  // -----------------------------------------------------------------------
  // listModels
  // -----------------------------------------------------------------------

  it("lists available models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiProvider({ apiKey: "k" });
    const models = await provider.listModels();

    // Should only include models that support generateContent.
    expect(models).toEqual(["gemini-2.0-flash", "gemini-2.5-pro"]);
    expect(models).not.toContain("embedding-001");
  });

  it("throws when listing models without API key", async () => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const provider = new GeminiProvider();
    await expect(provider.listModels()).rejects.toThrow("API key is required");
  });
});

// ---------------------------------------------------------------------------
// convertMessages
// ---------------------------------------------------------------------------

describe("convertMessages (Gemini)", () => {
  it("converts user messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
  });

  it("skips system messages (handled via systemInstruction)", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be helpful." }] },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", parts: [{ text: "Hi" }] });
  });

  it("converts assistant messages to model role", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "I can help!" }] },
    ];
    const result = convertMessages(messages);
    expect(result).toEqual([{ role: "model", parts: [{ text: "I can help!" }] }]);
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
    expect(result[0].role).toBe("model");
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0]).toEqual({ text: "Let me search." });
    expect(result[0].parts[1]).toEqual({
      functionCall: { name: "search", args: { query: "weather" } },
    });
  });

  it("converts tool result messages to functionResponse", () => {
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
        parts: [
          { functionResponse: { name: "call_1", response: { content: "Sunny, 72F" } } },
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
        parts: [
          { functionResponse: { name: "call_2", response: { content: "Result A and B" } } },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

describe("convertTools (Gemini)", () => {
  it("converts tool definitions to Gemini format", () => {
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
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path" } },
        required: ["path"],
      },
    });
    expect(result[1].name).toBe("write_file");
  });
});
