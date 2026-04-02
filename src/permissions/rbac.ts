import type {
  PermissionRule,
  RBACAssignment,
  RBACPolicy,
  RBACRole,
} from "../types/index.js";

/**
 * Built-in roles available by default. User-defined roles with the same name
 * will override these.
 */
const BUILT_IN_ROLES: RBACRole[] = [
  {
    name: "admin",
    description: "Full access to all tools",
    permissions: [
      { toolName: "*", behavior: "allow", source: "project" },
    ],
  },
  {
    name: "developer",
    description: "Read/write tools allowed, dangerous bash patterns denied",
    permissions: [
      { toolName: "Read", behavior: "allow", source: "project" },
      { toolName: "Write", behavior: "allow", source: "project" },
      { toolName: "Edit", behavior: "allow", source: "project" },
      { toolName: "Grep", behavior: "allow", source: "project" },
      { toolName: "Glob", behavior: "allow", source: "project" },
      { toolName: "WebFetch", behavior: "allow", source: "project" },
      { toolName: "Bash", behavior: "allow", source: "project" },
      { toolName: "Bash", pattern: "rm -rf *", behavior: "deny", source: "project" },
      { toolName: "Bash", pattern: "sudo *", behavior: "deny", source: "project" },
      { toolName: "Bash", pattern: "> /dev/*", behavior: "deny", source: "project" },
    ],
  },
  {
    name: "viewer",
    description: "Read-only access to safe tools",
    permissions: [
      { toolName: "Read", behavior: "allow", source: "project" },
      { toolName: "Grep", behavior: "allow", source: "project" },
      { toolName: "Glob", behavior: "allow", source: "project" },
      { toolName: "WebFetch", behavior: "allow", source: "project" },
    ],
  },
];

/**
 * Role-Based Access Control manager.
 *
 * Manages roles, agent-to-role assignments, and resolves effective permissions
 * for agents by merging rules from all assigned roles (including inherited
 * roles).
 */
export class RBACManager {
  private roles = new Map<string, RBACRole>();
  private assignments = new Map<string, string[]>(); // agentId -> role names
  private defaultRole?: string;

  constructor(policy?: RBACPolicy) {
    // Register built-in roles first.
    for (const role of BUILT_IN_ROLES) {
      this.roles.set(role.name, role);
    }

    if (policy) {
      // User-defined roles override built-ins with the same name.
      for (const role of policy.roles) {
        this.roles.set(role.name, role);
      }

      for (const assignment of policy.assignments) {
        this.assignments.set(assignment.agentId, [...assignment.roles]);
      }

      this.defaultRole = policy.defaultRole;
    }
  }

  // ---------------------------------------------------------------------------
  // Role management
  // ---------------------------------------------------------------------------

  /**
   * Add a role to the registry. Overwrites any existing role with the same name.
   */
  addRole(role: RBACRole): void {
    this.roles.set(role.name, role);
  }

  /**
   * Remove a role from the registry. No-op if the role does not exist.
   */
  removeRole(roleName: string): void {
    this.roles.delete(roleName);
  }

  // ---------------------------------------------------------------------------
  // Assignment management
  // ---------------------------------------------------------------------------

  /**
   * Assign roles to an agent. Overwrites any existing assignment.
   */
  assignRoles(agentId: string, roles: string[]): void {
    this.assignments.set(agentId, [...roles]);
  }

  /**
   * Remove role assignments for an agent.
   */
  removeAssignment(agentId: string): void {
    this.assignments.delete(agentId);
  }

  // ---------------------------------------------------------------------------
  // Role queries
  // ---------------------------------------------------------------------------

  /**
   * Get all roles assigned to an agent (including default).
   * Supports glob pattern matching on assignment keys.
   */
  getRoles(agentId: string): string[] {
    // Check for exact match first, then pattern matches.
    for (const [pattern, roles] of this.assignments) {
      if (this.matchesAssignment(agentId, pattern)) {
        return [...roles];
      }
    }

    // Fall back to default role.
    if (this.defaultRole) {
      return [this.defaultRole];
    }

    return [];
  }

  /**
   * Check if an agent has a specific role.
   */
  hasRole(agentId: string, roleName: string): boolean {
    return this.getRoles(agentId).includes(roleName);
  }

  // ---------------------------------------------------------------------------
  // Permission resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve all effective permission rules for an agent.
   * Merges rules from all assigned roles (including inherited roles).
   * Returns rules in priority order.
   */
  resolvePermissions(agentId: string): PermissionRule[] {
    const roleNames = this.getRoles(agentId);

    if (roleNames.length === 0) {
      return [];
    }

    const allRules: PermissionRule[] = [];
    const seenRoles = new Set<string>();

    for (const roleName of roleNames) {
      const chain = this.resolveRoleChain(roleName);
      for (const role of chain) {
        if (!seenRoles.has(role.name)) {
          seenRoles.add(role.name);
          allRules.push(...role.permissions);
        }
      }
    }

    // Deduplicate: same toolName + pattern + behavior
    return this.deduplicateRules(allRules);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get a flat list of all roles, resolving inheritance chains.
   * Detects circular inheritance and throws.
   *
   * Returns roles in inheritance order: deepest ancestor first, then child.
   */
  private resolveRoleChain(
    roleName: string,
    visited: Set<string> = new Set(),
  ): RBACRole[] {
    if (visited.has(roleName)) {
      throw new Error(
        `Circular role inheritance detected: ${[...visited, roleName].join(" -> ")}`,
      );
    }

    const role = this.roles.get(roleName);
    if (!role) {
      return [];
    }

    visited.add(roleName);

    const chain: RBACRole[] = [];

    // Resolve inherited roles first (deepest ancestor first).
    if (role.inherits && role.inherits.length > 0) {
      for (const parentName of role.inherits) {
        const parentChain = this.resolveRoleChain(
          parentName,
          new Set(visited),
        );
        for (const parentRole of parentChain) {
          if (!chain.some((r) => r.name === parentRole.name)) {
            chain.push(parentRole);
          }
        }
      }
    }

    // Add the role itself after its ancestors.
    chain.push(role);

    return chain;
  }

  /**
   * Match an agent ID against an assignment pattern.
   * Supports exact match and glob patterns (e.g., "agent-*").
   */
  private matchesAssignment(agentId: string, pattern: string): boolean {
    if (agentId === pattern) {
      return true;
    }

    // Convert glob pattern to regex.
    if (pattern.includes("*") || pattern.includes("?")) {
      let regex = "";
      for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
          regex += ".*";
        } else if (ch === "?") {
          regex += ".";
        } else {
          regex += ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
        }
      }
      return new RegExp(`^${regex}$`).test(agentId);
    }

    return false;
  }

  /**
   * Remove duplicate rules (same toolName + pattern + behavior).
   */
  private deduplicateRules(rules: PermissionRule[]): PermissionRule[] {
    const seen = new Set<string>();
    const result: PermissionRule[] = [];

    for (const rule of rules) {
      const key = `${rule.toolName}|${rule.pattern ?? ""}|${rule.behavior}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(rule);
      }
    }

    return result;
  }
}
