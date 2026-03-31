import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SkillLoader, substituteArgs } from "./loader.js";
import { createSkillTool } from "./skill-tool.js";
import type { ToolContext, NexusConfig, PermissionContext } from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `nexus-skill-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkillFile(dir: string, filename: string, content: string): void {
  const skillsDir = join(dir, ".nexus", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, filename), content, "utf-8");
}

function makeToolContext(): ToolContext {
  return {
    workingDirectory: "/tmp",
    abortSignal: new AbortController().signal,
    permissions: {
      mode: "allowAll",
      rules: [],
      checkPermission: () => ({ behavior: "allow" as const }),
      addRule: () => {},
      removeRule: () => {},
    } satisfies PermissionContext,
    config: {
      defaultModel: "test",
      defaultProvider: "test",
      workingDirectory: "/tmp",
      dataDirectory: "/tmp",
      permissionMode: "allowAll",
      permissionRules: [],
      mcpServers: [],
      platforms: {},
      plugins: [],
      maxConcurrentTools: 4,
      thinking: { enabled: false },
    } satisfies NexusConfig,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("SkillLoader", () => {
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

  it("parses frontmatter with name, description, tools, and arguments", async () => {
    writeSkillFile(
      tmpDir,
      "review.md",
      `---
name: review
description: Review code changes
tools: [bash, read_file, grep]
arguments: Optional file path to review
---
Review the following code changes and provide feedback.
`,
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("review");
    expect(skills[0].description).toBe("Review code changes");
    expect(skills[0].tools).toEqual(["bash", "read_file", "grep"]);
    expect(skills[0].arguments).toBe("Optional file path to review");
    expect(skills[0].promptTemplate).toBe(
      "Review the following code changes and provide feedback.",
    );
  });

  it("parses block-style array in tools field", async () => {
    writeSkillFile(
      tmpDir,
      "deploy.md",
      `---
name: deploy
description: Deploy to production
tools:
  - bash
  - read_file
---
Run the deploy script.
`,
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].tools).toEqual(["bash", "read_file"]);
  });

  it("parses optional model field", async () => {
    writeSkillFile(
      tmpDir,
      "think.md",
      `---
name: think
description: Deep thinking task
tools: [bash]
model: claude-opus-4-20250514
---
Think deeply about this problem.
`,
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].model).toBe("claude-opus-4-20250514");
  });

  it("skips files without required name or description", async () => {
    writeSkillFile(
      tmpDir,
      "broken.md",
      `---
tools: [bash]
---
No name or description here.
`,
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Argument substitution
  // --------------------------------------------------------------------------

  it("substitutes {{arg0}} and {{arg1}} placeholders", () => {
    const template = "Deploy {{arg0}} to {{arg1}} environment.";
    const result = substituteArgs(template, ["v2.0", "staging"]);
    expect(result).toBe("Deploy v2.0 to staging environment.");
  });

  it("leaves unmatched placeholders intact when args are missing", () => {
    const template = "Deploy {{arg0}} to {{arg1}}.";
    const result = substituteArgs(template, ["v2.0"]);
    expect(result).toBe("Deploy v2.0 to {{arg1}}.");
  });

  it("handles template with no placeholders", () => {
    const template = "Just do the thing.";
    const result = substituteArgs(template, ["unused"]);
    expect(result).toBe("Just do the thing.");
  });

  // --------------------------------------------------------------------------
  // Loading from temp directory
  // --------------------------------------------------------------------------

  it("loads multiple skills from a project directory", async () => {
    writeSkillFile(
      tmpDir,
      "alpha.md",
      `---
name: alpha
description: First skill
tools: [bash]
---
Alpha prompt.
`,
    );

    writeSkillFile(
      tmpDir,
      "beta.md",
      `---
name: beta
description: Second skill
tools: [grep]
---
Beta prompt.
`,
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("ignores non-.md files in the skills directory", async () => {
    const skillsDir = join(tmpDir, ".nexus", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "notes.txt"), "not a skill", "utf-8");
    writeFileSync(
      join(skillsDir, "real.md"),
      `---
name: real
description: A real skill
tools: []
---
Real prompt.
`,
      "utf-8",
    );

    const loader = new SkillLoader();
    const skills = await loader.loadSkills(tmpDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("real");
  });

  // --------------------------------------------------------------------------
  // getSkill
  // --------------------------------------------------------------------------

  it("returns undefined for unknown skill names", async () => {
    const loader = new SkillLoader();
    await loader.loadSkills(tmpDir);

    expect(loader.getSkill("nonexistent")).toBeUndefined();
  });

  it("returns a loaded skill by name", async () => {
    writeSkillFile(
      tmpDir,
      "commit.md",
      `---
name: commit
description: Create a commit
tools: [bash]
---
Create a well-formed commit.
`,
    );

    const loader = new SkillLoader();
    await loader.loadSkills(tmpDir);

    const skill = loader.getSkill("commit");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("commit");
    expect(skill!.description).toBe("Create a commit");
  });
});

// ============================================================================
// Skill Tool
// ============================================================================

describe("createSkillTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a tool with the correct name and description", () => {
    const loader = new SkillLoader();
    const tool = createSkillTool(loader);

    expect(tool.name).toBe("skill");
    expect(tool.description).toContain("reusable skill workflow");
  });

  it("reports isConcurrencySafe and isReadOnly as true", () => {
    const loader = new SkillLoader();
    const tool = createSkillTool(loader);

    expect(tool.isConcurrencySafe({ name: "x" })).toBe(true);
    expect(tool.isReadOnly({ name: "x" })).toBe(true);
  });

  it("renderToolUse shows the skill name", () => {
    const loader = new SkillLoader();
    const tool = createSkillTool(loader);

    expect(tool.renderToolUse!({ name: "deploy" })).toBe("skill: deploy");
  });

  it("executes and returns the expanded prompt", async () => {
    writeSkillFile(
      tmpDir,
      "greet.md",
      `---
name: greet
description: Greet someone
tools: []
---
Hello, {{arg0}}! Welcome to {{arg1}}.
`,
    );

    const loader = new SkillLoader();
    await loader.loadSkills(tmpDir);

    const tool = createSkillTool(loader);
    const context = makeToolContext();

    const result = await tool.execute(
      { name: "greet", args: ["Alice", "Nexus"] },
      context,
    );

    expect(result.data).toBe("Hello, Alice! Welcome to Nexus.");
  });

  it("throws for unknown skill names", async () => {
    const loader = new SkillLoader();
    await loader.loadSkills(tmpDir);

    const tool = createSkillTool(loader);
    const context = makeToolContext();

    await expect(
      tool.execute({ name: "missing" }, context),
    ).rejects.toThrow('Unknown skill "missing"');
  });

  it("works with no args when skill has no placeholders", async () => {
    writeSkillFile(
      tmpDir,
      "simple.md",
      `---
name: simple
description: A simple skill
tools: [bash]
---
Just do the simple thing.
`,
    );

    const loader = new SkillLoader();
    await loader.loadSkills(tmpDir);

    const tool = createSkillTool(loader);
    const context = makeToolContext();

    const result = await tool.execute({ name: "simple" }, context);
    expect(result.data).toBe("Just do the simple thing.");
  });
});
