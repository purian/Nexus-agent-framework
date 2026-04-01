#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config/index.js";
import { NexusEngine } from "../core/engine.js";
import { startRepl } from "./repl.js";
import type {
  LLMProvider,
  NexusConfig,
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
} from "../types/index.js";

// ============================================================================
// Version & Program Setup
// ============================================================================

const VERSION = "0.6.0";

const program = new Command()
  .name("nexus")
  .description("Nexus Agent Framework — secure, composable, multi-agent AI")
  .version(VERSION);

// ============================================================================
// Global Options
// ============================================================================

program
  .option("--model <model>", "LLM model to use")
  .option("--provider <provider>", "LLM provider (anthropic, openai)")
  .option("--api-key <key>", "API key for the provider")
  .option(
    "--permission-mode <mode>",
    "Permission mode: default, allowAll, denyAll, plan",
  )
  .option("--max-budget <usd>", "Max budget in USD for the session", parseFloat);

// ============================================================================
// Helpers: Build runtime objects from config
// ============================================================================

/**
 * Build a NexusConfig from the merged CLI options and file/env sources.
 */
function buildConfig(opts: Record<string, unknown>): NexusConfig {
  const overrides: Partial<NexusConfig> = {};

  if (opts.model) overrides.defaultModel = opts.model as string;
  if (opts.provider) overrides.defaultProvider = opts.provider as string;
  if (opts.permissionMode)
    overrides.permissionMode = opts.permissionMode as PermissionMode;
  if (opts.maxBudget !== undefined)
    overrides.maxBudgetUsd = opts.maxBudget as number;

  const config = loadConfig(overrides);

  // If --api-key was provided, stash it in the env so providers can find it
  if (opts.apiKey) {
    const key = opts.apiKey as string;
    if (config.defaultProvider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = key;
    } else if (config.defaultProvider === "openai") {
      process.env.OPENAI_API_KEY = key;
    }
  }

  return config;
}

/**
 * Create an LLM provider based on the config. Currently supports Anthropic
 * as the default; other providers can be added here.
 */
async function createProvider(config: NexusConfig): Promise<LLMProvider> {
  if (config.defaultProvider === "anthropic") {
    try {
      const { AnthropicProvider } = await import("../core/providers/anthropic.js");
      return new AnthropicProvider();
    } catch (err) {
      return stubProvider(config.defaultProvider, err);
    }
  }

  if (config.defaultProvider === "openai") {
    try {
      const { OpenAIProvider } = await import("../core/providers/openai.js");
      return new OpenAIProvider();
    } catch (err) {
      return stubProvider(config.defaultProvider, err);
    }
  }

  if (config.defaultProvider === "ollama") {
    try {
      const { OllamaProvider } = await import("../core/providers/ollama.js");
      return new OllamaProvider();
    } catch (err) {
      return stubProvider(config.defaultProvider, err);
    }
  }

  if (config.defaultProvider === "gemini") {
    try {
      const { GeminiProvider } = await import("../core/providers/gemini.js");
      return new GeminiProvider();
    } catch (err) {
      return stubProvider(config.defaultProvider, err);
    }
  }

  if (config.defaultProvider === "bedrock") {
    try {
      const { BedrockProvider } = await import("../core/providers/bedrock.js");
      return new BedrockProvider();
    } catch (err) {
      return stubProvider(config.defaultProvider, err);
    }
  }

  return stubProvider(config.defaultProvider);
}

function stubProvider(name: string, cause?: unknown): LLMProvider {
  return {
    name,
    async *chat() {
      yield {
        type: "error" as const,
        error: new Error(
          `Provider "${name}" failed to load: ${cause instanceof Error ? cause.message : "not implemented"}.`,
        ),
      };
    },
  };
}

/**
 * Build a PermissionContext from the config's permission mode and rules.
 */
function buildPermissions(config: NexusConfig): PermissionContext {
  const rules: PermissionRule[] = [...config.permissionRules];

  const checkPermission = (
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision => {
    // Fast-path for global modes
    if (config.permissionMode === "allowAll") {
      return { behavior: "allow" };
    }
    if (config.permissionMode === "denyAll") {
      return { behavior: "deny", reason: "All actions denied (denyAll mode)" };
    }
    if (config.permissionMode === "plan") {
      // In plan mode, only read-only tools are auto-allowed
      return { behavior: "ask", message: `Allow ${toolName}?` };
    }

    // Check explicit rules (most-specific first: later rules override earlier)
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      if (rule.toolName !== toolName && rule.toolName !== "*") continue;

      // Pattern matching for tool-specific rules (e.g., Bash with "git *")
      if (rule.pattern) {
        const inputStr = typeof input.command === "string" ? input.command : "";
        if (!matchesPattern(inputStr, rule.pattern)) continue;
      }

      if (rule.behavior === "allow") return { behavior: "allow" };
      if (rule.behavior === "deny")
        return { behavior: "deny", reason: `Denied by rule for ${toolName}` };
      // "ask" falls through to the default below
    }

    // Default mode: ask the user
    return {
      behavior: "ask",
      message: `Allow ${toolName}?`,
    };
  };

  return {
    mode: config.permissionMode,
    rules,
    checkPermission,
    addRule(rule: PermissionRule) {
      rules.push(rule);
    },
    removeRule(toolName: string, pattern?: string) {
      const idx = rules.findIndex(
        (r) => r.toolName === toolName && r.pattern === pattern,
      );
      if (idx !== -1) rules.splice(idx, 1);
    },
  };
}

/**
 * Simple glob-style pattern matching for permission rules.
 * Supports * as a wildcard.
 */
function matchesPattern(input: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(input);
}

/**
 * Create the NexusEngine, wired up with provider, config, and permissions.
 * Also attempts to load and register built-in tools.
 */
async function createEngine(config: NexusConfig): Promise<NexusEngine> {
  const provider = await createProvider(config);
  const permissions = buildPermissions(config);
  const engine = new NexusEngine(provider, config, permissions);

  // Load built-in tools
  try {
    const { createDefaultTools } = await import("../tools/index.js");
    for (const tool of createDefaultTools()) {
      engine.registerTool(tool);
    }
  } catch {
    // Tools module may not exist yet; that's fine
  }

  return engine;
}

// ============================================================================
// Command: default (interactive REPL)
// ============================================================================

program
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const config = buildConfig(opts);
    const engine = await createEngine(config);
    await startRepl(engine);
  });

// ============================================================================
// Command: run <prompt>
// ============================================================================

program
  .command("run <prompt>")
  .description("Run a single prompt and exit")
  .action(async (prompt: string, _opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const config = buildConfig(opts);
    const engine = await createEngine(config);

    // Wire up permission handler for single-shot (auto-deny by default)
    engine.on("event", (event) => {
      if (event.type === "permission_request") {
        // In single-shot mode, auto-allow if permissionMode is allowAll,
        // otherwise deny to avoid blocking on stdin
        if (config.permissionMode === "allowAll") {
          event.resolve({ behavior: "allow" });
        } else {
          event.resolve({
            behavior: "deny",
            reason: "Non-interactive mode; use --permission-mode allowAll to auto-approve",
          });
        }
      }
    });

    try {
      const stream = engine.run(prompt);
      for await (const event of stream) {
        switch (event.type) {
          case "text":
            process.stdout.write(event.text);
            break;
          case "thinking":
            // Suppress thinking in single-shot output
            break;
          case "tool_start":
            process.stderr.write(
              chalk.blue(`[Tool: ${event.toolName}]`) + "\n",
            );
            break;
          case "tool_end":
            if (event.isError) {
              process.stderr.write(chalk.red(`  Error: ${event.result}`) + "\n");
            }
            break;
          case "error":
            process.stderr.write(chalk.red(`Error: ${event.error.message}`) + "\n");
            break;
          case "done":
            process.stderr.write(
              chalk.dim(
                `\ntokens: ${event.totalUsage.inputTokens} in / ${event.totalUsage.outputTokens} out`,
              ) + "\n",
            );
            break;
        }
      }
    } catch (err) {
      process.stderr.write(
        chalk.red(
          "Fatal: " + (err instanceof Error ? err.message : String(err)),
        ) + "\n",
      );
      process.exit(1);
    }
  });

// ============================================================================
// Command: serve
// ============================================================================

program
  .command("serve")
  .description("Start Nexus as an MCP server")
  .option("--port <port>", "HTTP port for SSE transport", parseInt)
  .action(async (cmdOpts, cmd) => {
    const opts = { ...cmd.optsWithGlobals(), ...cmdOpts };
    const config = buildConfig(opts);

    process.stderr.write(
      chalk.bold("Nexus MCP Server") +
        chalk.dim(` v${VERSION}`) +
        "\n",
    );

    try {
      const mcpMod: any = await import("../mcp/index.js");
      if (typeof mcpMod.startServer === "function") {
        await mcpMod.startServer(config, { port: opts.port });
      } else {
        process.stderr.write(
          chalk.yellow(
            "MCP server module found but startServer() is not exported.\n",
          ),
        );
        process.exit(1);
      }
    } catch {
      process.stderr.write(
        chalk.yellow(
          "MCP server not yet implemented. Create src/mcp/index.ts and export startServer().\n",
        ),
      );
      process.exit(1);
    }
  });

// ============================================================================
// Command: config
// ============================================================================

program
  .command("config")
  .description("Show current configuration")
  .option("--json", "Output as JSON")
  .action((cmdOpts, cmd) => {
    const opts = { ...cmd.optsWithGlobals(), ...cmdOpts };
    const config = buildConfig(opts);

    if (opts.json) {
      process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    } else {
      process.stdout.write(chalk.bold("Nexus Configuration\n"));
      process.stdout.write(chalk.dim("─".repeat(40)) + "\n");
      process.stdout.write(`  Model:           ${config.defaultModel}\n`);
      process.stdout.write(`  Provider:        ${config.defaultProvider}\n`);
      process.stdout.write(`  Data dir:        ${config.dataDirectory}\n`);
      process.stdout.write(`  Working dir:     ${config.workingDirectory}\n`);
      process.stdout.write(`  Permission mode: ${config.permissionMode}\n`);
      process.stdout.write(`  Max budget:      ${config.maxBudgetUsd ?? "unlimited"}\n`);
      process.stdout.write(`  Max concurrent:  ${config.maxConcurrentTools}\n`);
      process.stdout.write(`  Thinking:        ${config.thinking.enabled ? "enabled" : "disabled"}\n`);
      process.stdout.write(`  MCP servers:     ${config.mcpServers.length}\n`);
      process.stdout.write(`  Plugins:         ${config.plugins.length}\n`);

      if (config.permissionRules.length > 0) {
        process.stdout.write(chalk.dim("─".repeat(40)) + "\n");
        process.stdout.write(chalk.bold("Permission rules:\n"));
        for (const rule of config.permissionRules) {
          process.stdout.write(
            `  ${rule.behavior.padEnd(6)} ${rule.toolName}` +
              (rule.pattern ? ` (${rule.pattern})` : "") +
              chalk.dim(` [${rule.source}]`) +
              "\n",
          );
        }
      }
    }
  });

// ============================================================================
// Parse & Run
// ============================================================================

program.parse();
