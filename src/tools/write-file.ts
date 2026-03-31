import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type {
  Tool,
  ToolContext,
  ToolResult,
  PermissionDecision,
} from "../types/index.js";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to write the file to"),
  content: z.string().describe("The full content to write to the file"),
});

type WriteFileInput = z.infer<typeof inputSchema>;

interface WriteFileOutput {
  path: string;
  bytesWritten: number;
}

export const writeFileTool: Tool<WriteFileInput, WriteFileOutput> = {
  name: "write_file",
  description:
    "Write content to a file, creating it if it doesn't exist. " +
    "Parent directories are created automatically. " +
    "This overwrites the entire file. For partial edits, use the edit_file tool instead.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return false;
  },

  isReadOnly(): boolean {
    return false;
  },

  async checkPermissions(
    input: WriteFileInput,
    context: ToolContext,
  ): Promise<PermissionDecision> {
    if (context.permissions.mode === "allowAll") {
      return { behavior: "allow" };
    }

    const decision = context.permissions.checkPermission("write_file", {
      path: input.path,
    });

    if (decision.behavior !== "ask") {
      return decision;
    }

    return {
      behavior: "ask",
      message: `Allow writing to ${input.path}?`,
    };
  },

  async execute(
    input: WriteFileInput,
    context: ToolContext,
  ): Promise<ToolResult<WriteFileOutput>> {
    const filePath = resolve(context.workingDirectory, input.path);

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, "utf-8");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error writing file";
      throw new Error(`Failed to write ${filePath}: ${message}`);
    }

    return {
      data: {
        path: filePath,
        bytesWritten: Buffer.byteLength(input.content, "utf-8"),
      },
    };
  },

  renderToolUse(input: Partial<WriteFileInput>): string {
    return `Write ${input.path ?? ""}`;
  },

  renderResult(output: WriteFileOutput): string {
    return `Wrote ${output.bytesWritten} bytes to ${output.path}`;
  },
};
