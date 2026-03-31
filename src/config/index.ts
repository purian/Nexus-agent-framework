import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { NexusConfig, PermissionMode } from "../types/index.js";

// ============================================================================
// Config Schema (Zod)
// ============================================================================

const permissionModeSchema = z.enum(["default", "allowAll", "denyAll", "plan"]);

const thinkingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  budgetTokens: z.number().optional(),
});

const mcpServerConfigSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
});

const permissionRuleSchema = z.object({
  toolName: z.string(),
  pattern: z.string().optional(),
  behavior: z.enum(["allow", "deny", "ask"]),
  source: z.enum(["user", "project", "session", "cli"]),
});

const nexusConfigSchema = z.object({
  defaultModel: z.string().default("claude-sonnet-4-6"),
  defaultProvider: z.string().default("anthropic"),
  workingDirectory: z.string().default(process.cwd()),
  dataDirectory: z.string().default(join(homedir(), ".nexus")),
  permissionMode: permissionModeSchema.default("default"),
  permissionRules: z.array(permissionRuleSchema).default([]),
  mcpServers: z.array(mcpServerConfigSchema).default([]),
  platforms: z.record(z.record(z.unknown())).default({}),
  plugins: z.array(z.string()).default([]),
  maxBudgetUsd: z.number().optional(),
  maxConcurrentTools: z.number().default(4),
  thinking: thinkingConfigSchema.default({ enabled: false }),
});

/** Partial schema used for file/env sources that merge into the full config. */
type PartialNexusConfigInput = z.input<typeof nexusConfigSchema>;

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: NexusConfig = {
  defaultModel: "claude-sonnet-4-6",
  defaultProvider: "anthropic",
  workingDirectory: process.cwd(),
  dataDirectory: join(homedir(), ".nexus"),
  permissionMode: "default",
  permissionRules: [],
  mcpServers: [],
  platforms: {},
  plugins: [],
  maxConcurrentTools: 4,
  thinking: { enabled: false },
};

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Read and parse a JSON config file. Returns an empty object if the file
 * does not exist or cannot be parsed.
 */
function readJsonFile(path: string): Partial<PartialNexusConfigInput> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<PartialNexusConfigInput>;
  } catch {
    return {};
  }
}

/**
 * Extract config values from environment variables.
 *
 *   NEXUS_MODEL          -> defaultModel
 *   NEXUS_PROVIDER       -> defaultProvider
 *   NEXUS_DATA_DIR       -> dataDirectory
 *   NEXUS_PERMISSION_MODE -> permissionMode
 *   NEXUS_MAX_BUDGET     -> maxBudgetUsd
 *   NEXUS_MAX_CONCURRENT -> maxConcurrentTools
 *   NEXUS_THINKING       -> thinking.enabled
 *
 * API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY) are NOT stored in the config
 * object -- they are read directly by the provider implementations.
 */
function configFromEnv(): Partial<PartialNexusConfigInput> {
  const env: Partial<PartialNexusConfigInput> = {};

  if (process.env.NEXUS_MODEL) {
    env.defaultModel = process.env.NEXUS_MODEL;
  }
  if (process.env.NEXUS_PROVIDER) {
    env.defaultProvider = process.env.NEXUS_PROVIDER;
  }
  if (process.env.NEXUS_DATA_DIR) {
    env.dataDirectory = resolve(process.env.NEXUS_DATA_DIR);
  }
  if (process.env.NEXUS_PERMISSION_MODE) {
    const mode = process.env.NEXUS_PERMISSION_MODE as PermissionMode;
    if (["default", "allowAll", "denyAll", "plan"].includes(mode)) {
      env.permissionMode = mode;
    }
  }
  if (process.env.NEXUS_MAX_BUDGET) {
    const n = Number(process.env.NEXUS_MAX_BUDGET);
    if (!Number.isNaN(n)) env.maxBudgetUsd = n;
  }
  if (process.env.NEXUS_MAX_CONCURRENT) {
    const n = Number(process.env.NEXUS_MAX_CONCURRENT);
    if (!Number.isNaN(n)) env.maxConcurrentTools = n;
  }
  if (process.env.NEXUS_THINKING === "true") {
    env.thinking = { enabled: true };
  }

  return env;
}

/**
 * Shallow-merge multiple config sources with later sources taking precedence,
 * then validate through the Zod schema.
 */
function mergeConfigs(
  ...sources: Partial<PartialNexusConfigInput>[]
): NexusConfig {
  const merged: Record<string, unknown> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        // For arrays and objects, later source wins entirely (no deep merge).
        merged[key] = value;
      }
    }
  }

  const result = nexusConfigSchema.parse(merged);
  return result as NexusConfig;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load the Nexus configuration by merging multiple sources in order of
 * increasing precedence:
 *
 *   1. Built-in defaults
 *   2. User config:    ~/.nexus/config.json
 *   3. Project config: .nexus.json (in cwd)
 *   4. Environment variables
 *   5. Programmatic overrides (CLI args)
 *
 * @param overrides - Values from CLI flags or programmatic callers.
 * @returns A fully resolved and validated NexusConfig.
 */
export function loadConfig(
  overrides?: Partial<NexusConfig>,
): NexusConfig {
  const userConfigPath = join(homedir(), ".nexus", "config.json");
  const projectConfigPath = join(process.cwd(), ".nexus.json");

  const userConfig = readJsonFile(userConfigPath);
  const projectConfig = readJsonFile(projectConfigPath);
  const envConfig = configFromEnv();

  return mergeConfigs(
    DEFAULT_CONFIG,
    userConfig,
    projectConfig,
    envConfig,
    (overrides ?? {}) as Partial<PartialNexusConfigInput>,
  );
}
