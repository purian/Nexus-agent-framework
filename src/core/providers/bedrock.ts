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
// Bedrock Converse API type aliases (local — mirrors SDK shapes we consume)
// ---------------------------------------------------------------------------

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

type BedrockContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }> } };

interface BedrockToolSpec {
  name: string;
  description: string;
  inputSchema: { json: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// BedrockProvider
// ---------------------------------------------------------------------------

export interface BedrockProviderOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export class BedrockProvider implements LLMProvider {
  readonly name = "bedrock";
  private region: string;
  private credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

  constructor(options: BedrockProviderOptions = {}) {
    this.region =
      options.region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-east-1";

    if (options.accessKeyId && options.secretAccessKey) {
      this.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
      };
    }
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
    const { BedrockClient, ListFoundationModelsCommand } = await import(
      "@aws-sdk/client-bedrock"
    );

    const client = new BedrockClient({
      region: this.region,
      ...(this.credentials && { credentials: this.credentials }),
    });

    const response = await client.send(new ListFoundationModelsCommand({}));

    return (response.modelSummaries ?? [])
      .filter((m: { inferenceTypesSupported?: string[] }) =>
        m.inferenceTypesSupported?.includes("ON_DEMAND"),
      )
      .map((m: { modelId?: string }) => m.modelId!)
      .filter(Boolean);
  }

  // -----------------------------------------------------------------------
  // Streaming implementation
  // -----------------------------------------------------------------------

  private async *streamChat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const { BedrockRuntimeClient, ConverseStreamCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );

    const client = new BedrockRuntimeClient({
      region: this.region,
      ...(this.credentials && { credentials: this.credentials }),
    });

    const messages = convertMessages(request.messages);
    const toolSpecs = request.tools ? convertTools(request.tools) : undefined;

    const commandInput: Record<string, unknown> = {
      modelId: request.model || "anthropic.claude-3-5-sonnet-20241022-v2:0",
      messages,
    };

    if (request.systemPrompt) {
      commandInput.system = [{ text: request.systemPrompt }];
    }

    if (toolSpecs && toolSpecs.length > 0) {
      commandInput.toolConfig = { tools: toolSpecs };
    }

    const inferenceConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) {
      inferenceConfig.maxTokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      inferenceConfig.temperature = request.temperature;
    }
    if (request.stopSequences && request.stopSequences.length > 0) {
      inferenceConfig.stopSequences = request.stopSequences;
    }
    if (Object.keys(inferenceConfig).length > 0) {
      commandInput.inferenceConfig = inferenceConfig;
    }

    const command = new ConverseStreamCommand(commandInput);
    const response = await client.send(command, {
      abortSignal: signal,
    });

    if (!response.stream) {
      throw new Error("Bedrock ConverseStream returned no event stream");
    }

    const messageId = `bedrock-${Date.now()}`;
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let emittedStart = false;

    // Track tool use blocks by contentBlockIndex.
    const toolUseBlocks = new Map<
      number,
      { id: string; name: string; input: string }
    >();

    for await (const event of response.stream) {
      if (!emittedStart) {
        yield { type: "message_start", messageId };
        emittedStart = true;
      }

      // --- contentBlockStart ---
      if (event.contentBlockStart) {
        const start = event.contentBlockStart.start;
        if (start?.toolUse) {
          const idx = event.contentBlockStart.contentBlockIndex ?? 0;
          const id = start.toolUse.toolUseId ?? `bedrock-tool-${idx}`;
          const name = start.toolUse.name ?? "";
          toolUseBlocks.set(idx, { id, name, input: "" });
          yield { type: "tool_use_start", id, name };
        }
      }

      // --- contentBlockDelta ---
      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        const idx = event.contentBlockDelta.contentBlockIndex ?? 0;

        if (delta?.text) {
          yield { type: "text_delta", text: delta.text };
        }

        if (delta?.toolUse) {
          const block = toolUseBlocks.get(idx);
          if (block) {
            const fragment = delta.toolUse.input ?? "";
            block.input += fragment;
            yield {
              type: "tool_use_delta",
              id: block.id,
              partialInput: fragment,
            };
          }
        }
      }

      // --- contentBlockStop ---
      if (event.contentBlockStop !== undefined) {
        const idx =
          typeof event.contentBlockStop === "object"
            ? (event.contentBlockStop.contentBlockIndex ?? 0)
            : 0;
        const block = toolUseBlocks.get(idx);
        if (block) {
          let input: Record<string, unknown> = {};
          try {
            input = block.input
              ? (JSON.parse(block.input) as Record<string, unknown>)
              : {};
          } catch {
            input = { _raw: block.input };
          }
          yield { type: "tool_use_end", id: block.id, input };
          toolUseBlocks.delete(idx);
        }
      }

      // --- messageStop ---
      if (event.messageStop) {
        stopReason = mapStopReason(event.messageStop.stopReason ?? "end_turn");
      }

      // --- metadata (usage) ---
      if (event.metadata) {
        const u = event.metadata.usage;
        if (u) {
          usage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
          };
        }
      }
    }

    yield { type: "message_end", stopReason, usage };
  }
}

// ===========================================================================
// Conversion helpers (exported for testing)
// ===========================================================================

/**
 * Convert our Message[] to Bedrock Converse message format.
 * Bedrock uses "user" and "assistant" roles. System messages are handled via
 * the top-level `system` parameter, so they are skipped here. Tool results
 * are sent as user messages with toolResult content blocks.
 */
export function convertMessages(messages: Message[]): BedrockMessage[] {
  const out: BedrockMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      continue;
    }

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) {
        out.push({ role: "user", content: [{ text }] });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const content: BedrockContentBlock[] = [];
      const text = extractText(msg.content);
      if (text) {
        content.push({ text });
      }

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          content.push({
            toolUse: {
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            },
          });
        }
      }

      if (content.length > 0) {
        out.push({ role: "assistant", content });
      }
      continue;
    }

    if (msg.role === "tool") {
      const content: BedrockContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const text =
            typeof block.content === "string"
              ? block.content
              : extractText(block.content);
          content.push({
            toolResult: {
              toolUseId: block.tool_use_id,
              content: [{ text: text || "" }],
            },
          });
        }
      }
      if (content.length > 0) {
        out.push({ role: "user", content });
      }
      continue;
    }
  }

  return out;
}

/** Convert our ToolDefinition[] to Bedrock toolSpec format. */
export function convertTools(
  tools: ToolDefinition[],
): Array<{ toolSpec: BedrockToolSpec }> {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.inputSchema },
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

/** Map Bedrock stop reasons to our StopReason type. */
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
