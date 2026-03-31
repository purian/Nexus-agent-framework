import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types/index.js";
import type { SkillLoader } from "./loader.js";
import { substituteArgs } from "./loader.js";

// ============================================================================
// Input Schema
// ============================================================================

const skillInputSchema = z.object({
  name: z.string().describe("The name of the skill to execute"),
  args: z
    .array(z.string())
    .optional()
    .describe("Optional arguments to substitute into the skill prompt template"),
});

type SkillInput = z.infer<typeof skillInputSchema>;

// ============================================================================
// Skill Tool Factory
// ============================================================================

/**
 * Creates a Tool that looks up and expands a skill prompt template.
 *
 * The `engineFactory` parameter is reserved for future use (e.g., spawning a
 * sub-engine to execute the skill). For now the tool simply returns the
 * expanded prompt as its result, letting the caller decide how to use it.
 */
export function createSkillTool(
  loader: SkillLoader,
  _engineFactory?: unknown,
): Tool<SkillInput, string> {
  return {
    name: "skill",
    description:
      "Execute a reusable skill workflow. Use this to run predefined tasks.",
    inputSchema: skillInputSchema,

    isConcurrencySafe(_input: SkillInput): boolean {
      return true;
    },

    isReadOnly(_input: SkillInput): boolean {
      return true;
    },

    renderToolUse(input: Partial<SkillInput>): string {
      return `skill: ${input.name ?? "unknown"}`;
    },

    async execute(
      input: SkillInput,
      _context: ToolContext,
    ): Promise<ToolResult<string>> {
      const skill = loader.getSkill(input.name);
      if (!skill) {
        throw new Error(
          `Unknown skill "${input.name}". No skill with that name has been loaded.`,
        );
      }

      const args = input.args ?? [];
      const expandedPrompt = substituteArgs(skill.promptTemplate, args);

      return { data: expandedPrompt };
    },
  };
}
