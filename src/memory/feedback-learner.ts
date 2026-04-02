import { randomUUID } from "node:crypto";
import type { MemoryStore, MemoryEntry } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface FeedbackConfig {
  /** Enable learning from feedback */
  enabled: boolean;
  /** Automatically detect corrections in user messages */
  autoDetect?: boolean;
  /** Maximum lessons to store (oldest pruned, default: 100) */
  maxLessons?: number;
  /** Minimum confidence to store a lesson (0-1, default: 0.5) */
  minConfidence?: number;
}

export interface Lesson {
  id: string;
  /** What the agent did wrong or could improve */
  observation: string;
  /** What the correct approach should be */
  correction: string;
  /** Domain/context where this applies */
  context: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How many times this lesson was reinforced */
  reinforcements: number;
  /** Created timestamp */
  createdAt: Date;
  /** Last reinforced timestamp */
  lastReinforcedAt: Date;
}

export interface CorrectionSignal {
  type: "negation" | "correction" | "instruction" | "preference";
  text: string;
  confidence: number;
}

// ============================================================================
// Pattern definitions
// ============================================================================

interface PatternDef {
  type: CorrectionSignal["type"];
  patterns: RegExp[];
  confidence: number;
}

const CORRECTION_PATTERNS: PatternDef[] = [
  {
    type: "negation",
    patterns: [
      /\bno[,.]?\s/i,
      /\bnot that\b/i,
      /\bwrong\b/i,
      /\bdon'?t\b/i,
      /\bstop doing\b/i,
      /\bstop\s+\w+ing\b/i,
      /\bthat'?s\s+(?:not|wrong|incorrect)\b/i,
    ],
    confidence: 0.7,
  },
  {
    type: "correction",
    patterns: [
      /\bactually\b/i,
      /\binstead\b/i,
      /\bshould be\b/i,
      /\buse\s+\w+\s+not\b/i,
      /\bnot\s+\w+[,]\s*(?:use|try)\b/i,
      /\brather than\b/i,
      /\bcorrect\s+(?:way|approach)\b/i,
    ],
    confidence: 0.8,
  },
  {
    type: "instruction",
    patterns: [
      /\balways\b/i,
      /\bnever\b/i,
      /\bmake sure to\b/i,
      /\bremember to\b/i,
      /\bdon'?t forget\b/i,
      /\bfrom now on\b/i,
      /\bin the future\b/i,
    ],
    confidence: 0.9,
  },
  {
    type: "preference",
    patterns: [
      /\bi prefer\b/i,
      /\bi like\b/i,
      /\bi want\b/i,
      /\bplease use\b/i,
      /\bplease don'?t\b/i,
      /\bi'd rather\b/i,
      /\bmy preference\b/i,
    ],
    confidence: 0.85,
  },
];

// ============================================================================
// FeedbackLearner
// ============================================================================

export class FeedbackLearner {
  private config: FeedbackConfig;
  private memory: MemoryStore;

  constructor(memory: MemoryStore, config: FeedbackConfig) {
    this.memory = memory;
    this.config = config;
  }

  /**
   * Analyze a conversation exchange for feedback signals.
   * Returns extracted lessons (if any).
   */
  analyzeFeedback(
    userMessage: string,
    previousAssistantMessage: string,
    context?: string,
  ): Lesson[] {
    if (!this.config.enabled) return [];

    const minConfidence = this.config.minConfidence ?? 0.5;
    const signals = this.detectCorrectionPatterns(userMessage);

    const lessons: Lesson[] = [];
    for (const signal of signals) {
      if (signal.confidence < minConfidence) continue;
      const lesson = this.extractLesson(
        signal,
        userMessage,
        previousAssistantMessage,
        context ?? "general",
      );
      lessons.push(lesson);
    }

    return lessons;
  }

  /**
   * Store a lesson in memory.
   */
  async storeLessonAsync(lesson: Lesson): Promise<MemoryEntry> {
    // Check for existing similar lesson first
    const existing = await this.findExistingLesson(lesson.observation);
    if (existing) {
      await this.reinforceLesson(existing);
      // Return the updated entry
      const entries = await this.memory.search(existing.observation, "feedback");
      return entries[0];
    }

    const fields = this.lessonToMemoryFields(lesson);
    const entry = await this.memory.save({
      type: "feedback",
      name: fields.name,
      description: fields.description,
      content: fields.content,
      tags: fields.tags,
    });

    // Prune if over limit
    await this.pruneOldLessons();

    return entry;
  }

  /**
   * Retrieve relevant lessons for a given context.
   */
  async getRelevantLessons(
    query: string,
    limit?: number,
  ): Promise<Lesson[]> {
    const entries = await this.memory.search(query, "feedback");
    const lessons = entries
      .filter((e) => e.tags?.includes("lesson"))
      .map((e) => this.memoryEntryToLesson(e));

    const max = limit ?? 10;
    return lessons.slice(0, max);
  }

  /**
   * Build a system prompt section from lessons.
   */
  formatLessonsForPrompt(lessons: Lesson[]): string {
    if (lessons.length === 0) return "";

    const lines = ["# Lessons from Previous Feedback", ""];
    for (const lesson of lessons) {
      lines.push(
        `- When working on ${lesson.context}: ${lesson.correction} (confidence: ${lesson.confidence.toFixed(1)}, reinforced ${lesson.reinforcements} times)`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Prune old lessons beyond maxLessons.
   */
  async pruneOldLessons(): Promise<number> {
    const maxLessons = this.config.maxLessons ?? 100;
    const allFeedback = await this.memory.list("feedback");
    const lessons = allFeedback.filter((e) => e.tags?.includes("lesson"));

    if (lessons.length <= maxLessons) return 0;

    // Sort by reinforcements (keep most reinforced) then by updatedAt (keep recent)
    const sorted = [...lessons].sort((a, b) => {
      const aReinforcements = this.extractReinforcementCount(a);
      const bReinforcements = this.extractReinforcementCount(b);
      if (bReinforcements !== aReinforcements) {
        return bReinforcements - aReinforcements;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const toRemove = sorted.slice(maxLessons);
    for (const entry of toRemove) {
      await this.memory.delete(entry.id);
    }

    return toRemove.length;
  }

  // --------------------------------------------------------------------------
  // Private / package-visible helpers
  // --------------------------------------------------------------------------

  /* package-visible for testing */
  detectCorrectionPatterns(message: string): CorrectionSignal[] {
    const signals: CorrectionSignal[] = [];
    const seenTypes = new Set<string>();

    for (const def of CORRECTION_PATTERNS) {
      for (const pattern of def.patterns) {
        const match = message.match(pattern);
        if (match && !seenTypes.has(def.type)) {
          seenTypes.add(def.type);
          signals.push({
            type: def.type,
            text: match[0],
            confidence: def.confidence,
          });
          break; // Only one signal per type
        }
      }
    }

    return signals;
  }

  /* package-visible for testing */
  extractLesson(
    signal: CorrectionSignal,
    userMessage: string,
    assistantMessage: string,
    context: string,
  ): Lesson {
    // Build observation from what the assistant said (truncated)
    const observation =
      assistantMessage.length > 200
        ? assistantMessage.slice(0, 200) + "..."
        : assistantMessage;

    // Build correction from what the user said
    const correction =
      userMessage.length > 300
        ? userMessage.slice(0, 300) + "..."
        : userMessage;

    return {
      id: randomUUID(),
      observation,
      correction,
      context,
      confidence: signal.confidence,
      reinforcements: 0,
      createdAt: new Date(),
      lastReinforcedAt: new Date(),
    };
  }

  private async findExistingLesson(
    observation: string,
  ): Promise<Lesson | null> {
    try {
      const entries = await this.memory.search(observation, "feedback");
      const lessons = entries.filter((e) => e.tags?.includes("lesson"));
      if (lessons.length === 0) return null;

      // Check for a sufficiently similar observation
      const lowerObs = observation.toLowerCase();
      for (const entry of lessons) {
        if (entry.name.toLowerCase().includes(lowerObs.slice(0, 50))) {
          return this.memoryEntryToLesson(entry);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /* package-visible for testing */
  async reinforceLesson(existing: Lesson): Promise<void> {
    // Find the memory entry
    const entries = await this.memory.search(existing.observation, "feedback");
    const matching = entries.find(
      (e) => e.tags?.includes("lesson") && e.name === existing.observation,
    );
    if (!matching) return;

    const newReinforcements = existing.reinforcements + 1;
    const newConfidence = Math.min(1, existing.confidence + 0.05);

    const content = JSON.stringify({
      correction: existing.correction,
      confidence: newConfidence,
      reinforcements: newReinforcements,
      lastReinforcedAt: new Date().toISOString(),
    });

    await this.memory.update(matching.id, { content });
  }

  /* package-visible for testing */
  memoryEntryToLesson(entry: MemoryEntry): Lesson {
    let parsed: {
      correction?: string;
      confidence?: number;
      reinforcements?: number;
      lastReinforcedAt?: string;
    } = {};

    try {
      parsed = JSON.parse(entry.content);
    } catch {
      // Content may be plain text for legacy entries
      parsed = { correction: entry.content };
    }

    return {
      id: entry.id,
      observation: entry.name,
      correction: parsed.correction ?? entry.content,
      context: entry.tags?.find((t) => t !== "lesson") ?? "general",
      confidence: parsed.confidence ?? 0.5,
      reinforcements: parsed.reinforcements ?? 0,
      createdAt: entry.createdAt,
      lastReinforcedAt: parsed.lastReinforcedAt
        ? new Date(parsed.lastReinforcedAt)
        : entry.updatedAt,
    };
  }

  /* package-visible for testing */
  lessonToMemoryFields(lesson: Lesson): {
    name: string;
    description: string;
    content: string;
    tags: string[];
  } {
    return {
      name: lesson.observation,
      description: `Lesson learned: ${lesson.correction.slice(0, 100)}`,
      content: JSON.stringify({
        correction: lesson.correction,
        confidence: lesson.confidence,
        reinforcements: lesson.reinforcements,
        lastReinforcedAt: lesson.lastReinforcedAt.toISOString(),
      }),
      tags: ["lesson", lesson.context],
    };
  }

  private extractReinforcementCount(entry: MemoryEntry): number {
    try {
      const parsed = JSON.parse(entry.content);
      return parsed.reinforcements ?? 0;
    } catch {
      return 0;
    }
  }
}
