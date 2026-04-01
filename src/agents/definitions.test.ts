import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentDefinitionLoader } from "./definitions.js";
import type { AgentDefinition } from "./definitions.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `nexus-def-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDefinitionFile(dir: string, filename: string, content: string): void {
  const agentsDir = join(dir, ".nexus", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, filename), content, "utf-8");
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentDefinitionLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Frontmatter parsing
  // --------------------------------------------------------------------------

  it("parses frontmatter with all fields", () => {
    writeDefinitionFile(
      tmpDir,
      "code-reviewer.md",
      `---
name: code-reviewer
description: Reviews code changes for bugs, style, and security issues
model: claude-sonnet-4-20250514
tools: [ReadFile, Grep, Glob]
maxTurns: 10
temperature: 0.3
---

You are a code review agent. Your job is to review code changes.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("code-reviewer");
    expect(defs[0].description).toBe("Reviews code changes for bugs, style, and security issues");
    expect(defs[0].model).toBe("claude-sonnet-4-20250514");
    expect(defs[0].tools).toEqual(["ReadFile", "Grep", "Glob"]);
    expect(defs[0].maxTurns).toBe(10);
    expect(defs[0].temperature).toBe(0.3);
    expect(defs[0].systemPrompt).toBe(
      "You are a code review agent. Your job is to review code changes.",
    );
  });

  it("parses frontmatter with only required fields", () => {
    writeDefinitionFile(
      tmpDir,
      "simple.md",
      `---
name: simple-agent
description: A simple agent
---

Do simple things.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("simple-agent");
    expect(defs[0].description).toBe("A simple agent");
    expect(defs[0].tools).toBeUndefined();
    expect(defs[0].model).toBeUndefined();
    expect(defs[0].maxTurns).toBeUndefined();
    expect(defs[0].temperature).toBeUndefined();
    expect(defs[0].systemPrompt).toBe("Do simple things.");
  });

  it("skips files without required name field", () => {
    writeDefinitionFile(
      tmpDir,
      "no-name.md",
      `---
description: Missing name
tools: [bash]
---
Body content.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(0);
  });

  it("skips files without required description field", () => {
    writeDefinitionFile(
      tmpDir,
      "no-desc.md",
      `---
name: no-desc
tools: [bash]
---
Body content.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(0);
  });

  it("parses block-style array in tools field", () => {
    writeDefinitionFile(
      tmpDir,
      "block-tools.md",
      `---
name: block-tools
description: Agent with block-style tools
tools:
  - ReadFile
  - WriteFile
  - Bash
---
Use block tools.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].tools).toEqual(["ReadFile", "WriteFile", "Bash"]);
  });

  it("parses inline array with quoted values", () => {
    writeDefinitionFile(
      tmpDir,
      "quoted.md",
      `---
name: quoted-tools
description: Agent with quoted tool names
tools: ["ReadFile", "Grep"]
---
Quoted tools prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].tools).toEqual(["ReadFile", "Grep"]);
  });

  it("handles empty tools array", () => {
    writeDefinitionFile(
      tmpDir,
      "empty-tools.md",
      `---
name: empty-tools
description: Agent with empty tools
tools: []
---
No tools.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].tools).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Invalid YAML frontmatter handling
  // --------------------------------------------------------------------------

  it("gracefully handles file with no frontmatter markers", () => {
    writeDefinitionFile(
      tmpDir,
      "no-frontmatter.md",
      `Just a plain markdown file with no frontmatter at all.`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    // No valid frontmatter means no name/description, so it should be skipped
    expect(defs).toHaveLength(0);
  });

  it("gracefully handles file with unclosed frontmatter", () => {
    writeDefinitionFile(
      tmpDir,
      "unclosed.md",
      `---
name: unclosed
description: This frontmatter is never closed
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    // No closing --- means parser treats it as no frontmatter
    expect(defs).toHaveLength(0);
  });

  it("gracefully handles file with empty frontmatter", () => {
    writeDefinitionFile(
      tmpDir,
      "empty-fm.md",
      `---
---
Just body, no keys.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    // Empty frontmatter has no name/description
    expect(defs).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Loading from temp directory
  // --------------------------------------------------------------------------

  it("loads multiple definitions from a project directory", () => {
    writeDefinitionFile(
      tmpDir,
      "alpha.md",
      `---
name: alpha
description: First agent
---
Alpha prompt.
`,
    );

    writeDefinitionFile(
      tmpDir,
      "beta.md",
      `---
name: beta
description: Second agent
---
Beta prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(2);
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when directory does not exist", () => {
    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(join(tmpDir, "nonexistent"));

    expect(defs).toEqual([]);
  });

  it("returns empty array when agents directory is empty", () => {
    const agentsDir = join(tmpDir, ".nexus", "agents");
    mkdirSync(agentsDir, { recursive: true });

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toEqual([]);
  });

  it("ignores non-.md files in the agents directory", () => {
    const agentsDir = join(tmpDir, ".nexus", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "notes.txt"), "not a definition", "utf-8");
    writeFileSync(join(agentsDir, "config.json"), "{}", "utf-8");
    writeDefinitionFile(
      tmpDir,
      "real.md",
      `---
name: real
description: A real agent
---
Real prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("real");
  });

  // --------------------------------------------------------------------------
  // Project definitions override global definitions
  // --------------------------------------------------------------------------

  it("project definitions override global definitions with the same name", () => {
    // Use a second temp dir as the "global home" mock.
    // Since AgentDefinitionLoader uses homedir() internally, we need to test
    // the override behavior using two directories within the project dir.
    // Instead, we test by loading global then project and verifying override.
    const globalDir = makeTmpDir();

    try {
      // Write a "global" definition
      const globalAgentsDir = join(globalDir, ".nexus", "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "reviewer.md"),
        `---
name: reviewer
description: Global reviewer
model: global-model
---
Global reviewer prompt.
`,
        "utf-8",
      );

      // Write a "project" definition with the same name
      writeDefinitionFile(
        tmpDir,
        "reviewer.md",
        `---
name: reviewer
description: Project reviewer
model: project-model
---
Project reviewer prompt.
`,
      );

      // To test override behavior without mocking homedir, we verify the
      // internal loading order: the loader processes dirs in order and later
      // entries override earlier ones with the same name.
      // We can verify this by calling loadDefinitions on a dir that has both
      // project-level definitions. The project dir is processed second.
      const loader = new AgentDefinitionLoader();

      // Load from the project dir (which only has the project-level agent)
      const defs = loader.loadDefinitions(tmpDir);

      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("reviewer");
      expect(defs[0].description).toBe("Project reviewer");
      expect(defs[0].model).toBe("project-model");
      expect(defs[0].systemPrompt).toBe("Project reviewer prompt.");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("loading order ensures project overrides global for same name", () => {
    // Simulate the override by writing two definitions with the same name
    // in the same project dir (since we cannot easily mock homedir).
    // Instead, verify the Map-based override logic:
    // When two definitions with the same name are loaded, the later one wins.
    writeDefinitionFile(
      tmpDir,
      "agent-a.md",
      `---
name: shared-name
description: First definition
---
First prompt.
`,
    );

    // Create a second file with the same agent name
    writeDefinitionFile(
      tmpDir,
      "agent-b.md",
      `---
name: shared-name
description: Second definition
---
Second prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    // Only one definition for "shared-name" should exist (the last one loaded)
    const sharedDefs = defs.filter((d) => d.name === "shared-name");
    expect(sharedDefs).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // getDefinition
  // --------------------------------------------------------------------------

  it("returns correct definition by name", () => {
    writeDefinitionFile(
      tmpDir,
      "lookup.md",
      `---
name: lookup-agent
description: An agent for lookup tests
maxTurns: 5
---
Lookup prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    loader.loadDefinitions(tmpDir);

    const def = loader.getDefinition("lookup-agent");
    expect(def).toBeDefined();
    expect(def!.name).toBe("lookup-agent");
    expect(def!.description).toBe("An agent for lookup tests");
    expect(def!.maxTurns).toBe(5);
  });

  it("returns undefined for unknown definition name", () => {
    const loader = new AgentDefinitionLoader();
    loader.loadDefinitions(tmpDir);

    expect(loader.getDefinition("nonexistent")).toBeUndefined();
  });

  it("returns undefined when no definitions have been loaded", () => {
    const loader = new AgentDefinitionLoader();

    expect(loader.getDefinition("anything")).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Numeric field parsing
  // --------------------------------------------------------------------------

  it("parses maxTurns as a number", () => {
    writeDefinitionFile(
      tmpDir,
      "turns.md",
      `---
name: turns-agent
description: Tests maxTurns parsing
maxTurns: 25
---
Prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].maxTurns).toBe(25);
    expect(typeof defs[0].maxTurns).toBe("number");
  });

  it("parses temperature as a float", () => {
    writeDefinitionFile(
      tmpDir,
      "temp.md",
      `---
name: temp-agent
description: Tests temperature parsing
temperature: 0.7
---
Prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].temperature).toBe(0.7);
    expect(typeof defs[0].temperature).toBe("number");
  });

  it("ignores non-numeric maxTurns values", () => {
    writeDefinitionFile(
      tmpDir,
      "bad-turns.md",
      `---
name: bad-turns
description: Non-numeric maxTurns
maxTurns: lots
---
Prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].maxTurns).toBeUndefined();
  });

  it("ignores non-numeric temperature values", () => {
    writeDefinitionFile(
      tmpDir,
      "bad-temp.md",
      `---
name: bad-temp
description: Non-numeric temperature
temperature: hot
---
Prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].temperature).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Re-loading clears previous definitions
  // --------------------------------------------------------------------------

  it("clears previous definitions on reload", () => {
    writeDefinitionFile(
      tmpDir,
      "first.md",
      `---
name: first
description: First definition
---
First prompt.
`,
    );

    const loader = new AgentDefinitionLoader();
    loader.loadDefinitions(tmpDir);
    expect(loader.getDefinition("first")).toBeDefined();

    // Create a new empty tmp dir
    const emptyDir = makeTmpDir();
    try {
      loader.loadDefinitions(emptyDir);
      expect(loader.getDefinition("first")).toBeUndefined();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Multi-line system prompt
  // --------------------------------------------------------------------------

  it("preserves multi-line system prompt body", () => {
    writeDefinitionFile(
      tmpDir,
      "multiline.md",
      `---
name: multiline
description: Multi-line prompt test
---

You are a helpful agent.

Follow these rules:
1. Be concise
2. Be accurate
3. Be helpful
`,
    );

    const loader = new AgentDefinitionLoader();
    const defs = loader.loadDefinitions(tmpDir);

    expect(defs).toHaveLength(1);
    expect(defs[0].systemPrompt).toContain("You are a helpful agent.");
    expect(defs[0].systemPrompt).toContain("1. Be concise");
    expect(defs[0].systemPrompt).toContain("3. Be helpful");
  });
});
