import { z } from "zod";

import type {
  MemoryEntry,
  MemoryType,
  Tool,
  ToolContext,
  ToolResult,
} from "../types/index.js";
import type { MemoryManager } from "./index.js";

// ============================================================================
// Input schema
// ============================================================================

const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);

const saveAction = z.object({
  action: z.literal("save"),
  type: memoryTypeSchema,
  name: z.string().describe("Short, descriptive name for this memory"),
  description: z.string().describe("Brief explanation of what this memory contains and when it is useful"),
  content: z.string().describe("The full content of the memory"),
  tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
});

const searchAction = z.object({
  action: z.literal("search"),
  query: z.string().describe("Full-text search query"),
  type: memoryTypeSchema.optional().describe("Optionally filter results by memory type"),
});

const listAction = z.object({
  action: z.literal("list"),
  type: memoryTypeSchema.optional().describe("Optionally filter results by memory type"),
});

const deleteAction = z.object({
  action: z.literal("delete"),
  id: z.string().describe("ID of the memory entry to delete"),
});

const memoryInputSchema = z.discriminatedUnion("action", [
  saveAction,
  searchAction,
  listAction,
  deleteAction,
]);

type MemoryInput = z.infer<typeof memoryInputSchema>;

// ============================================================================
// Tool output types
// ============================================================================

interface SaveOutput {
  saved: MemoryEntry;
}

interface SearchOutput {
  results: MemoryEntry[];
  count: number;
}

interface ListOutput {
  entries: MemoryEntry[];
  count: number;
}

interface DeleteOutput {
  deleted: string;
}

type MemoryOutput = SaveOutput | SearchOutput | ListOutput | DeleteOutput;

// ============================================================================
// MemoryTool
// ============================================================================

/**
 * Create a MemoryTool instance backed by the given MemoryManager.
 *
 * Provides the LLM with the ability to persist and retrieve memories across
 * sessions. Uses a subcommand-style interface so a single tool registration
 * covers all memory operations.
 */
export function createMemoryTool(memory: MemoryManager): Tool<Record<string, unknown>, MemoryOutput> {
  return {
    name: "memory",

    description: [
      "Manage persistent memories that survive across conversations.",
      "",
      "Actions:",
      "  save   — Store a new memory (user preference, project context, feedback, or reference material).",
      "  search — Full-text search across all memories. Returns ranked results.",
      "  list   — List all memories, optionally filtered by type.",
      "  delete — Remove a memory by ID.",
      "",
      "Memory types:",
      "  user      — User preferences, habits, and personal context.",
      "  feedback  — Corrections and feedback the user has given you.",
      "  project   — Project-specific context (architecture, conventions, etc.).",
      "  reference — Reference material (docs, snippets, etc.).",
    ].join("\n"),

    inputSchema: memoryInputSchema as unknown as z.ZodType<Record<string, unknown>>,

    async execute(
      rawInput: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult<MemoryOutput>> {
      const input = memoryInputSchema.parse(rawInput);

      switch (input.action) {
        case "save": {
          const entry = await memory.save({
            type: input.type,
            name: input.name,
            description: input.description,
            content: input.content,
            tags: input.tags,
          });
          return { data: { saved: entry } };
        }

        case "search": {
          const results = await memory.search(
            input.query,
            input.type as MemoryType | undefined,
          );
          return { data: { results, count: results.length } };
        }

        case "list": {
          const entries = await memory.list(
            input.type as MemoryType | undefined,
          );
          return { data: { entries, count: entries.length } };
        }

        case "delete": {
          await memory.delete(input.id);
          return { data: { deleted: input.id } };
        }
      }
    },

    isConcurrencySafe(_input: Record<string, unknown>): boolean {
      // Memory operations are all serialized by SQLite's WAL mode and don't
      // conflict with filesystem or other tool state.
      return true;
    },

    isReadOnly(rawInput: Record<string, unknown>): boolean {
      const parsed = memoryInputSchema.safeParse(rawInput);
      if (!parsed.success) return false;
      return parsed.data.action === "search" || parsed.data.action === "list";
    },

    renderToolUse(input: Partial<Record<string, unknown>>): string {
      const action = input.action as string | undefined;
      switch (action) {
        case "save":
          return `memory save: "${input.name}" (${input.type})`;
        case "search":
          return `memory search: "${input.query}"${input.type ? ` [${input.type}]` : ""}`;
        case "list":
          return `memory list${input.type ? ` [${input.type}]` : ""}`;
        case "delete":
          return `memory delete: ${input.id}`;
        default:
          return "memory";
      }
    },

    renderResult(output: MemoryOutput): string {
      if ("saved" in output) {
        return `Saved memory "${output.saved.name}" (id: ${output.saved.id})`;
      }
      if ("results" in output) {
        if (output.count === 0) return "No matching memories found.";
        return output.results
          .map((r) => `[${r.type}] ${r.name}: ${r.description}`)
          .join("\n");
      }
      if ("entries" in output) {
        if (output.count === 0) return "No memories stored.";
        return output.entries
          .map((e) => `[${e.type}] ${e.name} (${e.id}): ${e.description}`)
          .join("\n");
      }
      if ("deleted" in output) {
        return `Deleted memory ${output.deleted}`;
      }
      return JSON.stringify(output);
    },
  };
}
