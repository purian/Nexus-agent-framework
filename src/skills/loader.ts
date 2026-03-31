import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface Skill {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  promptTemplate: string;
  filePath: string;
  arguments?: string;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
  arguments?: string;
}

// ============================================================================
// Frontmatter Parser (no external deps)
// ============================================================================

/**
 * Parse YAML frontmatter between `---` markers.
 * Handles simple scalar values, and inline/block arrays.
 * This is intentionally minimal — no nested objects or multi-line strings.
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
// Argument Substitution
// ============================================================================

/**
 * Replace `{{arg0}}`, `{{arg1}}`, etc. in a template with provided arguments.
 */
export function substituteArgs(template: string, args: string[]): string {
  return template.replace(/\{\{arg(\d+)\}\}/g, (_match, index) => {
    const i = Number.parseInt(index, 10);
    return i < args.length ? args[i] : `{{arg${i}}}`;
  });
}

// ============================================================================
// SkillLoader
// ============================================================================

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  /**
   * Discover and parse all `.md` skill files from:
   * 1. `<projectDir>/.nexus/skills/`
   * 2. `~/.nexus/skills/` (global, optional)
   */
  async loadSkills(projectDir: string): Promise<Skill[]> {
    this.skills.clear();

    const dirs = [
      join(projectDir, ".nexus", "skills"),
      join(homedir(), ".nexus", "skills"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;

      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(dir, entry);
        try {
          const raw = await readFile(filePath, "utf-8");
          const skill = this.parseSkillFile(raw, filePath);
          if (skill) {
            // Project-local skills override global ones with the same name
            this.skills.set(skill.name, skill);
          }
        } catch {
          // Skip files that cannot be read or parsed
        }
      }
    }

    return Array.from(this.skills.values());
  }

  /**
   * Get a loaded skill by name.
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private parseSkillFile(raw: string, filePath: string): Skill | null {
    const { frontmatter, body } = parseFrontmatter(raw);

    if (!frontmatter.name || !frontmatter.description) {
      return null;
    }

    const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools : [];

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      model: frontmatter.model,
      promptTemplate: body.trim(),
      filePath,
      arguments: frontmatter.arguments,
    };
  }
}
