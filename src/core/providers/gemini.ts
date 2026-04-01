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
// Gemini API type aliases (kept local – no SDK dependency)
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: unknown } } };

interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: GeminiTool[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    stopSequences?: string[];
  };
}

// Streaming response chunk shape
interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// ---------------------------------------------------------------------------
// GeminiProvider
// ---------------------------------------------------------------------------

export interface GeminiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey =
      options.apiKey ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY ??
      "";
    this.baseUrl = (
      options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");
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

  async listModels(): Promise<string[]> {
    if (!this.apiKey) {
      throw new Error(
        "Google API key is required. Provide it in the constructor or set GOOGLE_API_KEY.",
      );
    }

    const response = await fetch(
      `${this.baseUrl}/models?key=${this.apiKey}`,
    );

    if (!response.ok) {
      throw new Error(
        `Gemini API error ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      models: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };

    return data.models
      .filter((m) =>
        m.supportedGenerationMethods?.includes("generateContent"),
      )
      .map((m) => m.name.replace(/^models\//, ""));
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
        "Google API key is required. Provide it in the constructor or set GOOGLE_API_KEY.",
      );
    }

    const body = this.buildRequestBody(request);
    const model = request.model || "gemini-2.0-flash";
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Gemini API error ${response.status}: ${response.statusText}${text ? ` – ${text}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error("Gemini response has no body");
    }

    let messageId = `gemini-${Date.now()}`;
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let emittedStart = false;
    // Track tool calls so we can emit start/delta/end events.
    let toolCallCounter = 0;

    for await (const chunk of this.parseSSEStream(response.body)) {
      if (!emittedStart) {
        yield { type: "message_start", messageId };
        emittedStart = true;
      }

      const candidate = chunk.candidates?.[0];

      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          // --- text content ---
          if (part.text) {
            yield { type: "text_delta", text: part.text };
          }

          // --- function calls ---
          if (part.functionCall) {
            const id = `gemini-call-${toolCallCounter++}`;
            const name = part.functionCall.name;
            const args = part.functionCall.args ?? {};
            const argsJson = JSON.stringify(args);

            yield { type: "tool_use_start", id, name };
            yield { type: "tool_use_delta", id, partialInput: argsJson };
            yield { type: "tool_use_end", id, input: args };
          }
        }
      }

      // --- finish reason ---
      if (candidate?.finishReason) {
        stopReason = mapFinishReason(candidate.finishReason);
      }

      // --- usage ---
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
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
  ): AsyncGenerator<GeminiStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          const lines = part.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;

            try {
              const chunk = JSON.parse(data) as GeminiStreamChunk;
              yield chunk;
            } catch {
              // Skip malformed JSON lines.
            }
          }
        }
      }

      // Process remaining buffer.
      if (buffer.trim()) {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as GeminiStreamChunk;
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

  private buildRequestBody(request: LLMRequest): GeminiGenerateRequest {
    const contents = convertMessages(request.messages);
    const tools = request.tools ? convertTools(request.tools) : undefined;

    const body: GeminiGenerateRequest = { contents };

    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: tools }];
    }

    const genConfig: GeminiGenerateRequest["generationConfig"] = {};
    if (request.maxTokens !== undefined) {
      genConfig.maxOutputTokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      genConfig.temperature = request.temperature;
    }
    if (request.stopSequences && request.stopSequences.length > 0) {
      genConfig.stopSequences = request.stopSequences;
    }
    if (Object.keys(genConfig).length > 0) {
      body.generationConfig = genConfig;
    }

    return body;
  }
}

// ===========================================================================
// Conversion helpers (exported for testing)
// ===========================================================================

/**
 * Convert our Message[] to Gemini's content format.
 * Gemini uses "user" and "model" roles. System messages are handled via
 * systemInstruction, so they are skipped here.
 */
export function convertMessages(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // System messages are handled via systemInstruction, skip here.
      continue;
    }

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        out.push({ role: "user", parts: [{ text }] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = extractText(msg.content);
      if (text) {
        parts.push({ text });
      }

      // Convert tool_use blocks to functionCall parts.
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          parts.push({
            functionCall: { name: block.name, args: block.input },
          });
        }
      }

      if (parts.length > 0) {
        out.push({ role: "model", parts });
      }
      continue;
    }

    if (msg.role === "tool") {
      // Tool results become functionResponse parts on the "user" role.
      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : extractText(block.content);
          parts.push({
            functionResponse: {
              name: block.tool_use_id,
              response: { content: content || "" },
            },
          });
        }
      }
      if (parts.length > 0) {
        out.push({ role: "user", parts });
      }
      continue;
    }
  }

  return out;
}

/** Convert our ToolDefinition[] to Gemini function declaration format. */
export function convertTools(
  tools: ToolDefinition[],
): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
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

/** Map Gemini finish reasons to our StopReason type. */
function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
      return "end_turn";
    case "RECITATION":
      return "end_turn";
    case "STOP_SEQUENCE":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
