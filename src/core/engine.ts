import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "eventemitter3";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  EngineEvent,
  LLMProvider,
  LLMRequest,
  Message,
  NexusConfig,
  PermissionContext,
  PermissionDecision,
  RateLimitDecision,
  StopReason,
  TextBlock,
  ThinkingBlock,
  TokenUsage,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from "../types/index.js";
import { ContextCompressor } from "./context-compressor.js";
import { PlanExecutor } from "./plan-mode.js";
import type { Plan } from "./plan-mode.js";
import { RateLimiter } from "./rate-limiter.js";
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
  private compressor: ContextCompressor;
  private rateLimiter?: RateLimiter;
  private planMode = false;
  private planExecutor: PlanExecutor = new PlanExecutor();

  constructor(
    provider: LLMProvider,
    config: NexusConfig,
    permissions: PermissionContext,
  ) {
    super();
    this.provider = provider;
    this.config = config;
    this.permissions = permissions;
    this.compressor = new ContextCompressor(config.contextTokens ?? 100_000);
    if (config.rateLimits) {
      this.rateLimiter = new RateLimiter(config.rateLimits);
    }
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
  // Plan Mode
  // ---------------------------------------------------------------------------

  enterPlanMode(): void {
    this.planMode = true;
  }

  exitPlanMode(): void {
    this.planMode = false;
  }

  isPlanMode(): boolean {
    return this.planMode;
  }

  getPlanExecutor(): PlanExecutor {
    return this.planExecutor;
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

      // Compress context if needed
      if (this.compressor.shouldCompress(this.messages)) {
        this.messages = await this.compressor.compress(this.messages, this.provider);
      }

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

    // In plan mode, intercept write tools and collect them into a plan
    if (this.planMode) {
      const interceptedActions: Array<{
        toolName: string;
        input: Record<string, unknown>;
        description: string;
      }> = [];

      for (const block of toolUseBlocks) {
        const tool = this.tools.get(block.name);
        if (!tool) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: Unknown tool "${block.name}"`,
            is_error: true,
          });
          continue;
        }

        if (this.planExecutor.shouldIntercept(tool, block.input)) {
          // Intercept write tool — queue it for the plan
          const description = tool.renderToolUse
            ? tool.renderToolUse(block.input)
            : `${block.name}(${JSON.stringify(block.input).slice(0, 100)})`;

          interceptedActions.push({
            toolName: block.name,
            input: block.input,
            description,
          });

          yield {
            type: "plan_action_intercepted",
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
            description,
          };

          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `[Plan mode] Action queued: ${description}. This will be executed after you approve the plan.`,
          });
        } else {
          // Read-only tool — execute normally
          const toolResults = yield* this.executeSingleTool(block, tool, signal);
          results.push(toolResults);
        }
      }

      // If we intercepted any actions, create a plan
      if (interceptedActions.length > 0) {
        const plan = this.planExecutor.createPlan(
          interceptedActions,
          `Plan with ${interceptedActions.length} action${interceptedActions.length === 1 ? "" : "s"}`,
        );

        yield {
          type: "plan_created",
          planId: plan.id,
          summary: plan.summary,
          actionCount: plan.actions.length,
        };
      }

      return results;
    }

    // Normal mode: partition into concurrent batches
    const batches = this.partitionToolCalls(toolUseBlocks);

    for (const batch of batches) {
      if (signal.aborted) break;

      const batchPromises = batch.map((block) => {
        const tool = this.tools.get(block.name);
        if (!tool) {
          return Promise.resolve({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: Unknown tool "${block.name}"`,
            is_error: true,
          });
        }
        return this.executeSingleToolAsync(block, tool, signal);
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Execute a single tool call (used in plan mode for read-only tools).
   * Yields EngineEvents and returns the ToolResultBlock.
   */
  private async *executeSingleTool(
    block: ToolUseBlock,
    tool: Tool,
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent, ToolResultBlock> {
    yield {
      type: "tool_start",
      toolName: block.name,
      toolUseId: block.id,
      input: block.input,
    };

    const result = await this.executeSingleToolAsync(block, tool, signal);
    return result;
  }

  /**
   * Execute a single tool call (async, no generator — for use in Promise.all batches).
   */
  private async executeSingleToolAsync(
    block: ToolUseBlock,
    tool: Tool,
    signal: AbortSignal,
  ): Promise<ToolResultBlock> {
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
        type: "tool_result",
        tool_use_id: block.id,
        content: `Permission denied: ${decision.reason}`,
        is_error: true,
      };
    }

    if (decision.behavior === "ask") {
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
          type: "tool_result",
          tool_use_id: block.id,
          content: "Permission denied by user",
          is_error: true,
        };
      }
    }

    // Rate limit check (after permissions, before execution)
    if (this.rateLimiter) {
      const rateLimitDecision = this.rateLimiter.checkAndRecord(block.name);
      if (!rateLimitDecision.allowed) {
        const retryMsg = rateLimitDecision.retryAfterSeconds != null
          ? ` Retry after ${rateLimitDecision.retryAfterSeconds.toFixed(1)} seconds.`
          : "";
        const errorMsg = `Rate limited: ${block.name} has reached ${rateLimitDecision.maxCount} executions in the current window.${retryMsg}`;
        this.emit("event", {
          type: "error",
          error: new Error(errorMsg),
        });
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: errorMsg,
          is_error: true,
        };
      }
    }

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
        throw new Error(`Invalid input: ${parseResult.error.message}`);
      }

      const result = await tool.execute(parseResult.data, context);
      const resultStr =
        typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data, null, 2);

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
        type: "tool_result",
        tool_use_id: block.id,
        content: truncated,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit("event", {
        type: "tool_end",
        toolUseId: block.id,
        result: errorMsg,
        isError: true,
      });
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Error: ${errorMsg}`,
        is_error: true,
      };
    }
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
        inputSchema: this.zodToJsonSchemaObj(tool.inputSchema),
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
      "",
      "When performing file operations, always use absolute paths or paths relative to the working directory.",
      `Your working directory is: ${this.config.workingDirectory}`,
    ];

    if (this.tools.size > 0) {
      parts.push(
        `\nYou have ${this.tools.size} tools available. Use them when appropriate.`,
      );
    }

    if (this.planMode) {
      parts.push(
        "\n# Plan Mode Active",
        "Plan mode is currently enabled. When you use write tools (file writes, edits, bash commands),",
        "they will NOT execute immediately. Instead, they will be queued into a plan for the user to review.",
        "Read-only tools (reading files, searching, fetching) still execute normally.",
        "",
        "Because your write actions are queued, you should:",
        "- Clearly explain what changes you are proposing and why",
        "- Use your read tools first to understand the current state",
        "- Group related changes together in a single turn when possible",
        "- After your actions are queued, summarize the plan for the user",
      );
    }

    // Load project instructions (.nexus/instructions.md)
    const instructions = this.loadProjectInstructions();
    if (instructions) {
      parts.push(
        "\n# Project Instructions",
        instructions,
      );
    }

    return parts.join("\n");
  }

  /**
   * Load project-specific instructions from .nexus/instructions.md
   * if it exists in the working directory.
   */
  private loadProjectInstructions(): string | null {
    const paths = [
      join(this.config.workingDirectory, ".nexus", "instructions.md"),
      join(this.config.workingDirectory, ".nexus.md"),
    ];

    for (const filePath of paths) {
      if (existsSync(filePath)) {
        try {
          return readFileSync(filePath, "utf-8").trim();
        } catch {
          // Ignore read errors
        }
      }
    }

    return null;
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

  private zodToJsonSchemaObj(schema: unknown): Record<string, unknown> {
    try {
      const jsonSchema = zodToJsonSchema(schema as any, { target: "openApi3" });
      // Remove the top-level $schema key — Anthropic doesn't want it
      const { $schema, ...rest } = jsonSchema as Record<string, unknown>;
      return rest;
    } catch {
      return { type: "object", properties: {} };
    }
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
