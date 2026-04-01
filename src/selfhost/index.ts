import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NexusConfig,
  PermissionRule,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Project Root Detection
// ---------------------------------------------------------------------------

/**
 * Locate the Nexus project root by walking up from this file until we find
 * a package.json with name "nexus-agent". Returns the absolute path.
 */
export function findNexusRoot(): string {
  // Start from the directory containing this source file
  let dir = dirname(fileURLToPath(import.meta.url));

  // Walk up at most 10 levels looking for the project package.json
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "nexus-agent") {
          return dir;
        }
      } catch {
        // Not valid JSON — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback: assume two levels up from src/selfhost/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// ---------------------------------------------------------------------------
// Architecture-Aware System Prompt
// ---------------------------------------------------------------------------

/**
 * Build a system prompt that gives the LLM deep knowledge of Nexus's own
 * architecture, conventions, and development rules.
 *
 * If the project root contains CLAUDE.md, its contents are appended so the
 * agent follows the same dev rules a human contributor would.
 */
export function buildSelfHostSystemPrompt(projectRoot: string): string {
  const parts: string[] = [];

  parts.push(
    "You are Nexus, an AI agent framework that is developing itself.",
    "You are working on your own source code. You understand your own architecture deeply.",
    "",
    "# Your Architecture",
    "",
    "## Core Engine (`src/core/engine.ts`)",
    "- Async generator pattern: `async *run(userMessage)` yields `EngineEvent`",
    "- Agent loop: User Input → LLM API → Tool Execution → Feed Results → Repeat",
    "- Tool concurrency safety: safe tools run in parallel, unsafe tools serialized",
    "- Permission checks before every tool execution",
    "- Context compression when approaching token limits",
    "- Plan mode: intercepts write tools, collects into reviewable plans",
    "",
    "## Providers (`src/core/providers/`)",
    "- Anthropic (Claude), OpenAI (GPT-4o, o1, o3), Ollama (local), Gemini, Bedrock",
    "- FallbackProvider chains multiple providers for automatic failover",
    "- All use native fetch (no SDK dependencies except Bedrock which uses AWS SDK)",
    "- Common interface: `chat(request, signal): AsyncGenerator<LLMEvent>`",
    "",
    "## Tools (`src/tools/`)",
    "- 7 built-in: bash, read_file, write_file, edit_file, glob, grep, web_fetch",
    "- Each tool: Zod input schema, execute(), isConcurrencySafe(), isReadOnly()",
    "- ToolContext provides workingDirectory, abortSignal, permissions, config",
    "",
    "## Agents (`src/agents/`)",
    "- AgentCoordinator manages sub-agent lifecycle (spawn, run, stop, message)",
    "- Each sub-agent gets its own NexusEngine instance with isolated conversation",
    "- Agent tool lets the LLM spawn sub-agents from within prompts",
    "- Inter-agent mailbox system for communication",
    "",
    "## Permissions (`src/permissions/`)",
    "- Modes: default (ask), allowAll, denyAll, plan",
    "- Per-tool rules with glob pattern matching (e.g., `Bash` with pattern `git *`)",
    "- 4-layer priority: CLI > session > project > user",
    "",
    "## Other Modules",
    "- `src/memory/` — SQLite + FTS5 persistent memory",
    "- `src/skills/` — Reusable workflows from .nexus/skills/*.md",
    "- `src/mcp/` — MCP client (consume) and server (expose)",
    "- `src/platforms/` — Telegram, Discord, Slack, Webhook adapters",
    "- `src/plugins/` — Dynamic plugin loading",
    "- `src/config/` — Multi-source config (defaults → user → project → env → CLI)",
    "- `src/cli/` — Commander.js CLI with interactive REPL",
    "",
    "## Type System (`src/types/index.ts`)",
    "- Message, ContentBlock, Tool, LLMProvider, PermissionRule, AgentConfig",
    "- NexusConfig, EngineEvent, MemoryEntry, Plugin, PlatformAdapter",
    "",
    "# Development Rules",
    "",
    "- **No regressions**: All existing tests must continue to pass",
    "- **TypeScript**: Strict mode, Zod validation at all tool boundaries",
    "- **Testing**: vitest, tests in `src/**/*.test.ts`, real filesystem ops in temp dirs",
    "- **Concurrency**: Mark tools as concurrency-safe or unsafe appropriately",
    "- **Permissions**: Never bypass the permission system",
    "- **Exports**: Update `src/index.ts` when adding new public modules",
    "- **Changelog**: Follow Keep a Changelog format in CHANGELOG.md",
    "",
    `# Working Directory: ${projectRoot}`,
  );

  // Append CLAUDE.md if it exists
  const claudeMdPath = join(projectRoot, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      const claudeMd = readFileSync(claudeMdPath, "utf-8").trim();
      parts.push(
        "",
        "# Project Instructions (CLAUDE.md)",
        claudeMd,
      );
    } catch {
      // Ignore read errors
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Self-Development Permission Rules
// ---------------------------------------------------------------------------

/**
 * Returns permission rules that are safe for self-development:
 * - Allow: git, npm test, npm run build, npm run typecheck, read/write src files
 * - Deny: rm -rf, destructive git operations, npm publish
 * - Ask: everything else
 */
export function getSelfHostPermissionRules(): PermissionRule[] {
  return [
    // Allow safe read operations
    { toolName: "read_file", behavior: "allow", source: "session" },
    { toolName: "glob", behavior: "allow", source: "session" },
    { toolName: "grep", behavior: "allow", source: "session" },

    // Allow safe write operations (source files only)
    { toolName: "write_file", behavior: "allow", source: "session" },
    { toolName: "edit_file", behavior: "allow", source: "session" },

    // Allow safe bash commands
    { toolName: "bash", pattern: "git status*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git diff*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git log*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git add*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git commit*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git branch*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git checkout*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "git stash*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "npm test*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "npm run *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "npx vitest*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "npx tsc*", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "cat *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "ls *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "ls", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "wc *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "head *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "tail *", behavior: "allow", source: "session" },
    { toolName: "bash", pattern: "mkdir *", behavior: "allow", source: "session" },

    // Deny destructive operations
    { toolName: "bash", pattern: "rm -rf *", behavior: "deny", source: "session" },
    { toolName: "bash", pattern: "rm -r *", behavior: "deny", source: "session" },
    { toolName: "bash", pattern: "git push --force*", behavior: "deny", source: "session" },
    { toolName: "bash", pattern: "git reset --hard*", behavior: "deny", source: "session" },
    { toolName: "bash", pattern: "git clean -f*", behavior: "deny", source: "session" },
    { toolName: "bash", pattern: "npm publish*", behavior: "deny", source: "session" },

    // Allow web_fetch for looking up docs
    { toolName: "web_fetch", behavior: "allow", source: "session" },

    // Allow spawning sub-agents
    { toolName: "agent", behavior: "allow", source: "session" },
  ];
}

// ---------------------------------------------------------------------------
// Self-Host Config Builder
// ---------------------------------------------------------------------------

export interface SelfHostOptions {
  /** Override the project root (defaults to auto-detected Nexus root) */
  projectRoot?: string;
  /** LLM provider to use (default: from config) */
  provider?: string;
  /** LLM model to use (default: from config) */
  model?: string;
  /** Enable plan mode for safer self-modification */
  planMode?: boolean;
  /** Max budget in USD */
  maxBudgetUsd?: number;
}

/**
 * Build a NexusConfig tailored for self-development. Merges the base config
 * with self-hosting overrides: working directory set to Nexus root,
 * dev-safe permission rules, and optional plan mode.
 */
export function buildSelfHostConfig(
  baseConfig: NexusConfig,
  options: SelfHostOptions = {},
): NexusConfig {
  const projectRoot = options.projectRoot ?? findNexusRoot();

  return {
    ...baseConfig,
    workingDirectory: projectRoot,
    defaultProvider: options.provider ?? baseConfig.defaultProvider,
    defaultModel: options.model ?? baseConfig.defaultModel,
    permissionMode: options.planMode ? "plan" : "allowAll",
    permissionRules: [
      ...baseConfig.permissionRules,
      ...getSelfHostPermissionRules(),
    ],
    maxBudgetUsd: options.maxBudgetUsd ?? baseConfig.maxBudgetUsd,
  };
}
