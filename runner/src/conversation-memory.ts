// Persistent cross-session conversation memory for the runner (feature #3, Tier A).
//
// Stores every message+reply exchange to a JSON file and provides keyword-based
// recall so past context can be injected into future prompts — even after a
// /reset or weeks later, beyond what `claude --resume` retains.
//
// Why JSON and not SQLite/FTS5: the runner deploys as a single esbuild bundle
// with no node_modules, so native modules (better-sqlite3) can't ship. Message
// volume is tiny (hundreds), so an in-memory keyword score over a JSON file is
// more than fast enough and adds zero dependencies. If volume ever grows large,
// this is the seam to swap in a real index.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Exchange {
  chatId: string;
  ts: string; // ISO timestamp
  message: string;
  reply: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "to", "of",
  "in", "on", "at", "for", "with", "this", "that", "it", "i", "you", "he", "she",
  "we", "they", "what", "when", "how", "why", "do", "did", "does", "can", "my",
  "me", "your", "please", "thanks", "ok",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

export class ConversationMemory {
  private exchanges: Exchange[] = [];
  private readonly maxEntries: number;

  constructor(
    private readonly path: string,
    maxEntries = 2000,
  ) {
    this.maxEntries = maxEntries;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        const data = JSON.parse(readFileSync(this.path, "utf-8"));
        if (Array.isArray(data)) this.exchanges = data;
      }
    } catch {
      this.exchanges = [];
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.exchanges, null, 0), "utf-8");
    } catch {
      // Non-fatal: recall still works for this process lifetime.
    }
  }

  /** Record a completed exchange. */
  add(chatId: string, message: string, reply: string): void {
    if (!message.trim() || !reply.trim()) return;
    this.exchanges.push({
      chatId,
      ts: new Date().toISOString(),
      message: message.slice(0, 4000),
      reply: reply.slice(0, 4000),
    });
    if (this.exchanges.length > this.maxEntries) {
      this.exchanges = this.exchanges.slice(-this.maxEntries);
    }
    this.save();
  }

  /**
   * Recall the most relevant past exchanges for a query, scored by keyword
   * overlap. Only considers the same chat. Excludes the most recent exchange
   * (already covered by the live --resume session). Returns newest-first among
   * ties so recent context is preferred.
   */
  recall(chatId: string, query: string, limit = 3): Exchange[] {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    const candidates = this.exchanges
      .filter((e) => e.chatId === chatId)
      .slice(0, -1); // drop the immediately-previous exchange

    const scored = candidates.map((e, idx) => {
      const tokens = new Set(tokenize(e.message + " " + e.reply));
      let overlap = 0;
      for (const t of queryTokens) if (tokens.has(t)) overlap++;
      return { e, score: overlap, idx };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => (b.score - a.score) || (b.idx - a.idx))
      .slice(0, limit)
      .map((s) => s.e);
  }

  /** Format recalled exchanges as a system-prompt section, or "" if none. */
  recallAndFormat(chatId: string, query: string, limit = 3): string {
    const hits = this.recall(chatId, query, limit);
    if (hits.length === 0) return "";
    const lines = hits.map((h) => {
      const when = h.ts.slice(0, 16).replace("T", " ");
      return `- [${when}] User: ${h.message.slice(0, 200)}\n  You replied: ${h.reply.slice(0, 200)}`;
    });
    return (
      "\n\nRelevant past conversation context (from earlier sessions; use only if helpful):\n" +
      lines.join("\n")
    );
  }
}
