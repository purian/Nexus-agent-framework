import { EventEmitter } from "eventemitter3";
import { v4 as uuid } from "uuid";
import type {
  EngineEvent,
  LLMEvent,
  LLMProvider,
  LLMRequest,
  Message,
  NexusConfig,
  PermissionContext,
  PermissionDecision,
  StopReason,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "../types/index.js";
import { ToolExecutor } from "./tool-executor.js";

/**
 * NexusEngine — the core agent loop.
 *
 * Implements the pattern learned from Claude Code's QueryEngine:
 *   User Input → LLM API → Tool Execution → Feed Results → Repeat
 *
 * Key architectural decisions inspired by Claude Code:
 * - Async generator for streaming events (real-time UI updates)
 * - Tool concurrency safety model (safe tools run in parallel)
 * - Permission checks before every tool execution
 * - Token budget tracking with auto-continue logic
 * - Abort signal propagation throughout the chain
 */
export class NexusEngine extends EventEmitter<{
  event: [EngineEvent];
}> {
  private provider: LLMProvider;
  private tools: Map<string, Tool> = new Map();
  private config: NexusConfig;
  private permissions: PermissionContext;
  private messages: Message[] = [];
  private totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };
  private abortController: AbortController = new AbortController();

  constructor(
    provider: LLMProvider,
    config: NexusConfig,
    permissions: PermissionContext,
  ) {
    super();
    this.provider = provider;
    this.config = config;
    this.permissions = permissions;
  }

  // ---------------------------------------------------------------------------
  // Tool Registration
  // ---------------------------------------------------------------------------

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  // ---------------------------------------------------------------------------
  // Main Entry Point
  // ---------------------------------------------------------------------------

  /**
   * Submit a user message and run the agent loop until completion.
   * Yields EngineEvents for real-time UI rendering.
   */
  async *run(
    userMessage: string,
    options?: {
      systemPrompt?: string;
      maxTurns?: number;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<EngineEvent> {
    const signal = options?.signal ?? this.abortController.signal;
    const maxTurns = options?.maxTurns ?? 50;

    // Add user message to history
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userMessage }],
    });

    let turnCount = 0;

    // Main agent loop: keep going while the LLM wants to use tools
    while (turnCount < maxTurns) {
      if (signal.aborted) break;

      turnCount++;
      yield { type: "turn_start", turnNumber: turnCount };

      // Build LLM request
      const request = this.buildRequest(options?.systemPrompt);

      // Stream LLM response
      const { assistantMessage, stopReason, usage } = yield* this.streamLLMResponse(request, signal);

      // Track usage
      this.accumulateUsage(usage);

      // Check budget
      if (this.config.maxBudgetUsd && this.estimateCostUsd() >= this.config.maxBudgetUsd) {
        yield { type: "error", error: new Error(`Budget limit reached: $${this.config.maxBudgetUsd}`) };
        break;
      }

      // Add assistant message to history
      this.messages.push(assistantMessage);

      yield { type: "turn_end", stopReason, usage };

      // If no tool use, we're done
      if (stopReason !== "tool_use") break;

      // Extract tool use blocks and execute them
      const toolUseBlocks = assistantMessage.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUseBlocks.length === 0) break;

      // Execute tools (respecting concurrency safety)
      const toolResults = yield* this.executeTools(toolUseBlocks, signal);

      // Add tool results as a user message (API convention)
      this.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    yield { type: "done", totalUsage: { ...this.totalUsage } };
  }

  // ---------------------------------------------------------------------------
  // LLM Streaming
  // ---------------------------------------------------------------------------

  private async *streamLLMResponse(
    request: LLMRequest,
    signal: AbortSignal,
  ): AsyncGenerator<
    EngineEvent,
    { assistantMessage: Message; stopReason: StopReason; usage: TokenUsage }
  > {
    const contentBlocks: (TextBlock | ToolUseBlock | ThinkingBlock)[] = [];
    let currentToolInput = "";
    let currentToolId = "";
    let stopReason: StopReason = "end_turn";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    const stream = this.provider.chat(request, signal);

    for await (const event of stream) {
      switch (event.type) {
        case "text_delta": {
          // Append to current text block or create new one
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock?.type === "text") {
            lastBlock.text += event.text;
          } else {
            contentBlocks.push({ type: "text", text: event.text });
          }
          yield { type: "text", text: event.text };
          break;
        }

        case "thinking_delta": {
          const lastBlock = contentBlocks[contentBlocks.length - 1];
          if (lastBlock?.type === "thinking") {
            lastBlock.thinking += event.thinking;
          } else {
            contentBlocks.push({ type: "thinking", thinking: event.thinking });
          }
          yield { type: "thinking", text: event.thinking };
          break;
        }

        case "tool_use_start": {
          currentToolId = event.id;
          currentToolInput = "";
          contentBlocks.push({
            type: "tool_use",
            id: event.id,
            name: event.name,
            input: {},
          });
          break;
        }

        case "tool_use_delta": {
          currentToolInput += event.partialInput;
          break;
        }

        case "tool_use_end": {
          // Find the tool_use block and set its final input
          const toolBlock = contentBlocks.find(
            (b): b is ToolUseBlock =>
              b.type === "tool_use" && b.id === event.id,
          );
          if (toolBlock) {
            toolBlock.input = event.input;
          }

          yield {
            type: "tool_start",
            toolName: toolBlock?.name ?? "unknown",
            toolUseId: event.id,
            input: event.input,
          };
          break;
        }

        case "message_end": {
          stopReason = event.stopReason;
          usage = event.usage;
          break;
        }

        case "error": {
          yield { type: "error", error: event.error };
          break;
        }
      }
    }

    return {
      assistantMessage: { role: "assistant", content: contentBlocks },
      stopReason,
      usage,
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Execution (with concurrency safety from Claude Code patterns)
  // ---------------------------------------------------------------------------

  private async *executeTools(
    toolUseBlocks: ToolUseBlock[],
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent, ToolResultBlock[]> {
    const executor = new ToolExecutor(
      this.tools,
      this.permissions,
      this.config,
      signal,
    );

    const results: ToolResultBlock[] = [];

    // Partition into concurrent batches (pattern from Claude Code)
    const batches = this.partitionToolCalls(toolUseBlocks);

    for (const batch of batches) {
      if (signal.aborted) break;

      const batchPromises = batch.map(async (block) => {
        const tool = this.tools.get(block.name);
        if (!tool) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: Unknown tool "${block.name}"`,
            is_error: true,
          };
        }

        // Check permissions
        const decision = await this.checkToolPermission(tool, block.input);

        if (decision.behavior === "deny") {
          this.emit("event", {
            type: "tool_end",
            toolUseId: block.id,
            result: `Permission denied: ${decision.reason}`,
            isError: true,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Permission denied: ${decision.reason}`,
            is_error: true,
          };
        }

        if (decision.behavior === "ask") {
          // Emit permission request and wait for resolution
          const resolvedDecision = await new Promise<PermissionDecision>(
            (resolve) => {
              this.emit("event", {
                type: "permission_request",
                toolName: block.name,
                input: block.input,
                resolve,
              });
            },
          );

          if (resolvedDecision.behavior !== "allow") {
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: "Permission denied by user",
              is_error: true,
            };
          }
        }

        // Execute tool
        const context: ToolContext = {
          workingDirectory: this.config.workingDirectory,
          abortSignal: signal,
          permissions: this.permissions,
          config: this.config,
          onProgress: (progress) => {
            this.emit("event", {
              type: "tool_progress",
              toolUseId: block.id,
              progress,
            });
          },
        };

        try {
          const parseResult = tool.inputSchema.safeParse(block.input);
          if (!parseResult.success) {
            throw new Error(
              `Invalid input: ${parseResult.error.message}`,
            );
          }

          const result = await tool.execute(parseResult.data, context);
          const resultStr =
            typeof result.data === "string"
              ? result.data
              : JSON.stringify(result.data, null, 2);

          // Truncate large results
          const maxSize = tool.maxResultSize ?? 100_000;
          const truncated =
            resultStr.length > maxSize
              ? `${resultStr.slice(0, maxSize)}\n\n[Result truncated — ${resultStr.length} chars total]`
              : resultStr;

          this.emit("event", {
            type: "tool_end",
            toolUseId: block.id,
            result: truncated,
            isError: false,
          });

          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: truncated,
          };
        } catch (err) {
          const errorMsg =
            err instanceof Error ? err.message : String(err);
          this.emit("event", {
            type: "tool_end",
            toolUseId: block.id,
            result: errorMsg,
            isError: true,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: ${errorMsg}`,
            is_error: true,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Yield tool_end events are already emitted inside the promises
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Tool Batching (from Claude Code's partitionToolCalls pattern)
  // ---------------------------------------------------------------------------

  /**
   * Groups tool calls into batches that can run concurrently.
   * Concurrent-safe tools are grouped together; non-safe tools get their own batch.
   */
  private partitionToolCalls(blocks: ToolUseBlock[]): ToolUseBlock[][] {
    const batches: ToolUseBlock[][] = [];
    let currentBatch: ToolUseBlock[] = [];
    let currentBatchIsSafe = true;

    for (const block of blocks) {
      const tool = this.tools.get(block.name);
      const isSafe = tool?.isConcurrencySafe(block.input) ?? false;

      if (isSafe && currentBatchIsSafe) {
        // Add to current safe batch
        currentBatch.push(block);
      } else if (!isSafe) {
        // Flush current batch, then create a single-item batch
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        batches.push([block]);
        currentBatch = [];
        currentBatchIsSafe = true;
      } else {
        // Transitioning from unsafe to safe
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = [block];
        currentBatchIsSafe = true;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  // ---------------------------------------------------------------------------
  // Permission Checking
  // ---------------------------------------------------------------------------

  private async checkToolPermission(
    tool: Tool,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // Tool-specific permission check
    if (tool.checkPermissions) {
      const toolContext: ToolContext = {
        workingDirectory: this.config.workingDirectory,
        abortSignal: this.abortController.signal,
        permissions: this.permissions,
        config: this.config,
      };
      const decision = await tool.checkPermissions(input, toolContext);
      if (decision.behavior !== "allow") return decision;
    }

    // Global permission check
    return this.permissions.checkPermission(tool.name, input);
  }

  // ---------------------------------------------------------------------------
  // Request Building
  // ---------------------------------------------------------------------------

  private buildRequest(customSystemPrompt?: string): LLMRequest {
    const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: this.zodToJsonSchema(tool.inputSchema),
      }),
    );

    return {
      model: this.config.defaultModel,
      messages: this.messages,
      systemPrompt: customSystemPrompt ?? this.buildSystemPrompt(),
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      maxTokens: 8192,
      thinking: this.config.thinking,
    };
  }

  private buildSystemPrompt(): string {
    const parts = [
      "You are Nexus, a personal AI agent that helps users accomplish tasks.",
      "You have access to tools that let you interact with the user's system.",
      "Always use the most appropriate tool for the task.",
      "Be concise and direct in your responses.",
    ];

    if (this.tools.size > 0) {
      parts.push(
        `\nYou have ${this.tools.size} tools available. Use them when appropriate.`,
      );
    }

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private accumulateUsage(usage: TokenUsage): void {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    this.totalUsage.cacheReadTokens =
      (this.totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    this.totalUsage.cacheWriteTokens =
      (this.totalUsage.cacheWriteTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0);
  }

  private estimateCostUsd(): number {
    // Rough estimate based on Claude Sonnet pricing
    const inputCost = (this.totalUsage.inputTokens / 1_000_000) * 3;
    const outputCost = (this.totalUsage.outputTokens / 1_000_000) * 15;
    return inputCost + outputCost;
  }

  private zodToJsonSchema(schema: unknown): Record<string, unknown> {
    // Simple Zod-to-JSON-Schema conversion
    // In production, use zod-to-json-schema package
    if (schema && typeof schema === "object" && "description" in schema) {
      return schema as Record<string, unknown>;
    }
    return { type: "object", properties: {} };
  }

  /** Reset conversation history */
  reset(): void {
    this.messages = [];
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** Get conversation history */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Get total token usage */
  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  /** Abort the current operation */
  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }
}
