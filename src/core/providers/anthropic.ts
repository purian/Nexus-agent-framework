import Anthropic from "@anthropic-ai/sdk";
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
// Anthropic SDK type aliases (kept local to avoid leaking SDK types)
// ---------------------------------------------------------------------------

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;
type AnthropicTool = Anthropic.Tool;

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export interface AnthropicProviderOptions {
  apiKey?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey, // falls back to ANTHROPIC_API_KEY env var
    });
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
    const params = this.buildParams(request);

    const stream = this.client.messages.stream(params, {
      signal: signal ?? undefined,
    });

    // Track state for tool_use blocks so we can emit tool_use_end with
    // the fully-parsed JSON input when the block closes.
    let currentToolId: string | undefined;
    let currentToolName: string | undefined;
    let currentToolJson = "";
    let messageId = "";
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const event of stream) {
        switch (event.type) {
          // ---- message lifecycle ----

          case "message_start": {
            messageId = event.message.id;
            const u = event.message.usage;
            usage = {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheReadTokens: (u as unknown as Record<string, number | undefined>).cache_read_input_tokens,
              cacheWriteTokens: (u as unknown as Record<string, number | undefined>).cache_creation_input_tokens,
            };
            yield { type: "message_start", messageId };
            break;
          }

          case "message_delta": {
            if (event.delta.stop_reason) {
              stopReason = mapStopReason(event.delta.stop_reason);
            }
            if (event.usage) {
              usage.outputTokens += event.usage.output_tokens;
            }
            break;
          }

          case "message_stop": {
            yield { type: "message_end", stopReason, usage };
            break;
          }

          // ---- content blocks ----

          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              currentToolId = block.id;
              currentToolName = block.name;
              currentToolJson = "";
              yield { type: "tool_use_start", id: block.id, name: block.name };
            }
            // For text and thinking blocks we wait for deltas.
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", thinking: delta.thinking };
            } else if (delta.type === "input_json_delta") {
              currentToolJson += delta.partial_json;
              if (currentToolId) {
                yield {
                  type: "tool_use_delta",
                  id: currentToolId,
                  partialInput: delta.partial_json,
                };
              }
            }
            break;
          }

          case "content_block_stop": {
            if (currentToolId) {
              let input: Record<string, unknown> = {};
              try {
                input = currentToolJson
                  ? (JSON.parse(currentToolJson) as Record<string, unknown>)
                  : {};
              } catch {
                // If the JSON is malformed, pass what we have as a raw string.
                input = { _raw: currentToolJson };
              }
              yield { type: "tool_use_end", id: currentToolId, input };
              currentToolId = undefined;
              currentToolName = undefined;
              currentToolJson = "";
            }
            break;
          }
        }
      }
    } catch (err) {
      // If the stream throws (network error, abort, etc.) surface it.
      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  // -----------------------------------------------------------------------
  // Parameter building
  // -----------------------------------------------------------------------

  private buildParams(request: LLMRequest): Anthropic.MessageCreateParams {
    const messages = convertMessages(request.messages);
    const tools = request.tools ? convertTools(request.tools) : undefined;

    const params: Anthropic.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages,
      stream: true,
    };

    if (request.systemPrompt) {
      params.system = request.systemPrompt;
    }

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }

    if (request.stopSequences && request.stopSequences.length > 0) {
      params.stop_sequences = request.stopSequences;
    }

    if (request.thinking?.enabled) {
      const budgetTokens = request.thinking.budgetTokens ?? 10000;
      (params as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: budgetTokens,
      };
      // Extended thinking requires temperature = 1 and doesn't support
      // explicit temperature setting per Anthropic docs.
      delete (params as unknown as Record<string, unknown>).temperature;
    }

    return params;
  }
}

// ===========================================================================
// Conversion helpers
// ===========================================================================

/**
 * Convert our Message[] to the Anthropic SDK format.
 * System messages are stripped (they go in the top-level `system` param).
 */
function convertMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    const role = msg.role === "tool" ? "user" : msg.role;
    const content = convertContentBlocks(msg.content, msg.role);

    out.push({ role, content } as AnthropicMessage);
  }

  return out;
}

function convertContentBlocks(
  blocks: ContentBlock[],
  role: string,
): AnthropicContent[] {
  const out: AnthropicContent[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;

      case "tool_use":
        out.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;

      case "tool_result":
        out.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content:
            typeof block.content === "string"
              ? block.content
              : convertContentBlocks(block.content, role) as Anthropic.ToolResultBlockParam["content"],
          is_error: block.is_error,
        } as Anthropic.ToolResultBlockParam);
        break;

      case "thinking":
        out.push({
          type: "thinking",
          thinking: block.thinking,
        } as AnthropicContent);
        break;

      case "image":
        if (block.source.type === "base64") {
          out.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.source.media_type as Anthropic.ImageBlockParam["source"] extends { media_type: infer M } ? M : string,
              data: block.source.data,
            },
          } as AnthropicContent);
        }
        break;
    }
  }

  return out;
}

/** Convert our ToolDefinition[] to the Anthropic tool format. */
function convertTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** Map Anthropic stop reasons to our StopReason type. */
function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
