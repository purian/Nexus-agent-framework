import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryManager } from "./index.js";
import { createMemoryTool } from "./tool.js";
import type {
  MemoryEntry,
  MemoryType,
  ToolContext,
  PermissionContext,
  PermissionDecision,
  NexusConfig,
} from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

/** Create a unique temp directory for each test's database. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `nexus-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a minimal ToolContext with allowAll permissions. */
function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
  const permissions: PermissionContext = {
    mode: "allowAll",
    rules: [],
    checkPermission(): PermissionDecision {
      return { behavior: "allow" };
    },
    addRule() {},
    removeRule() {},
  };

  return {
    workingDirectory: tmpdir(),
    abortSignal: new AbortController().signal,
    permissions,
    config: {
      defaultModel: "test-model",
      defaultProvider: "test-provider",
      workingDirectory: tmpdir(),
      dataDirectory: tmpdir(),
      permissionMode: "allowAll",
      permissionRules: [],
      mcpServers: [],
      platforms: {},
      plugins: [],
      maxConcurrentTools: 4,
      thinking: { enabled: false },
    } as NexusConfig,
    ...overrides,
  };
}

/** Shorthand for building a memory input payload. */
function sampleMemory(overrides?: Partial<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">>) {
  return {
    type: ("user" as MemoryType),
    name: "Test memory",
    description: "A test memory entry",
    content: "This is the content of the test memory.",
    tags: ["test"],
    ...overrides,
  };
}

// ============================================================================
// MemoryManager tests
// ============================================================================

describe("MemoryManager", () => {
  let tempDir: string;
  let manager: MemoryManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = MemoryManager.create(tempDir);
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 1. Construction
  // --------------------------------------------------------------------------

  it("creates the database file and memories table on construction", async () => {
    // If we can list without error, the table exists.
    const entries = await manager.list();
    expect(entries).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 2. save()
  // --------------------------------------------------------------------------

  it("save() creates a memory with auto-generated id and timestamps", async () => {
    const input = sampleMemory();
    const entry = await manager.save(input);

    expect(entry.id).toBeDefined();
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);

    expect(entry.type).toBe(input.type);
    expect(entry.name).toBe(input.name);
    expect(entry.description).toBe(input.description);
    expect(entry.content).toBe(input.content);
    expect(entry.tags).toEqual(input.tags);

    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.updatedAt).toBeInstanceOf(Date);
    expect(entry.createdAt.getTime()).toBe(entry.updatedAt.getTime());
  });

  it("save() persists the memory so it can be retrieved", async () => {
    const entry = await manager.save(sampleMemory());
    const retrieved = await manager.get(entry.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(entry.id);
    expect(retrieved!.name).toBe(entry.name);
    expect(retrieved!.content).toBe(entry.content);
  });

  it("save() handles missing tags gracefully", async () => {
    const entry = await manager.save({
      type: "project",
      name: "No tags",
      description: "Entry without tags",
      content: "Some content",
    });

    expect(entry.tags).toBeUndefined();

    // Persisted version should round-trip as empty array (JSON.parse('[]'))
    const retrieved = await manager.get(entry.id);
    expect(retrieved!.tags).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 3. get()
  // --------------------------------------------------------------------------

  it("get() retrieves a memory by id", async () => {
    const saved = await manager.save(sampleMemory({ name: "Retrievable" }));
    const retrieved = await manager.get(saved.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(saved.id);
    expect(retrieved!.name).toBe("Retrievable");
  });

  it("get() returns null for a non-existent id", async () => {
    const result = await manager.get("non-existent-id");
    expect(result).toBeNull();
  });

  it("get() returns null for a random UUID that was never saved", async () => {
    const result = await manager.get(randomUUID());
    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 4. search() — full-text search
  // --------------------------------------------------------------------------

  it("search() finds memories by text query matching name", async () => {
    await manager.save(sampleMemory({ name: "TypeScript preferences" }));
    await manager.save(sampleMemory({ name: "Python preferences" }));

    const results = await manager.search("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("TypeScript preferences");
  });

  it("search() finds memories by text query matching content", async () => {
    await manager.save(
      sampleMemory({
        name: "Editor setup",
        content: "I prefer Neovim with LSP configured for TypeScript",
      }),
    );
    await manager.save(
      sampleMemory({
        name: "Shell setup",
        content: "I use Zsh with Oh My Zsh and Starship prompt",
      }),
    );

    const results = await manager.search("Neovim");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("Editor setup");
  });

  it("search() finds memories by text query matching description", async () => {
    await manager.save(
      sampleMemory({
        name: "DB note",
        description: "PostgreSQL connection settings for production",
        content: "host=db.prod.internal port=5432",
      }),
    );

    const results = await manager.search("PostgreSQL");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("DB note");
  });

  it("search() returns empty array when nothing matches", async () => {
    await manager.save(sampleMemory({ name: "Something" }));
    const results = await manager.search("xyznonexistent");
    expect(results).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 5. search() — type filter
  // --------------------------------------------------------------------------

  it("search() filters by type when provided", async () => {
    await manager.save(
      sampleMemory({
        type: "user",
        name: "Dark mode preference",
        content: "User prefers dark mode themes",
      }),
    );
    await manager.save(
      sampleMemory({
        type: "project",
        name: "Project dark theme config",
        content: "Dark theme CSS variables and configuration",
      }),
    );

    const userResults = await manager.search("dark", "user");
    expect(userResults.length).toBe(1);
    expect(userResults[0].type).toBe("user");

    const projectResults = await manager.search("dark", "project");
    expect(projectResults.length).toBe(1);
    expect(projectResults[0].type).toBe("project");

    const allResults = await manager.search("dark");
    expect(allResults.length).toBe(2);
  });

  // --------------------------------------------------------------------------
  // 6. list()
  // --------------------------------------------------------------------------

  it("list() returns all memories", async () => {
    await manager.save(sampleMemory({ name: "First" }));
    await manager.save(sampleMemory({ name: "Second" }));
    await manager.save(sampleMemory({ name: "Third" }));

    const entries = await manager.list();
    expect(entries.length).toBe(3);
  });

  it("list() returns memories ordered by updated_at descending", async () => {
    const first = await manager.save(sampleMemory({ name: "First" }));
    const second = await manager.save(sampleMemory({ name: "Second" }));
    const third = await manager.save(sampleMemory({ name: "Third" }));

    const entries = await manager.list();
    // Most recently created/updated should come first
    expect(entries[0].name).toBe("Third");
    expect(entries[2].name).toBe("First");
  });

  it("list() returns empty array when no memories exist", async () => {
    const entries = await manager.list();
    expect(entries).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 7. list() — type filter
  // --------------------------------------------------------------------------

  it("list() filters by type", async () => {
    await manager.save(sampleMemory({ type: "user", name: "User pref" }));
    await manager.save(sampleMemory({ type: "feedback", name: "Feedback item" }));
    await manager.save(sampleMemory({ type: "project", name: "Project note" }));
    await manager.save(sampleMemory({ type: "reference", name: "Ref doc" }));

    const userEntries = await manager.list("user");
    expect(userEntries.length).toBe(1);
    expect(userEntries[0].name).toBe("User pref");

    const feedbackEntries = await manager.list("feedback");
    expect(feedbackEntries.length).toBe(1);
    expect(feedbackEntries[0].name).toBe("Feedback item");

    const allEntries = await manager.list();
    expect(allEntries.length).toBe(4);
  });

  // --------------------------------------------------------------------------
  // 8. update()
  // --------------------------------------------------------------------------

  it("update() modifies specified fields and updates timestamp", async () => {
    const original = await manager.save(
      sampleMemory({
        name: "Original name",
        content: "Original content",
      }),
    );

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    const updated = await manager.update(original.id, {
      name: "Updated name",
      content: "Updated content",
    });

    expect(updated.id).toBe(original.id);
    expect(updated.name).toBe("Updated name");
    expect(updated.content).toBe("Updated content");
    // Unmodified fields should be preserved
    expect(updated.description).toBe(original.description);
    expect(updated.type).toBe(original.type);
    // Timestamps
    expect(updated.createdAt.getTime()).toBe(original.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      original.updatedAt.getTime(),
    );
  });

  it("update() persists changes to the database", async () => {
    const original = await manager.save(sampleMemory({ name: "Before" }));
    await manager.update(original.id, { name: "After" });

    const retrieved = await manager.get(original.id);
    expect(retrieved!.name).toBe("After");
  });

  it("update() throws for non-existent id", async () => {
    await expect(
      manager.update("non-existent-id", { name: "Nope" }),
    ).rejects.toThrow("Memory entry not found");
  });

  it("update() updates the FTS index so search reflects changes", async () => {
    const entry = await manager.save(
      sampleMemory({
        name: "Alpha name",
        content: "Alpha content about JavaScript",
      }),
    );

    // Should be searchable by old content
    let results = await manager.search("JavaScript");
    expect(results.length).toBe(1);

    await manager.update(entry.id, {
      content: "Updated content about Rust programming",
    });

    // Old term should no longer match
    results = await manager.search("JavaScript");
    expect(results.length).toBe(0);

    // New term should match
    results = await manager.search("Rust");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(entry.id);
  });

  // --------------------------------------------------------------------------
  // 9. delete()
  // --------------------------------------------------------------------------

  it("delete() removes a memory", async () => {
    const entry = await manager.save(sampleMemory());
    await manager.delete(entry.id);

    const retrieved = await manager.get(entry.id);
    expect(retrieved).toBeNull();
  });

  it("delete() throws for non-existent id", async () => {
    await expect(manager.delete("non-existent-id")).rejects.toThrow(
      "Memory entry not found",
    );
  });

  it("delete() removes entry from list results", async () => {
    const a = await manager.save(sampleMemory({ name: "A" }));
    const b = await manager.save(sampleMemory({ name: "B" }));

    await manager.delete(a.id);

    const entries = await manager.list();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe(b.id);
  });

  it("delete() removes entry from FTS index", async () => {
    const entry = await manager.save(
      sampleMemory({ content: "Unique searchable xylophone content" }),
    );

    let results = await manager.search("xylophone");
    expect(results.length).toBe(1);

    await manager.delete(entry.id);

    results = await manager.search("xylophone");
    expect(results.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // 10. Multiple memories — ranking
  // --------------------------------------------------------------------------

  it("saves several memories and search returns ranked results", async () => {
    // Create memories with varying relevance to "Kubernetes deployment"
    await manager.save(
      sampleMemory({
        name: "Kubernetes deployment guide",
        description: "How to deploy services to Kubernetes clusters",
        content:
          "Use kubectl apply to deploy manifests. Kubernetes deployment strategies include rolling updates and blue-green deployment.",
      }),
    );
    await manager.save(
      sampleMemory({
        name: "Docker basics",
        description: "Introduction to Docker containers",
        content:
          "Docker containers are lightweight. Can be used with Kubernetes for deployment orchestration.",
      }),
    );
    await manager.save(
      sampleMemory({
        name: "Git workflow",
        description: "Team git branching strategy",
        content:
          "We use trunk-based development with short-lived feature branches.",
      }),
    );

    const results = await manager.search("Kubernetes deployment");
    // The Kubernetes-focused entry should appear and Git workflow should not
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("Kubernetes deployment guide");
    // Git workflow should not appear since it has no relevant terms
    const gitResult = results.find((r) => r.name === "Git workflow");
    expect(gitResult).toBeUndefined();
  });

  it("handles many memories without error", async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      manager.save(
        sampleMemory({
          name: `Memory ${i}`,
          content: `Content for memory number ${i}`,
          type: (["user", "feedback", "project", "reference"] as const)[i % 4],
        }),
      ),
    );
    await Promise.all(promises);

    const all = await manager.list();
    expect(all.length).toBe(50);

    const userOnly = await manager.list("user");
    expect(userOnly.length).toBe(13); // indices 0,4,8,...48 => 13

    const results = await manager.search("memory number");
    expect(results.length).toBe(50);
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  it("handles special characters in search queries", async () => {
    await manager.save(
      sampleMemory({
        name: 'Quotes "test"',
        content: "Content with special chars: &, <, >, quotes",
      }),
    );

    // Double-quote escaping in FTS5
    const results = await manager.search('special chars');
    expect(results.length).toBe(1);
  });

  it("static create() factory method works", () => {
    const dir = makeTempDir();
    try {
      const m = MemoryManager.create(dir);
      // Should not throw and should be usable
      expect(m).toBeInstanceOf(MemoryManager);
      m.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// MemoryTool (createMemoryTool) tests
// ============================================================================

describe("createMemoryTool", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ctx: ToolContext;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = MemoryManager.create(tempDir);
    ctx = makeToolContext();
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // 1. Tool metadata
  // --------------------------------------------------------------------------

  it('has the correct name "memory"', () => {
    const tool = createMemoryTool(manager);
    expect(tool.name).toBe("memory");
  });

  it("has a non-empty description", () => {
    const tool = createMemoryTool(manager);
    expect(tool.description).toBeDefined();
    expect(tool.description.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // 2. "save" action
  // --------------------------------------------------------------------------

  it('"save" action creates a memory and returns it', async () => {
    const tool = createMemoryTool(manager);

    const result = await tool.execute(
      {
        action: "save",
        type: "user",
        name: "Theme preference",
        description: "User prefers dark mode",
        content: "Always use dark mode in editors and terminals",
        tags: ["ui", "preferences"],
      } as unknown as Record<string, unknown>,
      ctx,
    );

    expect(result.data).toHaveProperty("saved");
    const saved = (result.data as { saved: MemoryEntry }).saved;
    expect(saved.name).toBe("Theme preference");
    expect(saved.type).toBe("user");
    expect(saved.id).toBeDefined();

    // Verify it was actually persisted
    const retrieved = await manager.get(saved.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Theme preference");
  });

  it('"save" action works without optional tags', async () => {
    const tool = createMemoryTool(manager);

    const result = await tool.execute(
      {
        action: "save",
        type: "feedback",
        name: "No tags entry",
        description: "An entry without tags",
        content: "Content here",
      } as unknown as Record<string, unknown>,
      ctx,
    );

    const saved = (result.data as { saved: MemoryEntry }).saved;
    expect(saved.name).toBe("No tags entry");
  });

  // --------------------------------------------------------------------------
  // 3. "search" action
  // --------------------------------------------------------------------------

  it('"search" action finds memories', async () => {
    const tool = createMemoryTool(manager);

    // Seed data
    await manager.save(
      sampleMemory({ name: "Vim keybindings", content: "I use Vim keybindings everywhere" }),
    );
    await manager.save(
      sampleMemory({ name: "Tab width", content: "I prefer 2-space indentation" }),
    );

    const result = await tool.execute(
      { action: "search", query: "Vim" } as unknown as Record<string, unknown>,
      ctx,
    );

    expect(result.data).toHaveProperty("results");
    expect(result.data).toHaveProperty("count");
    const { results, count } = result.data as { results: MemoryEntry[]; count: number };
    expect(count).toBe(1);
    expect(results[0].name).toBe("Vim keybindings");
  });

  it('"search" action supports type filter', async () => {
    const tool = createMemoryTool(manager);

    await manager.save(
      sampleMemory({ type: "user", name: "User pref", content: "Coding style preference" }),
    );
    await manager.save(
      sampleMemory({ type: "project", name: "Project style", content: "Coding style guidelines" }),
    );

    const result = await tool.execute(
      { action: "search", query: "Coding style", type: "user" } as unknown as Record<string, unknown>,
      ctx,
    );

    const { results } = result.data as { results: MemoryEntry[]; count: number };
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("user");
  });

  it('"search" action returns empty results when nothing matches', async () => {
    const tool = createMemoryTool(manager);

    const result = await tool.execute(
      { action: "search", query: "nonexistent" } as unknown as Record<string, unknown>,
      ctx,
    );

    const { results, count } = result.data as { results: MemoryEntry[]; count: number };
    expect(count).toBe(0);
    expect(results).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 4. "list" action
  // --------------------------------------------------------------------------

  it('"list" action returns all memories', async () => {
    const tool = createMemoryTool(manager);

    await manager.save(sampleMemory({ name: "A" }));
    await manager.save(sampleMemory({ name: "B" }));

    const result = await tool.execute(
      { action: "list" } as unknown as Record<string, unknown>,
      ctx,
    );

    expect(result.data).toHaveProperty("entries");
    expect(result.data).toHaveProperty("count");
    const { entries, count } = result.data as { entries: MemoryEntry[]; count: number };
    expect(count).toBe(2);
    expect(entries.length).toBe(2);
  });

  it('"list" action filters by type', async () => {
    const tool = createMemoryTool(manager);

    await manager.save(sampleMemory({ type: "user", name: "User one" }));
    await manager.save(sampleMemory({ type: "project", name: "Project one" }));

    const result = await tool.execute(
      { action: "list", type: "project" } as unknown as Record<string, unknown>,
      ctx,
    );

    const { entries, count } = result.data as { entries: MemoryEntry[]; count: number };
    expect(count).toBe(1);
    expect(entries[0].type).toBe("project");
  });

  it('"list" action returns empty when no memories exist', async () => {
    const tool = createMemoryTool(manager);

    const result = await tool.execute(
      { action: "list" } as unknown as Record<string, unknown>,
      ctx,
    );

    const { entries, count } = result.data as { entries: MemoryEntry[]; count: number };
    expect(count).toBe(0);
    expect(entries).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // 5. "delete" action
  // --------------------------------------------------------------------------

  it('"delete" action removes a memory', async () => {
    const tool = createMemoryTool(manager);

    const saved = await manager.save(sampleMemory({ name: "To delete" }));

    const result = await tool.execute(
      { action: "delete", id: saved.id } as unknown as Record<string, unknown>,
      ctx,
    );

    expect(result.data).toHaveProperty("deleted");
    expect((result.data as { deleted: string }).deleted).toBe(saved.id);

    // Verify it was actually removed
    const retrieved = await manager.get(saved.id);
    expect(retrieved).toBeNull();
  });

  it('"delete" action throws for non-existent id', async () => {
    const tool = createMemoryTool(manager);

    await expect(
      tool.execute(
        { action: "delete", id: "non-existent" } as unknown as Record<string, unknown>,
        ctx,
      ),
    ).rejects.toThrow("Memory entry not found");
  });

  // --------------------------------------------------------------------------
  // 6. isConcurrencySafe
  // --------------------------------------------------------------------------

  it("isConcurrencySafe returns true for all actions", () => {
    const tool = createMemoryTool(manager);

    expect(
      tool.isConcurrencySafe({ action: "save", type: "user", name: "x", description: "x", content: "x" } as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      tool.isConcurrencySafe({ action: "search", query: "test" } as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      tool.isConcurrencySafe({ action: "list" } as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      tool.isConcurrencySafe({ action: "delete", id: "abc" } as unknown as Record<string, unknown>),
    ).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 7. isReadOnly
  // --------------------------------------------------------------------------

  it("isReadOnly returns true for search and list", () => {
    const tool = createMemoryTool(manager);

    expect(
      tool.isReadOnly({ action: "search", query: "test" } as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      tool.isReadOnly({ action: "list" } as unknown as Record<string, unknown>),
    ).toBe(true);
  });

  it("isReadOnly returns false for save and delete", () => {
    const tool = createMemoryTool(manager);

    expect(
      tool.isReadOnly({
        action: "save",
        type: "user",
        name: "x",
        description: "x",
        content: "x",
      } as unknown as Record<string, unknown>),
    ).toBe(false);
    expect(
      tool.isReadOnly({ action: "delete", id: "abc" } as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  it("isReadOnly returns false for invalid input", () => {
    const tool = createMemoryTool(manager);

    expect(
      tool.isReadOnly({ action: "invalid" } as unknown as Record<string, unknown>),
    ).toBe(false);
    expect(
      tool.isReadOnly({} as unknown as Record<string, unknown>),
    ).toBe(false);
  });

  // --------------------------------------------------------------------------
  // renderToolUse and renderResult
  // --------------------------------------------------------------------------

  it("renderToolUse formats save action", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderToolUse!({ action: "save", name: "My pref", type: "user" });
    expect(text).toContain("save");
    expect(text).toContain("My pref");
    expect(text).toContain("user");
  });

  it("renderToolUse formats search action", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderToolUse!({ action: "search", query: "test query" });
    expect(text).toContain("search");
    expect(text).toContain("test query");
  });

  it("renderToolUse formats list action", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderToolUse!({ action: "list" });
    expect(text).toContain("list");
  });

  it("renderToolUse formats delete action", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderToolUse!({ action: "delete", id: "abc-123" });
    expect(text).toContain("delete");
    expect(text).toContain("abc-123");
  });

  it("renderToolUse handles unknown action gracefully", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderToolUse!({});
    expect(text).toBe("memory");
  });

  it("renderResult formats save output", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderResult!({
      saved: {
        id: "abc",
        type: "user",
        name: "My memory",
        description: "desc",
        content: "content",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(text).toContain("My memory");
    expect(text).toContain("abc");
  });

  it("renderResult formats empty search output", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderResult!({ results: [], count: 0 });
    expect(text).toContain("No matching memories");
  });

  it("renderResult formats search output with results", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderResult!({
      results: [
        {
          id: "1",
          type: "user" as MemoryType,
          name: "Pref",
          description: "A preference",
          content: "c",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      count: 1,
    });
    expect(text).toContain("[user]");
    expect(text).toContain("Pref");
  });

  it("renderResult formats empty list output", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderResult!({ entries: [], count: 0 });
    expect(text).toContain("No memories stored");
  });

  it("renderResult formats delete output", () => {
    const tool = createMemoryTool(manager);
    const text = tool.renderResult!({ deleted: "abc-123" });
    expect(text).toContain("Deleted");
    expect(text).toContain("abc-123");
  });

  // --------------------------------------------------------------------------
  // Input validation
  // --------------------------------------------------------------------------

  it("rejects invalid action via zod schema", async () => {
    const tool = createMemoryTool(manager);

    await expect(
      tool.execute(
        { action: "unknown_action" } as unknown as Record<string, unknown>,
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("rejects save with missing required fields", async () => {
    const tool = createMemoryTool(manager);

    await expect(
      tool.execute(
        { action: "save", type: "user" } as unknown as Record<string, unknown>,
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("rejects save with invalid type", async () => {
    const tool = createMemoryTool(manager);

    await expect(
      tool.execute(
        {
          action: "save",
          type: "invalid_type",
          name: "x",
          description: "x",
          content: "x",
        } as unknown as Record<string, unknown>,
        ctx,
      ),
    ).rejects.toThrow();
  });
});
