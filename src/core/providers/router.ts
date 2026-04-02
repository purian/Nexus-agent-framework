import type {
  LLMEvent,
  LLMProvider,
  LLMRequest,
  TokenUsage,
} from "../../types/index.js";

export interface ModelRoute {
  /** Model identifier */
  model: string;
  /** Provider to use for this model */
  provider: LLMProvider;
  /** Cost per 1K input tokens in USD */
  inputCostPer1K: number;
  /** Cost per 1K output tokens in USD */
  outputCostPer1K: number;
  /** Relative capability level (1 = basic, 10 = most capable) */
  capability: number;
  /** Max context window tokens */
  maxContextTokens: number;
  /** Whether this model supports tool use */
  supportsTools: boolean;
  /** Whether this model supports thinking/reasoning */
  supportsThinking: boolean;
}

export interface RouterConfig {
  /** Available model routes */
  routes: ModelRoute[];
  /** Complexity threshold — messages below this token count use cheap model (default: 500) */
  simpleThresholdTokens?: number;
  /** Force capability level for tool-using requests (default: 5) */
  toolUseMinCapability?: number;
  /** Force capability level for thinking requests (default: 7) */
  thinkingMinCapability?: number;
  /** Default route name when no routing decision can be made */
  defaultModel?: string;
}

export interface RoutingDecision {
  route: ModelRoute;
  reason: string;
  estimatedCost: number;
}

/**
 * ModelRouter — intelligent multi-model routing based on task complexity.
 *
 * Routes simple queries to cheap/fast models and complex tasks to powerful models.
 */
export class ModelRouter implements LLMProvider {
  name = "router";
  private config: RouterConfig;
  private routes: ModelRoute[];
  private usageHistory: Array<{
    model: string;
    usage: TokenUsage;
    timestamp: number;
  }> = [];

  constructor(config: RouterConfig) {
    if (config.routes.length === 0) {
      throw new Error("ModelRouter requires at least one route");
    }
    this.config = {
      simpleThresholdTokens: 500,
      toolUseMinCapability: 5,
      thinkingMinCapability: 7,
      ...config,
    };
    this.routes = config.routes;
  }

  /**
   * Route a request to the best model and execute.
   */
  async *chat(
    request: LLMRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMEvent> {
    const decision = this.selectRoute(request);
    const routedRequest: LLMRequest = {
      ...request,
      model: decision.route.model,
    };

    for await (const event of decision.route.provider.chat(
      routedRequest,
      signal,
    )) {
      if (event.type === "message_end") {
        this.recordUsage(decision.route.model, event.usage);
      }
      yield event;
    }
  }

  /**
   * Decide which model to use for a request (without executing).
   */
  selectRoute(request: LLMRequest): RoutingDecision {
    const complexity = this.estimateComplexity(request);
    const eligible = this.filterEligibleRoutes(request);

    if (eligible.length === 0) {
      // Fall back to default model or first route
      const fallback = this.config.defaultModel
        ? this.routes.find((r) => r.model === this.config.defaultModel) ??
          this.routes[0]
        : this.routes[0];

      const inputTokens = this.estimateMessageTokens(request);
      return {
        route: fallback,
        reason: "No eligible routes found; using fallback",
        estimatedCost: this.estimateCost(fallback, inputTokens, inputTokens),
      };
    }

    const inputTokens = this.estimateMessageTokens(request);
    let route: ModelRoute;
    let reason: string;

    if (complexity < 4) {
      route = this.selectCheapest(eligible);
      reason = `Low complexity (${complexity.toFixed(1)}); using cheapest eligible model`;
    } else if (complexity < 7) {
      // Mid-range: cheapest with capability >= 5
      const midRange = eligible.filter((r) => r.capability >= 5);
      if (midRange.length > 0) {
        route = this.selectCheapest(midRange);
        reason = `Medium complexity (${complexity.toFixed(1)}); using mid-range model`;
      } else {
        route = this.selectMostCapable(eligible);
        reason = `Medium complexity (${complexity.toFixed(1)}); no mid-range available, using most capable`;
      }
    } else {
      route = this.selectMostCapable(eligible);
      reason = `High complexity (${complexity.toFixed(1)}); using most capable model`;
    }

    return {
      route,
      reason,
      estimatedCost: this.estimateCost(route, inputTokens, inputTokens),
    };
  }

  /**
   * Get cumulative cost across all routed requests.
   */
  getTotalCost(): number {
    let total = 0;
    for (const entry of this.usageHistory) {
      const route = this.routes.find((r) => r.model === entry.model);
      if (route) {
        total += this.estimateCost(
          route,
          entry.usage.inputTokens,
          entry.usage.outputTokens,
        );
      }
    }
    return total;
  }

  /**
   * Get per-model usage breakdown.
   */
  getUsageBreakdown(): Array<{
    model: string;
    requests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
  }> {
    const breakdown = new Map<
      string,
      {
        model: string;
        requests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCost: number;
      }
    >();

    for (const entry of this.usageHistory) {
      const existing = breakdown.get(entry.model) ?? {
        model: entry.model,
        requests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      };

      existing.requests++;
      existing.totalInputTokens += entry.usage.inputTokens;
      existing.totalOutputTokens += entry.usage.outputTokens;

      const route = this.routes.find((r) => r.model === entry.model);
      if (route) {
        existing.totalCost += this.estimateCost(
          route,
          entry.usage.inputTokens,
          entry.usage.outputTokens,
        );
      }

      breakdown.set(entry.model, existing);
    }

    return Array.from(breakdown.values());
  }

  /**
   * List all available models across all routes.
   */
  async listModels(): Promise<string[]> {
    return this.routes.map((r) => r.model);
  }

  /**
   * Estimate complexity of a request on a 0-10 scale.
   */
  private estimateComplexity(request: LLMRequest): number {
    let score = 0;

    // Token count contribution (0-4 points)
    const tokens = this.estimateMessageTokens(request);
    const threshold = this.config.simpleThresholdTokens!;
    score += Math.min(4, (tokens / threshold) * 2);

    // Tool use adds complexity
    if (request.tools && request.tools.length > 0) {
      score += 2;
    }

    // Thinking adds complexity
    if (request.thinking?.enabled) {
      score += 3;
    }

    // System prompt length (0-1 point)
    if (request.systemPrompt) {
      const sysTokens = this.estimateTokenCount(request.systemPrompt);
      score += Math.min(1, sysTokens / 2000);
    }

    // Conversation history length (0-2 points)
    if (request.messages.length > 1) {
      score += Math.min(2, (request.messages.length - 1) / 5);
    }

    return Math.min(10, score);
  }

  /**
   * Estimate total token count for a request.
   */
  private estimateMessageTokens(request: LLMRequest): number {
    let tokens = 0;

    if (request.systemPrompt) {
      tokens += this.estimateTokenCount(request.systemPrompt);
    }

    for (const msg of request.messages) {
      for (const block of msg.content) {
        if (block.type === "text") {
          tokens += this.estimateTokenCount(block.text);
        } else if (block.type === "tool_result") {
          const content = block.content;
          if (typeof content === "string") {
            tokens += this.estimateTokenCount(content);
          } else if (Array.isArray(content)) {
            for (const sub of content) {
              if (sub.type === "text") {
                tokens += this.estimateTokenCount(sub.text);
              }
            }
          }
        } else if (block.type === "thinking") {
          tokens += this.estimateTokenCount(block.thinking);
        } else if (block.type === "tool_use") {
          tokens += this.estimateTokenCount(JSON.stringify(block.input));
        }
      }
    }

    return tokens;
  }

  /**
   * Filter routes that can handle the request.
   */
  private filterEligibleRoutes(request: LLMRequest): ModelRoute[] {
    const estimatedTokens = this.estimateMessageTokens(request);

    return this.routes.filter((route) => {
      // Must support tools if request has tools
      if (request.tools && request.tools.length > 0 && !route.supportsTools) {
        return false;
      }

      // Must support thinking if request has thinking enabled
      if (request.thinking?.enabled && !route.supportsThinking) {
        return false;
      }

      // Must have enough context window
      if (estimatedTokens > route.maxContextTokens) {
        return false;
      }

      return true;
    });
  }

  /**
   * Select the cheapest route from a list.
   */
  private selectCheapest(routes: ModelRoute[]): ModelRoute {
    return routes.reduce((cheapest, route) => {
      const cheapestCost = cheapest.inputCostPer1K + cheapest.outputCostPer1K;
      const routeCost = route.inputCostPer1K + route.outputCostPer1K;
      return routeCost < cheapestCost ? route : cheapest;
    });
  }

  /**
   * Select the most capable route from a list.
   */
  private selectMostCapable(routes: ModelRoute[]): ModelRoute {
    return routes.reduce((best, route) =>
      route.capability > best.capability ? route : best,
    );
  }

  /**
   * Record usage from a completed request.
   */
  private recordUsage(model: string, usage: TokenUsage): void {
    this.usageHistory.push({ model, usage, timestamp: Date.now() });
  }

  /**
   * Estimate cost for a given route and token counts.
   */
  private estimateCost(
    route: ModelRoute,
    inputTokens: number,
    outputTokens: number,
  ): number {
    return (
      (inputTokens / 1000) * route.inputCostPer1K +
      (outputTokens / 1000) * route.outputCostPer1K
    );
  }

  /**
   * Rough token estimate: ~4 characters per token.
   */
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
