import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";

const inputSchema = z.object({
  pattern: z.string().describe("Regex pattern to search for in file contents"),
  path: z
    .string()
    .optional()
    .describe("File or directory to search in (defaults to working directory)"),
  include: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.ts", "*.py")'),
});

type GrepInput = z.infer<typeof inputSchema>;

interface GrepOutput {
  matches: string;
  matchCount: number;
}

/**
 * Try to use ripgrep (rg) first, fall back to grep.
 */
function buildCommand(
  input: GrepInput,
  searchPath: string,
): { cmd: string; args: string[] } {
  // Prefer ripgrep if available
  const args: string[] = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-count=500",
  ];

  if (input.include) {
    args.push("--glob", input.include);
  }

  args.push("--", input.pattern, searchPath);

  return { cmd: "rg", args };
}

function buildGrepFallback(
  input: GrepInput,
  searchPath: string,
): { cmd: string; args: string[] } {
  const args: string[] = ["-r", "-n", "--color=never", "-E"];

  if (input.include) {
    args.push("--include", input.include);
  }

  args.push("--", input.pattern, searchPath);

  return { cmd: "grep", args };
}

export const grepTool: Tool<GrepInput, GrepOutput> = {
  name: "grep",
  description:
    "Search file contents using regex patterns. Returns matching lines with " +
    "file paths and line numbers. Uses ripgrep (rg) when available, falling " +
    "back to grep. Use this to find code references, function definitions, " +
    "string occurrences, and patterns across a codebase.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return true;
  },

  isReadOnly(): boolean {
    return true;
  },

  async execute(
    input: GrepInput,
    context: ToolContext,
  ): Promise<ToolResult<GrepOutput>> {
    const searchPath = input.path
      ? resolve(context.workingDirectory, input.path)
      : context.workingDirectory;

    const runSearch = (
      cmd: string,
      args: string[],
    ): Promise<{ stdout: string; exitCode: number | null }> => {
      return new Promise((res) => {
        const proc = spawn(cmd, args, {
          cwd: context.workingDirectory,
          signal: context.abortSignal,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        proc.on("close", (exitCode) => {
          res({ stdout, exitCode });
        });

        proc.on("error", () => {
          res({ stdout: "", exitCode: 127 });
        });
      });
    };

    // Try ripgrep first
    const { cmd, args } = buildCommand(input, searchPath);
    let result = await runSearch(cmd, args);

    // Fallback to grep if rg not found
    if (result.exitCode === 127) {
      const fallback = buildGrepFallback(input, searchPath);
      result = await runSearch(fallback.cmd, fallback.args);
    }

    const lines = result.stdout.trim();
    const matchCount = lines ? lines.split("\n").length : 0;

    return {
      data: {
        matches: lines,
        matchCount,
      },
    };
  },

  renderToolUse(input: Partial<GrepInput>): string {
    let s = `Grep for "${input.pattern ?? ""}"`;
    if (input.path) s += ` in ${input.path}`;
    if (input.include) s += ` (${input.include})`;
    return s;
  },

  renderResult(output: GrepOutput): string {
    if (output.matchCount === 0) return "No matches found";
    return `${output.matchCount} match${output.matchCount === 1 ? "" : "es"}:\n${output.matches}`;
  },

  maxResultSize: 100_000,
};
