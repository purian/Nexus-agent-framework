import type { MemoryStore, MemoryEntry, MemoryType } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface ContextRecallConfig {
  /** Enable automatic context recall */
  enabled: boolean;
  /** Maximum number of memories to inject (default: 10) */
  maxMemories?: number;
  /** Maximum total characters for injected context (default: 4000) */
  maxCharacters?: number;
  /** Memory types to include (default: all) */
  includeTypes?: MemoryType[];
  /** Minimum relevance score to include (0-1, default: 0.3) */
  minRelevance?: number;
  /** Recency bias weight (0-1, higher = prefer recent, default: 0.3) */
  recencyWeight?: number;
}

export interface RecalledMemory {
  entry: MemoryEntry;
  relevanceScore: number;
  reason: string;
}

// ============================================================================
// Stop words for keyword extraction
// ============================================================================

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "i", "you", "he", "she", "it", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "what", "which", "who", "whom", "when", "where", "why", "how", "all",
  "each", "every", "both", "few", "more", "most", "some", "any", "no",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "about", "above", "after", "again", "also", "am", "as", "because",
  "before", "between", "down", "during", "if", "into", "like", "nor",
  "now", "once", "other", "out", "over", "such", "then", "there", "through",
  "under", "until", "up", "while",
]);

// ============================================================================
// ContextRecall
// ============================================================================

export class ContextRecall {
  private config: ContextRecallConfig;
  private memory: MemoryStore;

  constructor(memory: MemoryStore, config: ContextRecallConfig) {
    this.memory = memory;
    this.config = config;
  }

  /**
   * Recall relevant memories for a user message.
   * Returns memories ranked by relevance.
   */
  async recall(
    userMessage: string,
    workingDirectory?: string,
  ): Promise<RecalledMemory[]> {
    if (!this.config.enabled) return [];

    const maxMemories = this.config.maxMemories ?? 10;
    const minRelevance = this.config.minRelevance ?? 0.3;
    const recencyWeight = this.config.recencyWeight ?? 0.3;
    const includeTypes = this.config.includeTypes;

    const queryTokens = this.extractKeywords(userMessage);

    // Search with the full message and individual keywords for broader recall
    const searchResults = await this.searchMemories(userMessage);

    // Also search with individual keywords for broader coverage
    const keywordResults: MemoryEntry[] = [];
    for (const keyword of queryTokens) {
      if (keyword.length >= 3) {
        const results = await this.searchMemories(keyword);
        keywordResults.push(...results);
      }
    }

    // Deduplicate by ID
    const seenIds = new Set<string>();
    const allEntries: MemoryEntry[] = [];
    for (const entry of [...searchResults, ...keywordResults]) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        allEntries.push(entry);
      }
    }

    // Filter by type if configured
    const filteredEntries = includeTypes
      ? allEntries.filter((e) => includeTypes.includes(e.type))
      : allEntries;

    // Score and rank
    const scored: RecalledMemory[] = [];
    for (const entry of filteredEntries) {
      const relevance = this.scoreRelevance(entry, userMessage, queryTokens);
      let recency = this.scoreRecency(entry);

      // Boost memories tagged with the working directory
      let directoryBoost = 0;
      if (workingDirectory && entry.tags?.some((t) => t.includes(workingDirectory))) {
        directoryBoost = 0.2;
      }

      const finalScore =
        relevance * (1 - recencyWeight) +
        recency * recencyWeight +
        directoryBoost;

      if (finalScore < minRelevance) continue;

      // Build reason string
      const matchedKeywords = [...queryTokens].filter((kw) => {
        const lower = kw.toLowerCase();
        return (
          entry.name.toLowerCase().includes(lower) ||
          entry.description.toLowerCase().includes(lower) ||
          entry.content.toLowerCase().includes(lower)
        );
      });

      let reason: string;
      if (matchedKeywords.length > 0) {
        reason = `matched keywords: ${matchedKeywords.join(", ")}`;
      } else if (directoryBoost > 0) {
        reason = "matched working directory context";
      } else {
        reason = "recent project context";
      }

      scored.push({ entry, relevanceScore: finalScore, reason });
    }

    // Sort by score descending
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Truncate to limits
    const limited = scored.slice(0, maxMemories);
    return this.truncateToLimit(limited);
  }

  /**
   * Build a system prompt section from recalled memories.
   */
  formatForSystemPrompt(memories: RecalledMemory[]): string {
    if (memories.length === 0) return "";

    const maxChars = this.config.maxCharacters ?? 4000;
    const lines: string[] = ["# Relevant Context from Memory", ""];

    let totalChars = lines[0].length + 1; // header + newline

    for (const mem of memories) {
      const section = [
        `## [${mem.entry.type}] ${mem.entry.name}`,
        mem.entry.description,
        mem.entry.content,
        "---",
      ].join("\n");

      if (totalChars + section.length > maxChars) {
        // Truncate content to fit
        const remaining = maxChars - totalChars;
        if (remaining > 50) {
          const truncated = section.slice(0, remaining - 3) + "...";
          lines.push(truncated);
        }
        break;
      }

      lines.push(section);
      totalChars += section.length + 1; // +1 for newline
    }

    return lines.join("\n");
  }

  /**
   * Recall and format in one step (convenience method).
   */
  async recallAndFormat(
    userMessage: string,
    workingDirectory?: string,
  ): Promise<string> {
    const memories = await this.recall(userMessage, workingDirectory);
    return this.formatForSystemPrompt(memories);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async searchMemories(query: string): Promise<MemoryEntry[]> {
    try {
      return await this.memory.search(query);
    } catch {
      // FTS5 can fail on certain query syntax; fall back to empty
      return [];
    }
  }

  /* package-visible for testing */
  scoreRelevance(
    entry: MemoryEntry,
    query: string,
    queryTokens: Set<string>,
  ): number {
    const entryText = [entry.name, entry.description, entry.content].join(" ");
    const entryTokens = this.extractKeywords(entryText);

    // Token overlap score
    const overlap = this.calculateTokenOverlap(entryTokens, queryTokens);

    // Exact phrase match bonus
    const lowerQuery = query.toLowerCase();
    const lowerEntry = entryText.toLowerCase();
    const exactBonus = lowerEntry.includes(lowerQuery) ? 0.3 : 0;

    // Combine: overlap normalized by query token count + exact bonus
    const overlapScore =
      queryTokens.size > 0 ? overlap / queryTokens.size : 0;

    return Math.min(1, overlapScore + exactBonus);
  }

  /* package-visible for testing */
  scoreRecency(entry: MemoryEntry): number {
    const now = Date.now();
    const updatedAt = entry.updatedAt.getTime();
    const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(1, 1 - daysSinceUpdate / 365));
  }

  /* package-visible for testing */
  extractKeywords(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    return new Set(tokens);
  }

  private calculateTokenOverlap(
    entryTokens: Set<string>,
    queryTokens: Set<string>,
  ): number {
    let count = 0;
    for (const token of queryTokens) {
      if (entryTokens.has(token)) {
        count++;
      }
    }
    return count;
  }

  /* package-visible for testing */
  truncateToLimit(memories: RecalledMemory[]): RecalledMemory[] {
    const maxChars = this.config.maxCharacters ?? 4000;
    const result: RecalledMemory[] = [];
    let totalChars = 0;

    for (const mem of memories) {
      const entryChars =
        mem.entry.name.length +
        mem.entry.description.length +
        mem.entry.content.length;

      if (totalChars + entryChars > maxChars) break;
      totalChars += entryChars;
      result.push(mem);
    }

    return result;
  }
}
