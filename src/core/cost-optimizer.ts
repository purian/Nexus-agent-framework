import type {
  LLMRequest,
  Message,
  TokenUsage,
} from "../types/index.js";

export interface CostOptimizerConfig {
  /** Enable cost optimization */
  enabled: boolean;
  /** Enable prompt caching (dedup identical prompts, default: true) */
  promptCaching?: boolean;
  /** Cache TTL in seconds (default: 3600) */
  cacheTtlSeconds?: number;
  /** Maximum cache entries (default: 1000) */
  maxCacheEntries?: number;
  /** Enable prompt compression (remove redundant context, default: true) */
  promptCompression?: boolean;
  /** Max system prompt tokens before compression (default: 4000) */
  maxSystemPromptTokens?: number;
}

export interface CacheEntry {
  key: string;
  response: string;
  usage: TokenUsage;
  createdAt: number;
  hits: number;
}

export interface CostStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  estimatedSavings: number;
  totalTokensSaved: number;
}

/**
 * CostOptimizer — intelligent caching and prompt optimization to reduce costs.
 */
export class CostOptimizer {
  private config: CostOptimizerConfig;
  private cache = new Map<string, CacheEntry>();
  private stats: CostStats = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hitRate: 0,
    estimatedSavings: 0,
    totalTokensSaved: 0,
  };

  constructor(config: CostOptimizerConfig) {
    this.config = {
      promptCaching: true,
      cacheTtlSeconds: 3600,
      maxCacheEntries: 1000,
      promptCompression: true,
      maxSystemPromptTokens: 4000,
      ...config,
    };
  }

  /**
   * Check if a response is cached for this request.
   */
  getCached(request: LLMRequest): CacheEntry | undefined {
    if (!this.config.enabled || !this.config.promptCaching) {
      return undefined;
    }

    // Don't cache thinking requests (non-deterministic)
    if (request.thinking?.enabled) {
      return undefined;
    }

    this.stats.totalRequests++;

    const key = this.buildCacheKey(request);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.cacheMisses++;
      this.updateHitRate();
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.cacheMisses++;
      this.updateHitRate();
      return undefined;
    }

    entry.hits++;
    this.stats.cacheHits++;
    this.stats.totalTokensSaved +=
      entry.usage.inputTokens + entry.usage.outputTokens;
    // Estimate savings at $0.003 per 1K tokens (rough average)
    this.stats.estimatedSavings +=
      ((entry.usage.inputTokens + entry.usage.outputTokens) / 1000) * 0.003;
    this.updateHitRate();

    return entry;
  }

  /**
   * Store a response in the cache.
   */
  setCached(
    request: LLMRequest,
    response: string,
    usage: TokenUsage,
  ): void {
    if (!this.config.enabled || !this.config.promptCaching) {
      return;
    }

    // Don't cache thinking requests
    if (request.thinking?.enabled) {
      return;
    }

    // Don't cache error-looking responses
    if (
      response.startsWith("Error:") ||
      response.startsWith("ERROR") ||
      response.length === 0
    ) {
      return;
    }

    // Evict if at capacity
    if (this.cache.size >= this.config.maxCacheEntries!) {
      this.evictLRU();
    }

    const key = this.buildCacheKey(request);
    this.cache.set(key, {
      key,
      response,
      usage,
      createdAt: Date.now(),
      hits: 0,
    });
  }

  /**
   * Optimize a system prompt by compressing it.
   */
  optimizeSystemPrompt(prompt: string): string {
    if (!this.config.enabled || !this.config.promptCompression) {
      return prompt;
    }

    let optimized = this.compressWhitespace(prompt);

    const estimatedTokens = this.estimateTokens(optimized);
    const maxTokens = this.config.maxSystemPromptTokens!;

    if (estimatedTokens > maxTokens) {
      // Truncate from the middle, keeping start and end
      const maxChars = maxTokens * 4; // ~4 chars per token
      const keepChars = Math.floor(maxChars / 2);
      const start = optimized.slice(0, keepChars);
      const end = optimized.slice(-keepChars);
      optimized = start + "\n\n[...truncated...]\n\n" + end;
    }

    return optimized;
  }

  /**
   * Optimize messages by deduplicating and compressing.
   */
  optimizeMessages(messages: Message[]): Message[] {
    if (!this.config.enabled || !this.config.promptCompression) {
      return messages;
    }

    const result: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const prev = result[result.length - 1];

      // Remove consecutive duplicate messages (same role and content)
      if (prev && this.messagesEqual(prev, msg)) {
        continue;
      }

      // Compress long tool results
      const optimizedContent = msg.content.map((block) => {
        if (block.type === "tool_result" && typeof block.content === "string") {
          if (block.content.length > 1500) {
            const start = block.content.slice(0, 500);
            const end = block.content.slice(-500);
            return {
              ...block,
              content: start + "\n\n[truncated]\n\n" + end,
            };
          }
        }
        return block;
      });

      result.push({ ...msg, content: optimizedContent });
    }

    return result;
  }

  /**
   * Get cost statistics.
   */
  getStats(): CostStats {
    return { ...this.stats };
  }

  /**
   * Reset cache and stats.
   */
  reset(): void {
    this.cache.clear();
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hitRate: 0,
      estimatedSavings: 0,
      totalTokensSaved: 0,
    };
  }

  /**
   * Evict expired entries from cache.
   */
  evict(): number {
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Build a cache key from a request.
   */
  private buildCacheKey(request: LLMRequest): string {
    const parts = [
      request.model,
      request.systemPrompt ?? "",
      this.getLastUserMessage(request),
      (request.tools ?? []).map((t) => t.name).join(","),
    ];
    return this.simpleHash(JSON.stringify(parts));
  }

  /**
   * Check if a cache entry has expired.
   */
  private isExpired(entry: CacheEntry): boolean {
    const ttlMs = this.config.cacheTtlSeconds! * 1000;
    return Date.now() - entry.createdAt > ttlMs;
  }

  /**
   * Remove the least-recently-used entry (oldest with lowest hits).
   */
  private evictLRU(): void {
    let worst: { key: string; score: number } | undefined;

    for (const [key, entry] of this.cache) {
      // Score: lower = more evictable. Older + fewer hits = lower score
      const age = Date.now() - entry.createdAt;
      const score = entry.hits / (age + 1);
      if (!worst || score < worst.score) {
        worst = { key, score };
      }
    }

    if (worst) {
      this.cache.delete(worst.key);
    }
  }

  /**
   * Rough token estimate: ~4 characters per token.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Compress consecutive whitespace and newlines.
   */
  private compressWhitespace(text: string): string {
    return text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Extract the last user message text from a request.
   */
  private getLastUserMessage(request: LLMRequest): string {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const msg = request.messages[i];
      if (msg.role === "user") {
        for (const block of msg.content) {
          if (block.type === "text") {
            return block.text;
          }
        }
      }
    }
    return "";
  }

  /**
   * Simple hash function for cache keys.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Check if two messages are equal.
   */
  private messagesEqual(a: Message, b: Message): boolean {
    if (a.role !== b.role) return false;
    if (a.content.length !== b.content.length) return false;
    return JSON.stringify(a.content) === JSON.stringify(b.content);
  }

  /**
   * Update the hit rate in stats.
   */
  private updateHitRate(): void {
    this.stats.hitRate =
      this.stats.totalRequests > 0
        ? this.stats.cacheHits / this.stats.totalRequests
        : 0;
  }
}
