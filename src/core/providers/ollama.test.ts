import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "./ollama.js";
import type { LLMRequest, LLMEvent, Message } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream from SSE text lines. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.map((l) => `data: ${l}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Collect all events from an async generator. */
async function collectEvents(
  gen: AsyncGenerator<LLMEvent>,
): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** A minimal LLMRequest for testing. */
function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "llama3",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OllamaProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Basic properties
  // -----------------------------------------------------------------------

  it("has name 'ollama'", () => {
    const provider = new OllamaProvider();
    expect(provider.name).toBe("ollama");
  });

  it("uses default baseUrl when not specified", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider();
    await collectEvents(provider.chat(makeRequest()));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/v1/chat/completions",
      expect.anything(),
    );
  });

  it("uses custom baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider({ baseUrl: "http://myhost:9999/v1" });
    await collectEvents(provider.chat(makeRequest()));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://myhost:9999/v1/chat/completions",
      expect.anything(),
    );
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider({ baseUrl: "http://myhost:9999/v1/" });
    await collectEvents(provider.chat(makeRequest()));

    expect(fetchMock).toHaveBeenCalledWith(
      "http://myhost:9999/v1/chat/completions",
      expect.anything(),
    );
  });

  // -----------------------------------------------------------------------
  // Simple text streaming
  // -----------------------------------------------------------------------

  it("streams a simple text response", async () => {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ delta: { content: "Hello" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ delta: { content: " world" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      "[DONE]",
    ];

    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(chunks),
    });

    const provider = new OllamaProvider();
    const events = await collectEvents(provider.chat(makeRequest()));

    expect(events[0]).toEqual({
      type: "message_start",
      messageId: expect.stringContaining("ollama-"),
    });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(textDeltas[1]).toEqual({ type: "text_delta", text: " world" });

    const end = events.find((e) => e.type === "message_end");
    expect(end).toEqual({
      type: "message_end",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  // -----------------------------------------------------------------------
  // Tool use flow
  // -----------------------------------------------------------------------

  it("handles tool call streaming", async () => {
    const chunks = [
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc123",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"city":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"Paris"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 15 },
      }),
      "[DONE]",
    ];

    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(chunks),
    });

    const provider = new OllamaProvider();
    const events = await collectEvents(provider.chat(makeRequest()));

    const toolStart = events.find((e) => e.type === "tool_use_start");
    expect(toolStart).toEqual({
      type: "tool_use_start",
      id: "call_abc123",
      name: "get_weather",
    });

    const toolDeltas = events.filter((e) => e.type === "tool_use_delta");
    expect(toolDeltas).toHaveLength(2);

    const toolEnd = events.find((e) => e.type === "tool_use_end");
    expect(toolEnd).toEqual({
      type: "tool_use_end",
      id: "call_abc123",
      input: { city: "Paris" },
    });

    const msgEnd = events.find((e) => e.type === "message_end");
    expect(msgEnd).toMatchObject({ stopReason: "tool_use" });
  });

  // -----------------------------------------------------------------------
  // Connection error handling
  // -----------------------------------------------------------------------

  it("yields helpful error when Ollama is not running", async () => {
    const connError = new TypeError("fetch failed: ECONNREFUSED");
    fetchMock.mockRejectedValue(connError);

    const provider = new OllamaProvider();
    const events = await collectEvents(provider.chat(makeRequest()));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].error.message).toContain(
        "Cannot connect to Ollama at http://localhost:11434",
      );
      expect(events[0].error.message).toContain("Is Ollama running?");
    }
  });

  it("yields generic error for non-connection errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: () => Promise.resolve("something broke"),
    });

    const provider = new OllamaProvider();
    const events = await collectEvents(provider.chat(makeRequest()));

    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    if (errEvent?.type === "error") {
      expect(errEvent.error.message).toContain("500");
    }
  });

  // -----------------------------------------------------------------------
  // listModels
  // -----------------------------------------------------------------------

  it("lists models from /api/tags", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          models: [
            { name: "llama3:latest" },
            { name: "mistral:7b" },
            { name: "codellama:13b" },
          ],
        }),
    });

    const provider = new OllamaProvider();
    const models = await provider.listModels();

    expect(models).toEqual(["llama3:latest", "mistral:7b", "codellama:13b"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything(),
    );
  });

  it("lists models using custom baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: "phi3:latest" }] }),
    });

    const provider = new OllamaProvider({
      baseUrl: "http://remote:8080/v1",
    });
    const models = await provider.listModels();

    expect(models).toEqual(["phi3:latest"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:8080/api/tags",
      expect.anything(),
    );
  });

  it("returns empty array when no models", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    });

    const provider = new OllamaProvider();
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Message conversion
  // -----------------------------------------------------------------------

  it("converts messages with system prompt", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider();
    await collectEvents(
      provider.chat(
        makeRequest({
          systemPrompt: "You are a helpful assistant.",
        }),
      ),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "Hello",
    });
  });

  it("converts tool result messages", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "What is the weather?" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: "Sunny, 22C",
          },
        ],
      },
    ];

    const provider = new OllamaProvider();
    await collectEvents(provider.chat(makeRequest({ messages })));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    // Assistant message with tool_calls
    expect(body.messages[0]).toEqual({
      role: "user",
      content: "What is the weather?",
    });
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_123",
      content: "Sunny, 22C",
    });
  });

  // -----------------------------------------------------------------------
  // Tool definition conversion
  // -----------------------------------------------------------------------

  it("converts tool definitions to OpenAI function format", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider();
    await collectEvents(
      provider.chat(
        makeRequest({
          tools: [
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
          ],
        }),
      ),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
          },
        },
      },
    ]);
  });

  // -----------------------------------------------------------------------
  // API key header
  // -----------------------------------------------------------------------

  it("sends Authorization header when apiKey is provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider({ apiKey: "my-secret-key" });
    await collectEvents(provider.chat(makeRequest()));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer my-secret-key");
  });

  it("does not send Authorization header when no apiKey", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider();
    await collectEvents(provider.chat(makeRequest()));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Request parameters
  // -----------------------------------------------------------------------

  it("passes temperature and stop sequences", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStream(["[DONE]"]),
    });

    const provider = new OllamaProvider();
    await collectEvents(
      provider.chat(
        makeRequest({
          temperature: 0.7,
          maxTokens: 1024,
          stopSequences: ["END"],
        }),
      ),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
    expect(body.stop).toEqual(["END"]);
    expect(body.stream).toBe(true);
  });
});
