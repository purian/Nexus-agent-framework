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
// OllamaProvider
// ---------------------------------------------------------------------------

export interface OllamaProviderOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private baseUrl: string;
  private apiKey?: string;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434/v1").replace(
      /\/$/,
      "",
    );
    this.apiKey = options.apiKey;
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
      const error = err instanceof Error ? err : new Error(String(err));
      if (isConnectionError(error)) {
        yield {
          type: "error",
          error: new Error(
            `Cannot connect to Ollama at ${this.baseUrl.replace(/\/v1$/, "")}. Is Ollama running?`,
          ),
        };
      } else {
        yield { type: "error", error };
      }
    }
  }

  async listModels(): Promise<string[]> {
    // Ollama's native /api/tags endpoint lives at the base URL without /v1
    const nativeBase = this.baseUrl.replace(/\/v1$/, "");
    const res = await fetch(`${nativeBase}/api/tags`, {
      headers: this.buildHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { models: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  }

  // -----------------------------------------------------------------------
  // Streaming implementation
  // -----------------------------------------------------------------------

  private async *streamChat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const body = this.buildRequestBody(request);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.buildHeaders(),
      },
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Ollama API error: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
      );
    }

    if (!res.body) {
      throw new Error("Response body is null");
    }

    // State tracking
    const messageId = `ollama-${Date.now()}`;
    let stopReason: StopReason = "end_turn";
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let currentToolId: string | undefined;
    let currentToolJson = "";
    let yieldedStart = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;

          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(payload) as OpenAIStreamChunk;
          } catch {
            continue;
          }

          // Emit message_start on first chunk
          if (!yieldedStart) {
            yieldedStart = true;
            yield { type: "message_start", messageId };
          }

          // Extract usage if present
          if (parsed.usage) {
            usage.inputTokens = parsed.usage.prompt_tokens ?? 0;
            usage.outputTokens = parsed.usage.completion_tokens ?? 0;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: "text_delta", text: delta.content };
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              // New tool call starting
              if (tc.function?.name) {
                // Close previous tool if any
                if (currentToolId) {
                  yield buildToolUseEnd(currentToolId, currentToolJson);
                  currentToolJson = "";
                }
                currentToolId = tc.id ?? `tool-${Date.now()}-${tc.index ?? 0}`;
                yield {
                  type: "tool_use_start",
                  id: currentToolId,
                  name: tc.function.name,
                };
              }

              // Accumulate arguments
              if (tc.function?.arguments) {
                currentToolJson += tc.function.arguments;
                if (currentToolId) {
                  yield {
                    type: "tool_use_delta",
                    id: currentToolId,
                    partialInput: tc.function.arguments,
                  };
                }
              }
            }
          }

          // Finish reason
          if (choice.finish_reason) {
            stopReason = mapFinishReason(choice.finish_reason);
          }
        }
      }

      // Close any open tool call
      if (currentToolId) {
        yield buildToolUseEnd(currentToolId, currentToolJson);
      }

      // Ensure we yield message_start even for empty responses
      if (!yieldedStart) {
        yield { type: "message_start", messageId };
      }

      yield { type: "message_end", stopReason, usage };
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

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      body.stop = request.stopSequences;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

// ===========================================================================
// OpenAI-compatible types (minimal, for SSE parsing)
// ===========================================================================

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: OpenAITool[];
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIStreamChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ===========================================================================
// Conversion helpers
// ===========================================================================

/**
 * Convert our Message[] to OpenAI chat format.
 * System prompt is prepended as a system message.
 */
function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: extractText(msg.content) });
      continue;
    }

    if (msg.role === "tool") {
      // Tool result messages: each tool_result block becomes a separate message
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : extractText(block.content as ContentBlock[]),
          });
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      // Check for tool_use blocks
      const toolCalls = msg.content.filter((b) => b.type === "tool_use");
      const textContent = extractText(msg.content);

      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: textContent || null,
          tool_calls: toolCalls.map((tc) => {
            if (tc.type !== "tool_use") throw new Error("unreachable");
            return {
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            };
          }),
        });
      } else {
        out.push({ role: "assistant", content: textContent });
      }
      continue;
    }

    // User messages
    out.push({ role: "user", content: extractText(msg.content) });
  }

  return out;
}

/** Extract text from content blocks. */
function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");
}

/** Convert our ToolDefinition[] to OpenAI function calling format. */
function convertTools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
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
    default:
      return "end_turn";
  }
}

/** Build a tool_use_end event from accumulated JSON. */
function buildToolUseEnd(
  id: string,
  json: string,
): LLMEvent & { type: "tool_use_end" } {
  let input: Record<string, unknown> = {};
  try {
    input = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    input = { _raw: json };
  }
  return { type: "tool_use_end", id, input };
}

/** Check if an error is a connection error. */
function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("enotfound") ||
    msg.includes("connect")
  );
}
