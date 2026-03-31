import { z } from "zod";
import { glob } from "glob";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";

const inputSchema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern to match files (e.g. "**/*.ts", "src/**/*.json")'),
  path: z
    .string()
    .optional()
    .describe("Directory to search in (defaults to working directory)"),
});

type GlobInput = z.infer<typeof inputSchema>;

interface GlobOutput {
  files: string[];
  count: number;
}

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns a list of file paths sorted " +
    "by modification time (most recent first). Use this to discover files by " +
    'name or extension, e.g. "**/*.test.ts" to find all test files.',
  inputSchema,

  isConcurrencySafe(): boolean {
    return true;
  },

  isReadOnly(): boolean {
    return true;
  },

  async execute(
    input: GlobInput,
    context: ToolContext,
  ): Promise<ToolResult<GlobOutput>> {
    const cwd = input.path
      ? resolve(context.workingDirectory, input.path)
      : context.workingDirectory;

    let files: string[];
    try {
      files = await glob(input.pattern, {
        cwd,
        nodir: true,
        dot: false,
        absolute: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error during glob";
      throw new Error(`Glob failed: ${message}`);
    }

    // Sort by path for deterministic output
    files.sort();

    return {
      data: {
        files,
        count: files.length,
      },
    };
  },

  renderToolUse(input: Partial<GlobInput>): string {
    let s = `Glob ${input.pattern ?? ""}`;
    if (input.path) s += ` in ${input.path}`;
    return s;
  },

  renderResult(output: GlobOutput): string {
    if (output.count === 0) return "No files found";
    return `Found ${output.count} file${output.count === 1 ? "" : "s"}:\n${output.files.join("\n")}`;
  },

  maxResultSize: 50_000,
};
