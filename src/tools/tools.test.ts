import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext, PermissionContext, NexusConfig } from "../types/index.js";
import { bashTool } from "./bash.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { createDefaultTools } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "nexus-test-"));
}

function makePermissions(mode: "default" | "allowAll" = "allowAll"): PermissionContext {
  return {
    mode,
    rules: [],
    checkPermission(_toolName: string, _input: Record<string, unknown>) {
      if (mode === "allowAll") {
        return { behavior: "allow" as const };
      }
      return { behavior: "ask" as const, message: "Permission required" };
    },
    addRule() {},
    removeRule() {},
  };
}

function makeConfig(workingDirectory: string): NexusConfig {
  return {
    defaultModel: "test",
    defaultProvider: "test",
    workingDirectory,
    dataDirectory: workingDirectory,
    permissionMode: "allowAll",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 4,
    thinking: { enabled: false },
  };
}

function makeContext(
  tempDir: string,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    workingDirectory: tempDir,
    abortSignal: new AbortController().signal,
    permissions: makePermissions("allowAll"),
    config: makeConfig(tempDir),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = makeTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ============================== Bash ==============================

describe("bashTool", () => {
  it("executes a simple command", async () => {
    const ctx = makeContext(tempDir);
    const result = await bashTool.execute({ command: 'echo "hello"', timeout: 120 }, ctx);
    expect(result.data.stdout.trim()).toBe("hello");
    expect(result.data.exitCode).toBe(0);
  });

  it("returns stderr on error", async () => {
    const ctx = makeContext(tempDir);
    const result = await bashTool.execute(
      { command: "ls /nonexistent_path_abc_xyz_123", timeout: 120 },
      ctx,
    );
    expect(result.data.stderr).toBeTruthy();
    expect(result.data.exitCode).not.toBe(0);
  });

  it("respects timeout", async () => {
    const ctx = makeContext(tempDir);
    const result = await bashTool.execute(
      { command: "sleep 30", timeout: 1 },
      ctx,
    );
    expect(result.data.stderr).toContain("timed out");
  }, 10_000);

  it("isConcurrencySafe returns false", () => {
    expect(bashTool.isConcurrencySafe({ command: "echo hi", timeout: 120 })).toBe(false);
  });

  it('checkPermissions returns "ask" in default mode', async () => {
    const ctx = makeContext(tempDir, {
      permissions: makePermissions("default"),
    });
    const decision = await bashTool.checkPermissions!(
      { command: "echo hi", timeout: 120 },
      ctx,
    );
    expect(decision.behavior).toBe("ask");
  });
});

// ============================== ReadFile ==============================

describe("readFileTool", () => {
  it("reads file content with line numbers", async () => {
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "line one\nline two\nline three\n");

    const ctx = makeContext(tempDir);
    const result = await readFileTool.execute({ path: filePath }, ctx);

    expect(result.data.content).toContain("1\tline one");
    expect(result.data.content).toContain("2\tline two");
    expect(result.data.content).toContain("3\tline three");
    expect(result.data.totalLines).toBe(4); // trailing newline creates empty 4th element
  });

  it("supports offset and limit", async () => {
    const filePath = join(tempDir, "lines.txt");
    writeFileSync(filePath, "a\nb\nc\nd\ne\n");

    const ctx = makeContext(tempDir);
    const result = await readFileTool.execute(
      { path: filePath, offset: 2, limit: 2 },
      ctx,
    );

    expect(result.data.linesRead).toEqual([2, 3]);
    expect(result.data.content).toContain("b");
    expect(result.data.content).toContain("c");
    expect(result.data.content).not.toContain("a");
    expect(result.data.content).not.toContain("\td\n");
  });

  it("returns error for non-existent file", async () => {
    const ctx = makeContext(tempDir);
    await expect(
      readFileTool.execute({ path: join(tempDir, "nope.txt") }, ctx),
    ).rejects.toThrow(/Failed to read/);
  });

  it("isConcurrencySafe returns true and isReadOnly returns true", () => {
    const input = { path: "any.txt" };
    expect(readFileTool.isConcurrencySafe(input)).toBe(true);
    expect(readFileTool.isReadOnly(input)).toBe(true);
  });
});

// ============================== WriteFile ==============================

describe("writeFileTool", () => {
  it("creates a file with content", async () => {
    const filePath = join(tempDir, "out.txt");
    const ctx = makeContext(tempDir);
    const result = await writeFileTool.execute(
      { path: filePath, content: "hello world" },
      ctx,
    );

    expect(result.data.path).toBe(filePath);
    expect(result.data.bytesWritten).toBe(Buffer.byteLength("hello world", "utf-8"));
    expect(readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("creates directories if needed", async () => {
    const filePath = join(tempDir, "a", "b", "c", "deep.txt");
    const ctx = makeContext(tempDir);
    await writeFileTool.execute(
      { path: filePath, content: "deep content" },
      ctx,
    );
    expect(readFileSync(filePath, "utf-8")).toBe("deep content");
  });

  it("overwrites existing file", async () => {
    const filePath = join(tempDir, "overwrite.txt");
    writeFileSync(filePath, "old");

    const ctx = makeContext(tempDir);
    await writeFileTool.execute(
      { path: filePath, content: "new" },
      ctx,
    );
    expect(readFileSync(filePath, "utf-8")).toBe("new");
  });
});

// ============================== EditFile ==============================

describe("editFileTool", () => {
  it("replaces old_string with new_string", async () => {
    const filePath = join(tempDir, "edit.txt");
    writeFileSync(filePath, "foo bar baz");

    const ctx = makeContext(tempDir);
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "bar",
        new_string: "qux",
        replace_all: false,
      },
      ctx,
    );

    expect(result.data.replacements).toBe(1);
    expect(readFileSync(filePath, "utf-8")).toBe("foo qux baz");
  });

  it("fails if old_string not found", async () => {
    const filePath = join(tempDir, "edit2.txt");
    writeFileSync(filePath, "hello world");

    const ctx = makeContext(tempDir);
    await expect(
      editFileTool.execute(
        {
          path: filePath,
          old_string: "missing",
          new_string: "replacement",
          replace_all: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/old_string not found/);
  });

  it("fails if old_string not unique and replace_all is false", async () => {
    const filePath = join(tempDir, "edit3.txt");
    writeFileSync(filePath, "aaa bbb aaa ccc");

    const ctx = makeContext(tempDir);
    await expect(
      editFileTool.execute(
        {
          path: filePath,
          old_string: "aaa",
          new_string: "zzz",
          replace_all: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/multiple times/);
  });

  it("replace_all replaces all occurrences", async () => {
    const filePath = join(tempDir, "edit4.txt");
    writeFileSync(filePath, "aaa bbb aaa ccc aaa");

    const ctx = makeContext(tempDir);
    const result = await editFileTool.execute(
      {
        path: filePath,
        old_string: "aaa",
        new_string: "zzz",
        replace_all: true,
      },
      ctx,
    );

    expect(result.data.replacements).toBe(3);
    expect(readFileSync(filePath, "utf-8")).toBe("zzz bbb zzz ccc zzz");
  });
});

// ============================== Glob ==============================

describe("globTool", () => {
  it("finds files matching pattern", async () => {
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(join(tempDir, "src", "a.ts"), "");
    writeFileSync(join(tempDir, "src", "b.ts"), "");
    writeFileSync(join(tempDir, "src", "c.js"), "");

    const ctx = makeContext(tempDir);
    const result = await globTool.execute(
      { pattern: "**/*.ts" },
      ctx,
    );

    expect(result.data.count).toBe(2);
    expect(result.data.files).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a.ts"),
        expect.stringContaining("b.ts"),
      ]),
    );
    // Should not include the .js file
    for (const f of result.data.files) {
      expect(f).not.toContain("c.js");
    }
  });

  it("returns empty for no matches", async () => {
    const ctx = makeContext(tempDir);
    const result = await globTool.execute(
      { pattern: "**/*.nonexistent" },
      ctx,
    );
    expect(result.data.count).toBe(0);
    expect(result.data.files).toEqual([]);
  });
});

// ============================== Grep ==============================

describe("grepTool", () => {
  it("finds content matching pattern", async () => {
    writeFileSync(join(tempDir, "search.txt"), "hello world\nfoo bar\nhello again\n");

    const ctx = makeContext(tempDir);
    const result = await grepTool.execute(
      { pattern: "hello" },
      ctx,
    );

    expect(result.data.matchCount).toBeGreaterThanOrEqual(2);
    expect(result.data.matches).toContain("hello world");
    expect(result.data.matches).toContain("hello again");
  });

  it("respects include filter", async () => {
    writeFileSync(join(tempDir, "data.ts"), "findme here\n");
    writeFileSync(join(tempDir, "data.js"), "findme there\n");

    const ctx = makeContext(tempDir);
    const result = await grepTool.execute(
      { pattern: "findme", include: "*.ts" },
      ctx,
    );

    expect(result.data.matchCount).toBe(1);
    expect(result.data.matches).toContain("data.ts");
    expect(result.data.matches).not.toContain("data.js");
  });
});

// ============================== createDefaultTools ==============================

describe("createDefaultTools", () => {
  it("returns array of all tools", () => {
    const tools = createDefaultTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(6);

    const names = tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
  });

  it("each tool has name and description", () => {
    const tools = createDefaultTools();
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
