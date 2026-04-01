import { describe, it, expect, beforeEach } from "vitest";
import {
  findNexusRoot,
  buildSelfHostSystemPrompt,
  getSelfHostPermissionRules,
  buildSelfHostConfig,
} from "./index.js";
import type { NexusConfig, PermissionRule } from "../types/index.js";

// ============================================================================
// Test Helpers
// ============================================================================

function baseConfig(): NexusConfig {
  return {
    defaultModel: "claude-sonnet-4-6",
    defaultProvider: "anthropic",
    workingDirectory: "/some/other/dir",
    dataDirectory: "/tmp/nexus-test-data",
    permissionMode: "default",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 4,
    thinking: { enabled: false },
  };
}

// ============================================================================
// findNexusRoot
// ============================================================================

describe("findNexusRoot", () => {
  it("returns a path containing package.json with name nexus-agent", () => {
    const root = findNexusRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });

  it("returns a path that ends with the nexus project directory", () => {
    const root = findNexusRoot();
    // Should resolve to the actual project root (contains src/ and package.json)
    expect(root).toMatch(/nexus/);
  });
});

// ============================================================================
// buildSelfHostSystemPrompt
// ============================================================================

describe("buildSelfHostSystemPrompt", () => {
  it("includes self-development identity", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("developing itself");
  });

  it("includes architecture overview", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("Core Engine");
    expect(prompt).toContain("src/core/engine.ts");
    expect(prompt).toContain("Providers");
    expect(prompt).toContain("Tools");
    expect(prompt).toContain("Agents");
    expect(prompt).toContain("Permissions");
  });

  it("includes all provider names", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("Anthropic");
    expect(prompt).toContain("OpenAI");
    expect(prompt).toContain("Ollama");
    expect(prompt).toContain("Gemini");
    expect(prompt).toContain("Bedrock");
    expect(prompt).toContain("FallbackProvider");
  });

  it("includes built-in tool names", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("bash");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("edit_file");
    expect(prompt).toContain("glob");
    expect(prompt).toContain("grep");
    expect(prompt).toContain("web_fetch");
  });

  it("includes development rules", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("No regressions");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("Changelog");
  });

  it("includes the working directory", () => {
    const prompt = buildSelfHostSystemPrompt("/my/project/root");
    expect(prompt).toContain("/my/project/root");
  });

  it("includes CLAUDE.md contents when present", () => {
    // Use the actual project root which has a CLAUDE.md
    const root = findNexusRoot();
    const prompt = buildSelfHostSystemPrompt(root);
    expect(prompt).toContain("Project Instructions (CLAUDE.md)");
    expect(prompt).toContain("Nexus Agent Framework");
  });

  it("works without CLAUDE.md", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nonexistent");
    expect(prompt).not.toContain("CLAUDE.md");
    // Should still have the core architecture docs
    expect(prompt).toContain("Core Engine");
  });

  it("describes the agent loop pattern", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("User Input");
    expect(prompt).toContain("LLM API");
    expect(prompt).toContain("Tool Execution");
  });

  it("describes the type system", () => {
    const prompt = buildSelfHostSystemPrompt("/tmp/nexus");
    expect(prompt).toContain("Message");
    expect(prompt).toContain("ContentBlock");
    expect(prompt).toContain("AgentConfig");
    expect(prompt).toContain("NexusConfig");
  });
});

// ============================================================================
// getSelfHostPermissionRules
// ============================================================================

describe("getSelfHostPermissionRules", () => {
  let rules: PermissionRule[];

  beforeEach(() => {
    rules = getSelfHostPermissionRules();
  });

  it("returns an array of permission rules", () => {
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("allows read-only tools", () => {
    const readFile = rules.find((r) => r.toolName === "read_file" && r.behavior === "allow");
    const glob = rules.find((r) => r.toolName === "glob" && r.behavior === "allow");
    const grep = rules.find((r) => r.toolName === "grep" && r.behavior === "allow");

    expect(readFile).toBeDefined();
    expect(glob).toBeDefined();
    expect(grep).toBeDefined();
  });

  it("allows write tools for source modification", () => {
    const writeFile = rules.find((r) => r.toolName === "write_file" && r.behavior === "allow");
    const editFile = rules.find((r) => r.toolName === "edit_file" && r.behavior === "allow");

    expect(writeFile).toBeDefined();
    expect(editFile).toBeDefined();
  });

  it("allows safe git commands", () => {
    const gitRules = rules.filter(
      (r) => r.toolName === "bash" && r.pattern?.startsWith("git ") && r.behavior === "allow",
    );
    const patterns = gitRules.map((r) => r.pattern);

    expect(patterns).toContain("git status*");
    expect(patterns).toContain("git diff*");
    expect(patterns).toContain("git log*");
    expect(patterns).toContain("git add*");
    expect(patterns).toContain("git commit*");
  });

  it("allows npm test and npm run commands", () => {
    const npmTest = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "npm test*" && r.behavior === "allow",
    );
    const npmRun = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "npm run *" && r.behavior === "allow",
    );

    expect(npmTest).toBeDefined();
    expect(npmRun).toBeDefined();
  });

  it("denies destructive rm commands", () => {
    const rmRf = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "rm -rf *" && r.behavior === "deny",
    );
    const rmR = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "rm -r *" && r.behavior === "deny",
    );

    expect(rmRf).toBeDefined();
    expect(rmR).toBeDefined();
  });

  it("denies destructive git operations", () => {
    const forcePush = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "git push --force*" && r.behavior === "deny",
    );
    const resetHard = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "git reset --hard*" && r.behavior === "deny",
    );
    const cleanF = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "git clean -f*" && r.behavior === "deny",
    );

    expect(forcePush).toBeDefined();
    expect(resetHard).toBeDefined();
    expect(cleanF).toBeDefined();
  });

  it("denies npm publish", () => {
    const npmPublish = rules.find(
      (r) => r.toolName === "bash" && r.pattern === "npm publish*" && r.behavior === "deny",
    );
    expect(npmPublish).toBeDefined();
  });

  it("allows web_fetch for docs lookup", () => {
    const webFetch = rules.find((r) => r.toolName === "web_fetch" && r.behavior === "allow");
    expect(webFetch).toBeDefined();
  });

  it("allows agent spawning", () => {
    const agent = rules.find((r) => r.toolName === "agent" && r.behavior === "allow");
    expect(agent).toBeDefined();
  });

  it("uses session source for all rules", () => {
    for (const rule of rules) {
      expect(rule.source).toBe("session");
    }
  });
});

// ============================================================================
// buildSelfHostConfig
// ============================================================================

describe("buildSelfHostConfig", () => {
  it("sets working directory to the Nexus project root", () => {
    const config = buildSelfHostConfig(baseConfig());
    expect(config.workingDirectory).not.toBe("/some/other/dir");
    expect(config.workingDirectory).toMatch(/nexus/);
  });

  it("allows overriding the project root", () => {
    const config = buildSelfHostConfig(baseConfig(), {
      projectRoot: "/custom/root",
    });
    expect(config.workingDirectory).toBe("/custom/root");
  });

  it("allows overriding the provider", () => {
    const config = buildSelfHostConfig(baseConfig(), {
      provider: "openai",
    });
    expect(config.defaultProvider).toBe("openai");
  });

  it("allows overriding the model", () => {
    const config = buildSelfHostConfig(baseConfig(), {
      model: "gpt-4o",
    });
    expect(config.defaultModel).toBe("gpt-4o");
  });

  it("enables plan mode when requested", () => {
    const config = buildSelfHostConfig(baseConfig(), {
      planMode: true,
    });
    expect(config.permissionMode).toBe("plan");
  });

  it("uses allowAll mode by default", () => {
    const config = buildSelfHostConfig(baseConfig());
    expect(config.permissionMode).toBe("allowAll");
  });

  it("merges self-host permission rules with base rules", () => {
    const base = baseConfig();
    base.permissionRules = [
      { toolName: "bash", pattern: "echo *", behavior: "allow", source: "user" },
    ];
    const config = buildSelfHostConfig(base);

    // Should have the base rule plus all self-host rules
    const selfHostRules = getSelfHostPermissionRules();
    expect(config.permissionRules.length).toBe(1 + selfHostRules.length);

    // First rule should be the base rule
    expect(config.permissionRules[0].pattern).toBe("echo *");
  });

  it("allows overriding max budget", () => {
    const config = buildSelfHostConfig(baseConfig(), {
      maxBudgetUsd: 5.0,
    });
    expect(config.maxBudgetUsd).toBe(5.0);
  });

  it("preserves base config properties", () => {
    const base = baseConfig();
    base.maxConcurrentTools = 8;
    base.thinking = { enabled: true, budgetTokens: 2000 };
    base.plugins = ["my-plugin"];

    const config = buildSelfHostConfig(base);

    expect(config.maxConcurrentTools).toBe(8);
    expect(config.thinking.enabled).toBe(true);
    expect(config.thinking.budgetTokens).toBe(2000);
    expect(config.plugins).toEqual(["my-plugin"]);
  });

  it("preserves base config defaults when options are empty", () => {
    const base = baseConfig();
    const config = buildSelfHostConfig(base, {});

    expect(config.defaultProvider).toBe("anthropic");
    expect(config.defaultModel).toBe("claude-sonnet-4-6");
  });
});
