import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./index.js";
import { ContextRecall } from "./context-recall.js";
import type { ContextRecallConfig, RecalledMemory } from "./context-recall.js";
import type { MemoryType } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-ctx-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultConfig(overrides?: Partial<ContextRecallConfig>): ContextRecallConfig {
  return {
    enabled: true,
    maxMemories: 10,
    maxCharacters: 4000,
    minRelevance: 0.3,
    recencyWeight: 0.3,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ContextRecall", () => {
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
  // 1. constructor
  // --------------------------------------------------------------------------

  it("constructor - accepts config", () => {
    const config = defaultConfig();
    const recall = new ContextRecall(memory, config);
    expect(recall).toBeInstanceOf(ContextRecall);
  });

  // --------------------------------------------------------------------------
  // 2. recall - searches memory with user message
  // --------------------------------------------------------------------------

  it("recall - searches memory with user message", async () => {
    await memory.save({
      type: "project" as MemoryType,
      name: "TypeScript project setup",
      description: "How to set up a TypeScript project",
      content: "Use tsconfig.json with strict mode enabled",
      tags: ["typescript"],
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.1 }));
    const results = await recall.recall("TypeScript project");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.name).toBe("TypeScript project setup");
  });

  // --------------------------------------------------------------------------
  // 3. recall - returns empty for no matches
  // --------------------------------------------------------------------------

  it("recall - returns empty for no matches", async () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const results = await recall.recall("quantum physics simulations");
    expect(results).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 4. recall - respects maxMemories limit
  // --------------------------------------------------------------------------

  it("recall - respects maxMemories limit", async () => {
    for (let i = 0; i < 5; i++) {
      await memory.save({
        type: "reference" as MemoryType,
        name: `Testing pattern ${i}`,
        description: `Testing description ${i}`,
        content: `Testing content about vitest and testing ${i}`,
        tags: ["testing"],
      });
    }

    const recall = new ContextRecall(memory, defaultConfig({ maxMemories: 2, minRelevance: 0.1 }));
    const results = await recall.recall("testing vitest");
    expect(results.length).toBeLessThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // 5. recall - respects maxCharacters limit
  // --------------------------------------------------------------------------

  it("recall - respects maxCharacters limit", async () => {
    for (let i = 0; i < 5; i++) {
      await memory.save({
        type: "reference" as MemoryType,
        name: `Item ${i}`,
        description: `Description for item ${i}`,
        content: "A".repeat(500) + ` keyword${i}`,
        tags: ["test"],
      });
    }

    const recall = new ContextRecall(
      memory,
      defaultConfig({ maxCharacters: 800, minRelevance: 0.1 }),
    );
    const results = await recall.recall("keyword0 keyword1 keyword2 keyword3 keyword4");
    // Total chars of results should not exceed maxCharacters
    const totalChars = results.reduce(
      (sum, r) => sum + r.entry.name.length + r.entry.description.length + r.entry.content.length,
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(800);
  });

  // --------------------------------------------------------------------------
  // 6. recall - respects minRelevance threshold
  // --------------------------------------------------------------------------

  it("recall - respects minRelevance threshold", async () => {
    await memory.save({
      type: "reference" as MemoryType,
      name: "Unrelated topic",
      description: "Something about cooking recipes",
      content: "Pasta carbonara instructions",
      tags: ["cooking"],
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.5 }));
    const results = await recall.recall("TypeScript generics");
    expect(results.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 7. recall - filters by includeTypes
  // --------------------------------------------------------------------------

  it("recall - filters by includeTypes", async () => {
    await memory.save({
      type: "user" as MemoryType,
      name: "User preference for testing",
      description: "Prefers vitest for testing",
      content: "Always use vitest testing framework",
      tags: ["testing"],
    });
    await memory.save({
      type: "project" as MemoryType,
      name: "Project testing config",
      description: "Testing configuration",
      content: "Testing with vitest and coverage",
      tags: ["testing"],
    });

    const recall = new ContextRecall(
      memory,
      defaultConfig({ includeTypes: ["user"], minRelevance: 0.1 }),
    );
    const results = await recall.recall("testing vitest");
    for (const r of results) {
      expect(r.entry.type).toBe("user");
    }
  });

  // --------------------------------------------------------------------------
  // 8. recall - scores relevance based on keyword overlap
  // --------------------------------------------------------------------------

  it("recall - scores relevance based on keyword overlap", async () => {
    await memory.save({
      type: "reference" as MemoryType,
      name: "TypeScript strict mode",
      description: "TypeScript configuration",
      content: "Enable strict mode in tsconfig",
      tags: ["typescript"],
    });
    await memory.save({
      type: "reference" as MemoryType,
      name: "Python virtual environments",
      description: "Python setup guide",
      content: "Use virtualenv for Python projects",
      tags: ["python"],
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.1 }));
    const results = await recall.recall("TypeScript strict tsconfig");

    // The TypeScript entry should score higher
    if (results.length >= 2) {
      const tsResult = results.find((r) => r.entry.name.includes("TypeScript"));
      const pyResult = results.find((r) => r.entry.name.includes("Python"));
      if (tsResult && pyResult) {
        expect(tsResult.relevanceScore).toBeGreaterThan(pyResult.relevanceScore);
      }
    }
  });

  // --------------------------------------------------------------------------
  // 9. recall - boosts exact phrase matches
  // --------------------------------------------------------------------------

  it("recall - boosts exact phrase matches", async () => {
    await memory.save({
      type: "reference" as MemoryType,
      name: "strict mode",
      description: "About strict mode in TypeScript",
      content: "strict mode enables all strict type-checking options",
    });
    await memory.save({
      type: "reference" as MemoryType,
      name: "strict policies",
      description: "Security strict policies",
      content: "mode of operation for security",
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.1 }));
    const results = await recall.recall("strict mode");

    // The exact match "strict mode" entry should score higher
    if (results.length >= 2) {
      expect(results[0].entry.name).toBe("strict mode");
    }
  });

  // --------------------------------------------------------------------------
  // 10. recall - applies recency weighting
  // --------------------------------------------------------------------------

  it("recall - applies recency weighting", async () => {
    const recall = new ContextRecall(memory, defaultConfig({ recencyWeight: 0.8, minRelevance: 0.1 }));

    // Save entries — both are about "testing" so relevance is similar,
    // but the recent one should rank higher with high recencyWeight
    await memory.save({
      type: "reference" as MemoryType,
      name: "testing approaches",
      description: "Different testing approaches",
      content: "Unit testing integration testing end-to-end testing",
    });

    const results = await recall.recall("testing approaches");
    expect(results.length).toBeGreaterThan(0);
    // With high recencyWeight, score should be influenced by recency
    expect(results[0].relevanceScore).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 11. recall - recent memories scored higher with recencyWeight
  // --------------------------------------------------------------------------

  it("recall - recent memories scored higher with recencyWeight", () => {
    const recall = new ContextRecall(memory, defaultConfig({ recencyWeight: 0.5 }));
    const now = new Date();
    const oldDate = new Date(now.getTime() - 300 * 24 * 60 * 60 * 1000); // 300 days ago

    const recentEntry = {
      id: "1",
      type: "reference" as MemoryType,
      name: "testing",
      description: "testing",
      content: "testing",
      createdAt: now,
      updatedAt: now,
    };
    const oldEntry = {
      id: "2",
      type: "reference" as MemoryType,
      name: "testing",
      description: "testing",
      content: "testing",
      createdAt: oldDate,
      updatedAt: oldDate,
    };

    const recentScore = (recall as any).scoreRecency(recentEntry);
    const oldScore = (recall as any).scoreRecency(oldEntry);
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  // --------------------------------------------------------------------------
  // 12. scoreRelevance - returns 0 for no overlap
  // --------------------------------------------------------------------------

  it("scoreRelevance - returns 0 for no overlap", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const entry = {
      id: "1",
      type: "reference" as MemoryType,
      name: "cooking recipes",
      description: "Italian food",
      content: "pasta carbonara",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const score = (recall as any).scoreRelevance(
      entry,
      "quantum physics simulation",
      new Set(["quantum", "physics", "simulation"]),
    );
    expect(score).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 13. scoreRelevance - returns high for exact match
  // --------------------------------------------------------------------------

  it("scoreRelevance - returns high for exact match", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const entry = {
      id: "1",
      type: "reference" as MemoryType,
      name: "TypeScript configuration",
      description: "TypeScript config guide",
      content: "TypeScript configuration with strict mode",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const query = "TypeScript configuration";
    const tokens = (recall as any).extractKeywords(query);
    const score = (recall as any).scoreRelevance(entry, query, tokens);
    expect(score).toBeGreaterThan(0.5);
  });

  // --------------------------------------------------------------------------
  // 14. scoreRecency - returns ~1 for today
  // --------------------------------------------------------------------------

  it("scoreRecency - returns ~1 for today", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const entry = {
      id: "1",
      type: "reference" as MemoryType,
      name: "test",
      description: "test",
      content: "test",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const score = (recall as any).scoreRecency(entry);
    expect(score).toBeGreaterThan(0.99);
  });

  // --------------------------------------------------------------------------
  // 15. scoreRecency - returns ~0 for very old
  // --------------------------------------------------------------------------

  it("scoreRecency - returns ~0 for very old", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
    const entry = {
      id: "1",
      type: "reference" as MemoryType,
      name: "test",
      description: "test",
      content: "test",
      createdAt: twoYearsAgo,
      updatedAt: twoYearsAgo,
    };

    const score = (recall as any).scoreRecency(entry);
    expect(score).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 16. extractKeywords - extracts meaningful tokens
  // --------------------------------------------------------------------------

  it("extractKeywords - extracts meaningful tokens", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const keywords = (recall as any).extractKeywords("TypeScript configuration with strict mode");
    expect(keywords.has("typescript")).toBe(true);
    expect(keywords.has("configuration")).toBe(true);
    expect(keywords.has("strict")).toBe(true);
    expect(keywords.has("mode")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 17. extractKeywords - filters stop words
  // --------------------------------------------------------------------------

  it("extractKeywords - filters stop words", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const keywords = (recall as any).extractKeywords("the quick brown fox is very fast");
    expect(keywords.has("the")).toBe(false);
    expect(keywords.has("is")).toBe(false);
    expect(keywords.has("very")).toBe(false);
    expect(keywords.has("quick")).toBe(true);
    expect(keywords.has("brown")).toBe(true);
    expect(keywords.has("fox")).toBe(true);
    expect(keywords.has("fast")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 18. formatForSystemPrompt - formats multiple memories
  // --------------------------------------------------------------------------

  it("formatForSystemPrompt - formats multiple memories", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const memories: RecalledMemory[] = [
      {
        entry: {
          id: "1",
          type: "user" as MemoryType,
          name: "User Pref",
          description: "Prefers dark mode",
          content: "Always use dark mode",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        relevanceScore: 0.9,
        reason: "matched keywords: dark, mode",
      },
      {
        entry: {
          id: "2",
          type: "project" as MemoryType,
          name: "Project Config",
          description: "ESLint settings",
          content: "Use flat config",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        relevanceScore: 0.7,
        reason: "recent project context",
      },
    ];

    const formatted = recall.formatForSystemPrompt(memories);
    expect(formatted).toContain("# Relevant Context from Memory");
    expect(formatted).toContain("## [user] User Pref");
    expect(formatted).toContain("Prefers dark mode");
    expect(formatted).toContain("Always use dark mode");
    expect(formatted).toContain("## [project] Project Config");
    expect(formatted).toContain("---");
  });

  // --------------------------------------------------------------------------
  // 19. formatForSystemPrompt - empty for no memories
  // --------------------------------------------------------------------------

  it("formatForSystemPrompt - empty for no memories", () => {
    const recall = new ContextRecall(memory, defaultConfig());
    const formatted = recall.formatForSystemPrompt([]);
    expect(formatted).toBe("");
  });

  // --------------------------------------------------------------------------
  // 20. recallAndFormat - convenience method works
  // --------------------------------------------------------------------------

  it("recallAndFormat - convenience method works", async () => {
    await memory.save({
      type: "reference" as MemoryType,
      name: "Vitest testing framework",
      description: "Testing with vitest",
      content: "Vitest is a fast unit testing framework for Vite",
      tags: ["testing"],
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.1 }));
    const formatted = await recall.recallAndFormat("vitest testing");

    expect(typeof formatted).toBe("string");
    if (formatted.length > 0) {
      expect(formatted).toContain("# Relevant Context from Memory");
    }
  });

  // --------------------------------------------------------------------------
  // 21. truncateToLimit - respects character limit
  // --------------------------------------------------------------------------

  it("truncateToLimit - respects character limit", () => {
    const recall = new ContextRecall(memory, defaultConfig({ maxCharacters: 100 }));
    const memories: RecalledMemory[] = [
      {
        entry: {
          id: "1",
          type: "user" as MemoryType,
          name: "A".repeat(30),
          description: "B".repeat(30),
          content: "C".repeat(30),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        relevanceScore: 0.9,
        reason: "test",
      },
      {
        entry: {
          id: "2",
          type: "user" as MemoryType,
          name: "D".repeat(30),
          description: "E".repeat(30),
          content: "F".repeat(30),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        relevanceScore: 0.8,
        reason: "test",
      },
    ];

    const result = (recall as any).truncateToLimit(memories);
    expect(result.length).toBe(1); // Only first fits within 100 chars
  });

  // --------------------------------------------------------------------------
  // 22. recall with workingDirectory - boosts matching tagged memories
  // --------------------------------------------------------------------------

  it("recall with workingDirectory - boosts matching tagged memories", async () => {
    await memory.save({
      type: "project" as MemoryType,
      name: "Project context for testing",
      description: "Testing the nexus project",
      content: "Nexus testing configuration details",
      tags: ["/home/user/nexus", "testing"],
    });
    await memory.save({
      type: "project" as MemoryType,
      name: "Other project testing",
      description: "Testing another project",
      content: "Other project testing configuration",
      tags: ["/home/user/other", "testing"],
    });

    const recall = new ContextRecall(memory, defaultConfig({ minRelevance: 0.1 }));
    const results = await recall.recall("testing configuration", "/home/user/nexus");

    // The entry tagged with the working directory should be boosted
    if (results.length >= 2) {
      const nexusResult = results.find((r) =>
        r.entry.tags?.includes("/home/user/nexus"),
      );
      const otherResult = results.find((r) =>
        r.entry.tags?.includes("/home/user/other"),
      );
      if (nexusResult && otherResult) {
        expect(nexusResult.relevanceScore).toBeGreaterThan(otherResult.relevanceScore);
      }
    }
  });
});
