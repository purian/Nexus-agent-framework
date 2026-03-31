import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to read"),
  offset: z
    .number()
    .optional()
    .describe("Line number to start reading from (1-based)"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of lines to read"),
});

type ReadFileInput = z.infer<typeof inputSchema>;

interface ReadFileOutput {
  content: string;
  path: string;
  totalLines: number;
  linesRead: [number, number]; // [start, end] inclusive
}

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the content with line numbers. " +
    "Use offset and limit to read specific line ranges in large files. " +
    "Can read text files, code, configuration, and other text-based formats.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return true;
  },

  isReadOnly(): boolean {
    return true;
  },

  async execute(
    input: ReadFileInput,
    context: ToolContext,
  ): Promise<ToolResult<ReadFileOutput>> {
    const filePath = resolve(context.workingDirectory, input.path);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error reading file";
      throw new Error(`Failed to read ${filePath}: ${message}`);
    }

    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    const start = Math.max(1, input.offset ?? 1);
    const end = input.limit
      ? Math.min(start + input.limit - 1, totalLines)
      : totalLines;

    const selectedLines = allLines.slice(start - 1, end);

    // Format with line numbers
    const maxLineNum = String(end).length;
    const content = selectedLines
      .map((line, i) => {
        const lineNum = String(start + i).padStart(maxLineNum, " ");
        return `${lineNum}\t${line}`;
      })
      .join("\n");

    return {
      data: {
        content,
        path: filePath,
        totalLines,
        linesRead: [start, end],
      },
    };
  },

  renderToolUse(input: Partial<ReadFileInput>): string {
    let s = `Read ${input.path ?? ""}`;
    if (input.offset || input.limit) {
      s += ` (lines ${input.offset ?? 1}`;
      if (input.limit) s += `-${(input.offset ?? 1) + input.limit - 1}`;
      s += ")";
    }
    return s;
  },

  renderResult(output: ReadFileOutput): string {
    return output.content;
  },
};
