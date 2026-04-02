import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./index.js";
import { FeedbackLearner } from "./feedback-learner.js";
import type { FeedbackConfig, Lesson } from "./feedback-learner.js";
import type { MemoryType } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-fb-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultConfig(overrides?: Partial<FeedbackConfig>): FeedbackConfig {
  return {
    enabled: true,
    autoDetect: true,
    maxLessons: 100,
    minConfidence: 0.5,
    ...overrides,
  };
}

function makeLesson(overrides?: Partial<Lesson>): Lesson {
  return {
    id: randomUUID(),
    observation: "Used console.log for debugging",
    correction: "Use the proper logger instead of console.log",
    context: "logging",
    confidence: 0.8,
    reinforcements: 0,
    createdAt: new Date(),
    lastReinforcedAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("FeedbackLearner", () => {
  let tempDir: string;
  let memory: MemoryManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    memory = MemoryManager.create(tempDir);
  });

  afterEach(() => {
    memory.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 1. constructor - accepts config
  // --------------------------------------------------------------------------

  it("constructor - accepts config", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    expect(learner).toBeInstanceOf(FeedbackLearner);
  });

  // --------------------------------------------------------------------------
  // 2. detectCorrectionPatterns - detects "no" / negation
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - detects negation", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signals = (learner as any).detectCorrectionPatterns("No, that's not what I meant");
    const negation = signals.find((s: any) => s.type === "negation");
    expect(negation).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 3. detectCorrectionPatterns - detects "actually" / correction
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - detects correction", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signals = (learner as any).detectCorrectionPatterns(
      "Actually, it should be a different approach",
    );
    const correction = signals.find((s: any) => s.type === "correction");
    expect(correction).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 4. detectCorrectionPatterns - detects "always" / instruction
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - detects instruction", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signals = (learner as any).detectCorrectionPatterns(
      "Always use semicolons in TypeScript files",
    );
    const instruction = signals.find((s: any) => s.type === "instruction");
    expect(instruction).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 5. detectCorrectionPatterns - detects "I prefer" / preference
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - detects preference", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signals = (learner as any).detectCorrectionPatterns(
      "I prefer using tabs over spaces",
    );
    const preference = signals.find((s: any) => s.type === "preference");
    expect(preference).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 6. detectCorrectionPatterns - returns empty for neutral messages
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - returns empty for neutral messages", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signals = (learner as any).detectCorrectionPatterns(
      "Looks good, thanks for the help",
    );
    expect(signals.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 7. detectCorrectionPatterns - confidence scoring
  // --------------------------------------------------------------------------

  it("detectCorrectionPatterns - confidence scoring", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());

    const instructionSignals = (learner as any).detectCorrectionPatterns(
      "Always run tests before committing",
    );
    const instruction = instructionSignals.find((s: any) => s.type === "instruction");
    expect(instruction).toBeDefined();
    expect(instruction.confidence).toBeGreaterThanOrEqual(0.5);
    expect(instruction.confidence).toBeLessThanOrEqual(1);

    const negationSignals = (learner as any).detectCorrectionPatterns(
      "No, wrong approach",
    );
    const negation = negationSignals.find((s: any) => s.type === "negation");
    expect(negation).toBeDefined();
    expect(negation.confidence).toBeGreaterThanOrEqual(0.5);
  });

  // --------------------------------------------------------------------------
  // 8. analyzeFeedback - extracts lesson from correction
  // --------------------------------------------------------------------------

  it("analyzeFeedback - extracts lesson from correction", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const lessons = learner.analyzeFeedback(
      "No, don't use var. Always use const or let instead.",
      "I'll declare the variable using var.",
      "javascript",
    );

    expect(lessons.length).toBeGreaterThan(0);
    const lesson = lessons[0];
    expect(lesson.observation).toContain("var");
    expect(lesson.correction).toContain("const");
    expect(lesson.context).toBe("javascript");
  });

  // --------------------------------------------------------------------------
  // 9. analyzeFeedback - returns empty when no feedback detected
  // --------------------------------------------------------------------------

  it("analyzeFeedback - returns empty when no feedback detected", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const lessons = learner.analyzeFeedback(
      "That looks great, thanks!",
      "Here is the implementation.",
    );
    expect(lessons).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 10. analyzeFeedback - respects minConfidence
  // --------------------------------------------------------------------------

  it("analyzeFeedback - respects minConfidence", () => {
    const learner = new FeedbackLearner(memory, defaultConfig({ minConfidence: 0.95 }));
    // "No, wrong" has negation confidence of 0.7 which is below 0.95
    const lessons = learner.analyzeFeedback(
      "No, wrong",
      "Here is result.",
    );
    expect(lessons.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 11. extractLesson - builds lesson from signal
  // --------------------------------------------------------------------------

  it("extractLesson - builds lesson from signal", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const signal = { type: "correction" as const, text: "actually", confidence: 0.8 };
    const lesson = (learner as any).extractLesson(
      signal,
      "Actually, use TypeScript not JavaScript",
      "I used JavaScript for the implementation",
      "programming",
    );

    expect(lesson.observation).toContain("JavaScript");
    expect(lesson.correction).toContain("TypeScript");
    expect(lesson.context).toBe("programming");
    expect(lesson.confidence).toBe(0.8);
    expect(lesson.reinforcements).toBe(0);
    expect(lesson.id).toBeDefined();
    expect(lesson.createdAt).toBeInstanceOf(Date);
  });

  // --------------------------------------------------------------------------
  // 12. storeLessonAsync - saves as memory entry
  // --------------------------------------------------------------------------

  it("storeLessonAsync - saves as memory entry", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const lesson = makeLesson();
    const entry = await learner.storeLessonAsync(lesson);

    expect(entry.id).toBeDefined();
    expect(entry.type).toBe("feedback");
    expect(entry.name).toBe(lesson.observation);
  });

  // --------------------------------------------------------------------------
  // 13. storeLessonAsync - uses correct type and tags
  // --------------------------------------------------------------------------

  it("storeLessonAsync - uses correct type and tags", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const lesson = makeLesson({ context: "typescript" });
    const entry = await learner.storeLessonAsync(lesson);

    expect(entry.type).toBe("feedback");
    expect(entry.tags).toContain("lesson");
    expect(entry.tags).toContain("typescript");
  });

  // --------------------------------------------------------------------------
  // 14. getRelevantLessons - retrieves matching lessons
  // --------------------------------------------------------------------------

  it("getRelevantLessons - retrieves matching lessons", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());

    await learner.storeLessonAsync(
      makeLesson({
        observation: "Used console.log for debugging output",
        correction: "Use the structured logger",
        context: "logging",
      }),
    );

    const lessons = await learner.getRelevantLessons("console debugging output");
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0].observation).toContain("console.log");
  });

  // --------------------------------------------------------------------------
  // 15. getRelevantLessons - respects limit
  // --------------------------------------------------------------------------

  it("getRelevantLessons - respects limit", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());

    for (let i = 0; i < 5; i++) {
      await learner.storeLessonAsync(
        makeLesson({
          observation: `Logging mistake ${i} with console`,
          correction: `Fix logging ${i}`,
          context: "logging",
        }),
      );
    }

    const lessons = await learner.getRelevantLessons("logging console", 2);
    expect(lessons.length).toBeLessThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // 16. formatLessonsForPrompt - formats lessons correctly
  // --------------------------------------------------------------------------

  it("formatLessonsForPrompt - formats lessons correctly", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const lessons: Lesson[] = [
      makeLesson({
        context: "testing",
        correction: "Use vitest not jest",
        confidence: 0.9,
        reinforcements: 3,
      }),
    ];

    const formatted = learner.formatLessonsForPrompt(lessons);
    expect(formatted).toContain("# Lessons from Previous Feedback");
    expect(formatted).toContain("When working on testing");
    expect(formatted).toContain("Use vitest not jest");
    expect(formatted).toContain("confidence: 0.9");
    expect(formatted).toContain("reinforced 3 times");
  });

  // --------------------------------------------------------------------------
  // 17. formatLessonsForPrompt - empty for no lessons
  // --------------------------------------------------------------------------

  it("formatLessonsForPrompt - empty for no lessons", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const formatted = learner.formatLessonsForPrompt([]);
    expect(formatted).toBe("");
  });

  // --------------------------------------------------------------------------
  // 18. pruneOldLessons - removes beyond maxLessons
  // --------------------------------------------------------------------------

  it("pruneOldLessons - removes beyond maxLessons", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig({ maxLessons: 3 }));

    for (let i = 0; i < 5; i++) {
      await memory.save({
        type: "feedback" as MemoryType,
        name: `Observation ${i}`,
        description: `Lesson ${i}`,
        content: JSON.stringify({
          correction: `Correction ${i}`,
          confidence: 0.8,
          reinforcements: 0,
          lastReinforcedAt: new Date().toISOString(),
        }),
        tags: ["lesson", "general"],
      });
    }

    const pruned = await learner.pruneOldLessons();
    expect(pruned).toBe(2);

    const remaining = await memory.list("feedback");
    const lessons = remaining.filter((e) => e.tags?.includes("lesson"));
    expect(lessons.length).toBe(3);
  });

  // --------------------------------------------------------------------------
  // 19. pruneOldLessons - keeps most reinforced
  // --------------------------------------------------------------------------

  it("pruneOldLessons - keeps most reinforced", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig({ maxLessons: 2 }));

    // Save 4 lessons with varying reinforcement counts
    for (let i = 0; i < 4; i++) {
      await memory.save({
        type: "feedback" as MemoryType,
        name: `Observation R${i}`,
        description: `Lesson reinforced ${i}`,
        content: JSON.stringify({
          correction: `Correction ${i}`,
          confidence: 0.8,
          reinforcements: i, // 0, 1, 2, 3
          lastReinforcedAt: new Date().toISOString(),
        }),
        tags: ["lesson", "general"],
      });
    }

    await learner.pruneOldLessons();

    const remaining = await memory.list("feedback");
    const lessons = remaining.filter((e) => e.tags?.includes("lesson"));
    expect(lessons.length).toBe(2);

    // The two most reinforced (2 and 3) should remain
    const reinforcements = lessons.map((l) => {
      const parsed = JSON.parse(l.content);
      return parsed.reinforcements;
    });
    expect(reinforcements).toContain(3);
    expect(reinforcements).toContain(2);
  });

  // --------------------------------------------------------------------------
  // 20. reinforceLesson - increments count
  // --------------------------------------------------------------------------

  it("reinforceLesson - increments count", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());

    const lesson = makeLesson({
      observation: "Used wrong pattern for error handling",
      reinforcements: 2,
      confidence: 0.7,
    });
    const entry = await learner.storeLessonAsync(lesson);

    // Retrieve and check initial state
    const initial = (learner as any).memoryEntryToLesson(entry);
    expect(initial.reinforcements).toBe(2);

    // Reinforce
    await (learner as any).reinforceLesson(initial);

    // Check updated
    const entries = await memory.search("wrong pattern", "feedback");
    const updated = entries.find((e) => e.name === lesson.observation);
    if (updated) {
      const parsed = JSON.parse(updated.content);
      expect(parsed.reinforcements).toBe(3);
    }
  });

  // --------------------------------------------------------------------------
  // 21. memoryEntryToLesson - converts correctly
  // --------------------------------------------------------------------------

  it("memoryEntryToLesson - converts correctly", () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const now = new Date();

    const entry = {
      id: "test-id",
      type: "feedback" as MemoryType,
      name: "Used wrong API",
      description: "Lesson learned",
      content: JSON.stringify({
        correction: "Use the new API v2",
        confidence: 0.85,
        reinforcements: 5,
        lastReinforcedAt: now.toISOString(),
      }),
      tags: ["lesson", "api"],
      createdAt: now,
      updatedAt: now,
    };

    const lesson = (learner as any).memoryEntryToLesson(entry);
    expect(lesson.id).toBe("test-id");
    expect(lesson.observation).toBe("Used wrong API");
    expect(lesson.correction).toBe("Use the new API v2");
    expect(lesson.confidence).toBe(0.85);
    expect(lesson.reinforcements).toBe(5);
    expect(lesson.context).toBe("api");
  });

  // --------------------------------------------------------------------------
  // 22. lesson roundtrip - store and retrieve preserves data
  // --------------------------------------------------------------------------

  it("lesson roundtrip - store and retrieve preserves data", async () => {
    const learner = new FeedbackLearner(memory, defaultConfig());
    const original = makeLesson({
      observation: "Forgot to handle null case in validation",
      correction: "Always check for null before accessing properties",
      context: "validation",
      confidence: 0.9,
    });

    await learner.storeLessonAsync(original);

    const retrieved = await learner.getRelevantLessons("null validation");
    expect(retrieved.length).toBeGreaterThan(0);

    const found = retrieved.find((l) => l.observation === original.observation);
    expect(found).toBeDefined();
    expect(found!.correction).toBe(original.correction);
    expect(found!.context).toBe("validation");
    expect(found!.confidence).toBe(0.9);
  });
});
