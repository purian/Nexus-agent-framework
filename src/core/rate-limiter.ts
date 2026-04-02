import type {
  RateLimitConfig,
  RateLimitDecision,
  RateLimitRule,
} from "../types/index.js";

/**
 * RateLimiter — Sliding window rate limiter for per-tool and per-agent limits.
 *
 * Each key (e.g., "tool:bash", "agent:agent-123") maintains an array of
 * execution timestamps. When checking, expired timestamps are pruned and
 * the remaining count is compared against the configured maximum.
 */
export class RateLimiter {
  private config: RateLimitConfig;
  /** Sliding window timestamps: key -> array of execution timestamps (ms) */
  private windows = new Map<string, number[]>();

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /**
   * Check if a tool execution is allowed, and record it if so.
   * Returns a decision with retry information if rate limited.
   */
  checkAndRecord(toolName: string, agentId?: string): RateLimitDecision {
    if (!this.config.enabled) {
      return { allowed: true, currentCount: 0, maxCount: Infinity };
    }

    // Check tool limit
    const toolRule = this.getToolRule(toolName);
    if (toolRule) {
      const toolKey = this.buildKey("tool", toolName);
      const toolDecision = this.evaluateWindow(toolKey, toolRule, false);
      if (!toolDecision.allowed) {
        return toolDecision;
      }
    }

    // Check agent limit
    if (agentId) {
      const agentRule = this.getAgentRule(agentId);
      if (agentRule) {
        const agentKey = this.buildKey("agent", agentId);
        const agentDecision = this.evaluateWindow(agentKey, agentRule, false);
        if (!agentDecision.allowed) {
          return agentDecision;
        }
      }
    }

    // Both allowed — now record
    let toolDecision: RateLimitDecision | undefined;
    if (toolRule) {
      const toolKey = this.buildKey("tool", toolName);
      toolDecision = this.evaluateWindow(toolKey, toolRule, true);
    }

    let agentDecision: RateLimitDecision | undefined;
    if (agentId) {
      const agentRule = this.getAgentRule(agentId);
      if (agentRule) {
        const agentKey = this.buildKey("agent", agentId);
        agentDecision = this.evaluateWindow(agentKey, agentRule, true);
      }
    }

    // Return the most restrictive decision
    if (toolDecision && agentDecision) {
      const toolRemaining = toolDecision.maxCount - toolDecision.currentCount;
      const agentRemaining = agentDecision.maxCount - agentDecision.currentCount;
      return toolRemaining <= agentRemaining ? toolDecision : agentDecision;
    }

    return toolDecision ?? agentDecision ?? { allowed: true, currentCount: 0, maxCount: Infinity };
  }

  /**
   * Check without recording (peek).
   */
  check(toolName: string, agentId?: string): RateLimitDecision {
    if (!this.config.enabled) {
      return { allowed: true, currentCount: 0, maxCount: Infinity };
    }

    // Check tool limit
    const toolRule = this.getToolRule(toolName);
    let toolDecision: RateLimitDecision | undefined;
    if (toolRule) {
      const toolKey = this.buildKey("tool", toolName);
      toolDecision = this.evaluateWindow(toolKey, toolRule, false);
      if (!toolDecision.allowed) {
        return toolDecision;
      }
    }

    // Check agent limit
    let agentDecision: RateLimitDecision | undefined;
    if (agentId) {
      const agentRule = this.getAgentRule(agentId);
      if (agentRule) {
        const agentKey = this.buildKey("agent", agentId);
        agentDecision = this.evaluateWindow(agentKey, agentRule, false);
        if (!agentDecision.allowed) {
          return agentDecision;
        }
      }
    }

    // Return the most restrictive
    if (toolDecision && agentDecision) {
      const toolRemaining = toolDecision.maxCount - toolDecision.currentCount;
      const agentRemaining = agentDecision.maxCount - agentDecision.currentCount;
      return toolRemaining <= agentRemaining ? toolDecision : agentDecision;
    }

    return toolDecision ?? agentDecision ?? { allowed: true, currentCount: 0, maxCount: Infinity };
  }

  /**
   * Get current usage stats for a tool/agent.
   */
  getUsage(
    toolName: string,
    agentId?: string,
  ): { tool: RateLimitDecision; agent?: RateLimitDecision } {
    const toolRule = this.getToolRule(toolName);
    const toolKey = this.buildKey("tool", toolName);
    const tool: RateLimitDecision = toolRule
      ? this.evaluateWindow(toolKey, toolRule, false)
      : { allowed: true, currentCount: 0, maxCount: Infinity };

    let agent: RateLimitDecision | undefined;
    if (agentId) {
      const agentRule = this.getAgentRule(agentId);
      if (agentRule) {
        const agentKey = this.buildKey("agent", agentId);
        agent = this.evaluateWindow(agentKey, agentRule, false);
      }
    }

    return { tool, agent };
  }

  /**
   * Reset rate limit state for a specific key or all keys.
   */
  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
  }

  /**
   * Get the effective rate limit rule for a tool.
   * Checks specific tool limits first, then falls back to default.
   */
  private getToolRule(toolName: string): RateLimitRule | undefined {
    if (this.config.toolLimits) {
      const matched = this.matchRule(toolName, this.config.toolLimits);
      if (matched) return matched;
    }
    return this.config.defaultLimit;
  }

  /**
   * Get the effective rate limit rule for an agent.
   */
  private getAgentRule(agentId: string): RateLimitRule | undefined {
    if (this.config.agentLimits) {
      return this.matchRule(agentId, this.config.agentLimits);
    }
    return undefined;
  }

  /**
   * Evaluate a single rate limit window.
   * Prunes expired entries and checks the count.
   */
  private evaluateWindow(
    key: string,
    rule: RateLimitRule,
    record: boolean,
  ): RateLimitDecision {
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;
    const cutoff = now - windowMs;

    // Get or create timestamp array
    let timestamps = this.windows.get(key) ?? [];

    // Prune expired entries
    timestamps = timestamps.filter((t) => t > cutoff);
    this.windows.set(key, timestamps);

    if (timestamps.length >= rule.maxExecutions) {
      // Rate limited — calculate retry time from the oldest entry in window
      const oldestInWindow = timestamps[0]!;
      const retryAfterSeconds = (oldestInWindow + windowMs - now) / 1000;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(0, retryAfterSeconds),
        currentCount: timestamps.length,
        maxCount: rule.maxExecutions,
      };
    }

    if (record) {
      timestamps.push(now);
    }

    return {
      allowed: true,
      currentCount: timestamps.length,
      maxCount: rule.maxExecutions,
    };
  }

  /**
   * Match a name against rate limit config keys (supports glob patterns).
   */
  private matchRule(
    name: string,
    rules: Record<string, RateLimitRule>,
  ): RateLimitRule | undefined {
    // Exact match first
    if (rules[name]) {
      return rules[name];
    }

    // Glob pattern matching
    for (const [pattern, rule] of Object.entries(rules)) {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*/g, ".*") + "$",
        );
        if (regex.test(name)) {
          return rule;
        }
      }
    }

    return undefined;
  }

  /**
   * Build a window key from tool name and optional agent ID.
   */
  private buildKey(type: "tool" | "agent", name: string): string {
    return `${type}:${name}`;
  }
}
