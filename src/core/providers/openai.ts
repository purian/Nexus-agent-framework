import type {
  LLMProvider,
  LLMRequest,
  LLMEvent,
  Message,
  ContentBlock,
  ToolDefinition,
  StopReason,
  TokenUsage,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// OpenAI API type aliases (kept local – no SDK dependency)
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream_options?: { include_usage: boolean };
}

// SSE chunk shapes (partial – only fields we consume)
interface OpenAIChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface OpenAIChunkChoice {
  index: number;
  delta: OpenAIChunkDelta;
  finish_reason: string | null;
}

interface OpenAIChunkUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAIChunk {
  id: string;
  choices: OpenAIChunkChoice[];
  usage?: OpenAIChunkUsage | null;
}

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private apiKey: string;
  private baseUrl: string;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async *chat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    try {
      yield* this.streamChat(request, signal);
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  // -----------------------------------------------------------------------
  // Streaming implementation
  // -----------------------------------------------------------------------

  private async *streamChat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    if (!this.apiKey) {
      throw new Error(
        "OpenAI API key is required. Provide it in the constructor or set OPENAI_API_KEY.",
      );
    }

    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `OpenAI API error ${response.status}: ${response.statusText}${text ? ` – ${text}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("OpenAI response has no body");
    }

    // Track tool call accumulation across chunks.
    // OpenAI streams tool_calls piecemeal: first chunk has id+name, subsequent
    // chunks only have arguments fragments, keyed by `index`.
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    let messageId = "";
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let emittedStart = false;

    for await (const chunk of this.parseSSEStream(response.body)) {
      if (!emittedStart) {
        messageId = chunk.id ?? `openai-${Date.now()}`;
        yield { type: "message_start", messageId };
        emittedStart = true;
      }

      const choice = chunk.choices?.[0];

      if (choice) {
        const delta = choice.delta;

        // --- text content ---
        if (delta.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // --- tool calls ---
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let entry = toolCalls.get(idx);

            if (tc.id && tc.function?.name) {
              // First chunk for this tool call – start it.
              entry = { id: tc.id, name: tc.function.name, arguments: "" };
              toolCalls.set(idx, entry);
              yield { type: "tool_use_start", id: tc.id, name: tc.function.name };
            }

            if (tc.function?.arguments && entry) {
              entry.arguments += tc.function.arguments;
              yield {
                type: "tool_use_delta",
                id: entry.id,
                partialInput: tc.function.arguments,
              };
            }
          }
        }

        // --- finish reason ---
        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason);

          // When the model finishes with tool_calls, close all accumulated tool calls.
          if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
            for (const [, entry] of toolCalls) {
              let input: Record<string, unknown> = {};
              try {
                input = entry.arguments
                  ? (JSON.parse(entry.arguments) as Record<string, unknown>)
                  : {};
              } catch {
                input = { _raw: entry.arguments };
              }
              yield { type: "tool_use_end", id: entry.id, input };
            }
            toolCalls.clear();
          }
        }
      }

      // --- usage (often in the final chunk) ---
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
    }

    yield { type: "message_end", stopReason, usage };
  }

  // -----------------------------------------------------------------------
  // SSE parser
  // -----------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<OpenAIChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by double newlines.
        const parts = buffer.split("\n\n");
        // The last part may be incomplete – keep it in the buffer.
        buffer = parts.pop()!;

        for (const part of parts) {
          const lines = part.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;

            try {
              const chunk = JSON.parse(data) as OpenAIChunk;
              yield chunk;
            } catch {
              // Skip malformed JSON lines.
            }
          }
        }
      }

      // Process any remaining buffer.
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as OpenAIChunk;
            yield chunk;
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // -----------------------------------------------------------------------
  // Request building
  // -----------------------------------------------------------------------

  private buildRequestBody(request: LLMRequest): OpenAIChatRequest {
    const messages = convertMessages(request.messages, request.systemPrompt);
    const tools = request.tools ? convertTools(request.tools) : undefined;

    const body: OpenAIChatRequest = {
      model: request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop = request.stopSequences;
    }

    return body;
  }
}

// ===========================================================================
// Conversion helpers (exported for testing)
// ===========================================================================

/**
 * Convert our Message[] to OpenAI's chat message format.
 * System prompt is prepended as the first message.
 */
export function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      // System messages from the conversation become system messages.
      const text = extractText(msg.content);
      if (text) out.push({ role: "system", content: text });
      continue;
    }

    if (msg.role === "tool") {
      // Tool result messages – one per tool_result block.
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : extractText(block.content);
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: content || "",
          });
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      const text = extractText(msg.content);
      const toolCalls = extractToolCalls(msg.content);

      const m: OpenAIMessage = { role: "assistant" };
      if (text) m.content = text;
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      // OpenAI requires at least content or tool_calls.
      if (!text && toolCalls.length === 0) m.content = "";
      out.push(m);
      continue;
    }

    // user
    const text = extractText(msg.content);
    out.push({ role: "user", content: text || "" });
  }

  return out;
}

/** Convert our ToolDefinition[] to OpenAI function calling format. */
export function convertTools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractToolCalls(blocks: ContentBlock[]): OpenAIToolCall[] {
  return blocks
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use",
    )
    .map((b) => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));
}

/** Map OpenAI finish reasons to our StopReason type. */
function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}
