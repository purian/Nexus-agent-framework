import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Tool,
  ToolContext,
  ToolResult,
  PermissionDecision,
} from "../types/index.js";

const inputSchema = z.object({
  path: z.string().describe("Absolute or relative path to the file to edit"),
  old_string: z.string().describe("The exact text to find and replace"),
  new_string: z
    .string()
    .describe("The replacement text (must differ from old_string)"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences instead of requiring uniqueness"),
});

type EditFileInput = z.infer<typeof inputSchema>;

interface EditFileOutput {
  path: string;
  replacements: number;
}

export const editFileTool: Tool<EditFileInput, EditFileOutput> = {
  name: "edit_file",
  description:
    "Make a search-and-replace edit to a file. Finds old_string in the file " +
    "and replaces it with new_string. By default, old_string must appear " +
    "exactly once in the file (for safety). Set replace_all to true to " +
    "replace every occurrence. Use this for targeted edits rather than " +
    "rewriting the entire file with write_file.",
  inputSchema,

  isConcurrencySafe(): boolean {
    return false;
  },

  isReadOnly(): boolean {
    return false;
  },

  async checkPermissions(
    input: EditFileInput,
    context: ToolContext,
  ): Promise<PermissionDecision> {
    if (context.permissions.mode === "allowAll") {
      return { behavior: "allow" };
    }

    const decision = context.permissions.checkPermission("edit_file", {
      path: input.path,
    });

    if (decision.behavior !== "ask") {
      return decision;
    }

    return {
      behavior: "ask",
      message: `Allow editing ${input.path}?`,
    };
  },

  async execute(
    input: EditFileInput,
    context: ToolContext,
  ): Promise<ToolResult<EditFileOutput>> {
    const filePath = resolve(context.workingDirectory, input.path);

    if (input.old_string === input.new_string) {
      throw new Error("old_string and new_string must be different");
    }

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error reading file";
      throw new Error(`Failed to read ${filePath}: ${message}`);
    }

    if (!content.includes(input.old_string)) {
      throw new Error(
        `old_string not found in ${filePath}. Make sure the string matches exactly, ` +
          "including whitespace and indentation.",
      );
    }

    if (!input.replace_all) {
      const firstIdx = content.indexOf(input.old_string);
      const secondIdx = content.indexOf(
        input.old_string,
        firstIdx + input.old_string.length,
      );
      if (secondIdx !== -1) {
        throw new Error(
          `old_string appears multiple times in ${filePath}. ` +
            "Provide more context to make the match unique, or set replace_all to true.",
        );
      }
    }

    let replacements = 0;
    let newContent: string;

    if (input.replace_all) {
      newContent = content.split(input.old_string).join(input.new_string);
      // Count how many splits occurred = occurrences
      replacements =
        content.split(input.old_string).length - 1;
    } else {
      newContent = content.replace(input.old_string, input.new_string);
      replacements = 1;
    }

    try {
      await writeFile(filePath, newContent, "utf-8");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error writing file";
      throw new Error(`Failed to write ${filePath}: ${message}`);
    }

    return {
      data: {
        path: filePath,
        replacements,
      },
    };
  },

  renderToolUse(input: Partial<EditFileInput>): string {
    return `Edit ${input.path ?? ""}`;
  },

  renderResult(output: EditFileOutput): string {
    return `Made ${output.replacements} replacement${output.replacements === 1 ? "" : "s"} in ${output.path}`;
  },
};
