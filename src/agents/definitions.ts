import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
  temperature?: number;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
  maxTurns?: string;
  temperature?: string;
}

// ============================================================================
// Frontmatter Parser (no external deps)
// ============================================================================

/**
 * Parse YAML frontmatter between `---` markers.
 * Handles simple scalar values and inline/block arrays.
 * Intentionally minimal — no nested objects or multi-line strings.
 */
function parseFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }

  const endMarker = trimmed.indexOf("---", 3);
  if (endMarker === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = trimmed.slice(3, endMarker).trim();
  const body = trimmed.slice(endMarker + 3).replace(/^\r?\n/, "");

  const frontmatter: ParsedFrontmatter = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    const stripped = line.trimEnd();

    // Array continuation item: "  - value"
    if (currentKey && currentArray !== null && /^\s+-\s+/.test(stripped)) {
      const value = stripped.replace(/^\s+-\s+/, "").trim();
      currentArray.push(unquote(value));
      continue;
    }

    // If we were accumulating an array, flush it
    if (currentKey && currentArray !== null) {
      (frontmatter as Record<string, unknown>)[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Key: value line
    const match = stripped.match(/^(\w+)\s*:\s*(.*)/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      (frontmatter as Record<string, unknown>)[key] = inner
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
      continue;
    }

    // Empty value — start of a block array
    if (rawValue === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }

    // Scalar value
    (frontmatter as Record<string, unknown>)[key] = unquote(rawValue);
  }

  // Flush any remaining block array
  if (currentKey && currentArray !== null) {
    (frontmatter as Record<string, unknown>)[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ============================================================================
// AgentDefinitionLoader
// ============================================================================

export class AgentDefinitionLoader {
  private definitions: Map<string, AgentDefinition> = new Map();

  /**
   * Discover and parse all `.md` agent definition files from:
   * 1. `~/.nexus/agents/` (global/user-level)
   * 2. `<projectDir>/.nexus/agents/` (project-level, overrides global)
   */
  loadDefinitions(projectDir: string): AgentDefinition[] {
    this.definitions.clear();

    // Load global first, then project — project overrides global
    const dirs = [
      join(homedir(), ".nexus", "agents"),
      join(projectDir, ".nexus", "agents"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(dir, entry);
        try {
          const raw = readFileSync(filePath, "utf-8");
          const definition = this.parseDefinitionFile(raw);
          if (definition) {
            // Project-level definitions override global ones with the same name
            this.definitions.set(definition.name, definition);
          }
        } catch {
          // Skip files that cannot be read or parsed
        }
      }
    }

    return Array.from(this.definitions.values());
  }

  /**
   * Get a loaded definition by name.
   */
  getDefinition(name: string): AgentDefinition | undefined {
    return this.definitions.get(name);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private parseDefinitionFile(raw: string): AgentDefinition | null {
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!frontmatter.name || !frontmatter.description) {
      return null;
    }

    const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools : undefined;

    const definition: AgentDefinition = {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: body.trim(),
      tools,
      model: frontmatter.model,
    };

    // Parse numeric fields
    if (frontmatter.maxTurns !== undefined) {
      const parsed = Number(frontmatter.maxTurns);
      if (!Number.isNaN(parsed)) {
        definition.maxTurns = parsed;
      }
    }

    if (frontmatter.temperature !== undefined) {
      const parsed = Number(frontmatter.temperature);
      if (!Number.isNaN(parsed)) {
        definition.temperature = parsed;
      }
    }

    return definition;
  }
}
