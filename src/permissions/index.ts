import type {
  NexusConfig,
  PermissionBehavior,
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  PermissionSource,
  RBACPolicy,
} from "../types/index.js";
import { RBACManager } from "./rbac.js";

// Priority order: higher number = higher priority.
const SOURCE_PRIORITY: Record<PermissionSource, number> = {
  user: 0,
  project: 1,
  session: 2,
  cli: 3,
};

/**
 * Parse a tool specifier like "Bash(git *)" into a tool name and an
 * optional input pattern. Plain tool names like "Read" return no pattern.
 */
function parseToolSpecifier(spec: string): {
  toolName: string;
  pattern: string | undefined;
} {
  const match = spec.match(/^(\w+)\((.+)\)$/);
  if (match) {
    return { toolName: match[1], pattern: match[2] };
  }
  return { toolName: spec, pattern: undefined };
}

/**
 * Convert a glob-like pattern to a RegExp.
 *
 * Supported syntax:
 *   *   - match any sequence of characters (except nothing by default — use ** for deeper)
 *   ?   - match exactly one character
 *   **  - match any sequence including nothing
 *
 * Everything else is treated as a literal.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += ".*";
      i++;
    } else if (ch === "?") {
      regex += ".";
      i++;
    } else {
      // Escape regex-special characters.
      regex += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

/**
 * Determine the primary input string that a rule's pattern should be matched
 * against. For well-known tools this extracts the obvious field; for unknown
 * tools it falls back to a JSON representation of the full input.
 */
function extractInputString(
  toolName: string,
  input: Record<string, unknown>,
): string {
  // Common conventions — extend as needed.
  const fieldCandidates: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    Grep: ["pattern"],
    Glob: ["pattern"],
    WebFetch: ["url"],
  };

  const fields = fieldCandidates[toolName];
  if (fields) {
    for (const field of fields) {
      if (typeof input[field] === "string") {
        return input[field] as string;
      }
    }
  }

  return JSON.stringify(input);
}

/**
 * Check whether a rule matches a given tool invocation.
 */
function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  inputString: string,
): boolean {
  // Parse the rule's toolName which may contain a pattern inline, e.g. "Bash(git *)".
  const parsed = parseToolSpecifier(rule.toolName);

  if (parsed.toolName !== toolName) {
    return false;
  }

  // Determine the effective pattern: inline pattern takes precedence, then rule.pattern.
  const pattern = parsed.pattern ?? rule.pattern;

  if (pattern === undefined) {
    // No pattern means the rule matches any input for this tool.
    return true;
  }

  return globToRegex(pattern).test(inputString);
}

export class PermissionManager implements PermissionContext {
  mode: PermissionMode;
  rules: PermissionRule[];
  rbac?: RBACManager;

  constructor(
    mode: PermissionMode = "default",
    rules: PermissionRule[] = [],
    rbacPolicy?: RBACPolicy,
  ) {
    this.mode = mode;
    this.rules = [...rules];
    if (rbacPolicy) {
      this.rbac = new RBACManager(rbacPolicy);
    }
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  static createFromConfig(config: NexusConfig): PermissionManager {
    return new PermissionManager(
      config.permissionMode,
      config.permissionRules,
      config.rbac,
    );
  }

  // ---------------------------------------------------------------------------
  // Rule CRUD
  // ---------------------------------------------------------------------------

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(toolName: string, pattern?: string): void {
    this.rules = this.rules.filter((rule) => {
      if (rule.toolName !== toolName) return true;
      if (pattern !== undefined && rule.pattern !== pattern) return true;
      return false;
    });
  }

  getRules(source?: PermissionSource): PermissionRule[] {
    if (source === undefined) {
      return [...this.rules];
    }
    return this.rules.filter((r) => r.source === source);
  }

  // ---------------------------------------------------------------------------
  // Core permission check
  // ---------------------------------------------------------------------------

  checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    agentId?: string,
  ): PermissionDecision {
    // Fast-path: mode-level overrides.
    if (this.mode === "allowAll") {
      return { behavior: "allow" };
    }

    if (this.mode === "denyAll") {
      return {
        behavior: "deny",
        reason: "Permission mode is set to denyAll",
      };
    }

    if (this.mode === "plan") {
      return this.checkPlanMode(toolName, input);
    }

    // Default mode: evaluate rules, optionally including RBAC rules.
    if (agentId && this.rbac) {
      return this.evaluateRulesWithRBAC(toolName, input, agentId);
    }

    return this.evaluateRules(toolName, input);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private checkPlanMode(
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision {
    // In plan mode, read-only tools are allowed, everything else is denied.
    const readOnlyTools = new Set(["Read", "Grep", "Glob", "WebFetch"]);

    if (readOnlyTools.has(toolName)) {
      return { behavior: "allow" };
    }

    // Still allow explicit rules to override plan mode.
    const ruleDecision = this.evaluateRules(toolName, input);
    if (ruleDecision.behavior === "allow") {
      return ruleDecision;
    }

    return {
      behavior: "deny",
      reason: `Tool "${toolName}" is not allowed in plan mode (read-only)`,
    };
  }

  private evaluateRulesWithRBAC(
    toolName: string,
    input: Record<string, unknown>,
    agentId: string,
  ): PermissionDecision {
    const rbacRules = this.rbac!.resolvePermissions(agentId);
    const combinedRules = [...this.rules, ...rbacRules];

    const inputString = extractInputString(toolName, input);

    // Collect all matching rules (including wildcard tool matches from RBAC).
    const matches = combinedRules.filter((rule) => {
      // Handle wildcard toolName from RBAC roles (e.g., admin: "*" allows all).
      if (rule.toolName === "*") {
        return true;
      }
      return ruleMatches(rule, toolName, inputString);
    });

    if (matches.length === 0) {
      return this.defaultDecision(toolName);
    }

    const best = this.selectHighestPriority(matches);
    return this.behaviorToDecision(best.behavior, toolName);
  }

  private evaluateRules(
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision {
    const inputString = extractInputString(toolName, input);

    // Collect all matching rules.
    const matches = this.rules.filter((rule) =>
      ruleMatches(rule, toolName, inputString),
    );

    if (matches.length === 0) {
      return this.defaultDecision(toolName);
    }

    // Select the highest-priority match. Among equal priority, the last-added
    // rule wins (it sits later in the array).
    const best = this.selectHighestPriority(matches);

    return this.behaviorToDecision(best.behavior, toolName);
  }

  private selectHighestPriority(matches: PermissionRule[]): PermissionRule {
    let best = matches[0];

    for (let i = 1; i < matches.length; i++) {
      const rule = matches[i];
      const rulePriority = SOURCE_PRIORITY[rule.source];
      const bestPriority = SOURCE_PRIORITY[best.source];

      if (rulePriority > bestPriority) {
        best = rule;
      } else if (rulePriority === bestPriority) {
        // Same priority: later rule wins (last-writer-wins within a source).
        best = rule;
      }
    }

    return best;
  }

  private behaviorToDecision(
    behavior: PermissionBehavior,
    toolName: string,
  ): PermissionDecision {
    switch (behavior) {
      case "allow":
        return { behavior: "allow" };
      case "deny":
        return {
          behavior: "deny",
          reason: `Tool "${toolName}" is denied by a permission rule`,
        };
      case "ask":
        return {
          behavior: "ask",
          message: `Tool "${toolName}" requires user approval`,
        };
    }
  }

  private defaultDecision(toolName: string): PermissionDecision {
    return {
      behavior: "ask",
      message: `No permission rule found for "${toolName}". User approval required.`,
    };
  }
}
