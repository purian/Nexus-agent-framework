import { describe, it, expect } from "vitest";
import { RBACManager } from "./rbac.js";
import { PermissionManager } from "./index.js";
import type {
  PermissionRule,
  RBACPolicy,
  RBACRole,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  toolName: string,
  behavior: "allow" | "deny" | "ask",
  source: "user" | "project" | "session" | "cli" = "project",
  pattern?: string,
): PermissionRule {
  return { toolName, behavior, source, pattern };
}

function makeRole(
  name: string,
  permissions: PermissionRule[],
  inherits?: string[],
  description?: string,
): RBACRole {
  return { name, permissions, inherits, description };
}

function makePolicy(
  roles: RBACRole[] = [],
  assignments: Array<{ agentId: string; roles: string[] }> = [],
  defaultRole?: string,
): RBACPolicy {
  return { roles, assignments, defaultRole };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RBACManager", () => {
  // =========================================================================
  // Constructor
  // =========================================================================

  describe("constructor", () => {
    it("loads roles from policy", () => {
      const role = makeRole("tester", [makeRule("Bash", "allow")]);
      const mgr = new RBACManager(makePolicy([role]));
      // The role should be queryable via assignment
      mgr.assignRoles("agent-1", ["tester"]);
      expect(mgr.hasRole("agent-1", "tester")).toBe(true);
    });

    it("loads assignments from policy", () => {
      const role = makeRole("tester", [makeRule("Bash", "allow")]);
      const policy = makePolicy(
        [role],
        [{ agentId: "agent-1", roles: ["tester"] }],
      );
      const mgr = new RBACManager(policy);
      expect(mgr.getRoles("agent-1")).toEqual(["tester"]);
    });

    it("sets default role", () => {
      const role = makeRole("viewer", [makeRule("Read", "allow")]);
      const policy = makePolicy([role], [], "viewer");
      const mgr = new RBACManager(policy);
      expect(mgr.getRoles("unknown-agent")).toEqual(["viewer"]);
    });

    it("works with no policy", () => {
      const mgr = new RBACManager();
      expect(mgr.getRoles("any-agent")).toEqual([]);
    });
  });

  // =========================================================================
  // addRole / removeRole
  // =========================================================================

  describe("addRole", () => {
    it("registers a new role", () => {
      const mgr = new RBACManager();
      const role = makeRole("custom", [makeRule("Bash", "allow")]);
      mgr.addRole(role);
      mgr.assignRoles("agent-1", ["custom"]);
      const permissions = mgr.resolvePermissions("agent-1");
      expect(permissions).toEqual(role.permissions);
    });

    it("overwrites existing role", () => {
      const mgr = new RBACManager();
      mgr.addRole(makeRole("custom", [makeRule("Bash", "allow")]));
      mgr.addRole(makeRole("custom", [makeRule("Read", "deny")]));
      mgr.assignRoles("agent-1", ["custom"]);
      const permissions = mgr.resolvePermissions("agent-1");
      expect(permissions).toHaveLength(1);
      expect(permissions[0].toolName).toBe("Read");
    });
  });

  describe("removeRole", () => {
    it("removes a role", () => {
      const mgr = new RBACManager();
      mgr.addRole(makeRole("custom", [makeRule("Bash", "allow")]));
      mgr.removeRole("custom");
      mgr.assignRoles("agent-1", ["custom"]);
      const permissions = mgr.resolvePermissions("agent-1");
      expect(permissions).toEqual([]);
    });

    it("no-op for unknown role", () => {
      const mgr = new RBACManager();
      // Should not throw
      expect(() => mgr.removeRole("nonexistent")).not.toThrow();
    });
  });

  // =========================================================================
  // assignRoles / removeAssignment
  // =========================================================================

  describe("assignRoles", () => {
    it("assigns roles to agent", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin"]);
      expect(mgr.getRoles("agent-1")).toEqual(["admin"]);
    });

    it("overwrites existing assignment", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin"]);
      mgr.assignRoles("agent-1", ["viewer"]);
      expect(mgr.getRoles("agent-1")).toEqual(["viewer"]);
    });
  });

  describe("removeAssignment", () => {
    it("removes agent assignment", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin"]);
      mgr.removeAssignment("agent-1");
      expect(mgr.getRoles("agent-1")).toEqual([]);
    });
  });

  // =========================================================================
  // getRoles
  // =========================================================================

  describe("getRoles", () => {
    it("returns assigned roles", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin", "developer"]);
      expect(mgr.getRoles("agent-1")).toEqual(["admin", "developer"]);
    });

    it("returns default role when no assignment", () => {
      const policy = makePolicy([], [], "viewer");
      const mgr = new RBACManager(policy);
      expect(mgr.getRoles("unassigned-agent")).toEqual(["viewer"]);
    });

    it("returns empty when no assignment and no default", () => {
      const mgr = new RBACManager();
      expect(mgr.getRoles("unassigned-agent")).toEqual([]);
    });
  });

  // =========================================================================
  // hasRole
  // =========================================================================

  describe("hasRole", () => {
    it("returns true for assigned role", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin"]);
      expect(mgr.hasRole("agent-1", "admin")).toBe(true);
    });

    it("returns false for unassigned role", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["viewer"]);
      expect(mgr.hasRole("agent-1", "admin")).toBe(false);
    });

    it("checks default role", () => {
      const policy = makePolicy([], [], "viewer");
      const mgr = new RBACManager(policy);
      expect(mgr.hasRole("any-agent", "viewer")).toBe(true);
      expect(mgr.hasRole("any-agent", "admin")).toBe(false);
    });
  });

  // =========================================================================
  // resolvePermissions
  // =========================================================================

  describe("resolvePermissions", () => {
    it("returns rules from single role", () => {
      const rules = [makeRule("Bash", "allow"), makeRule("Read", "allow")];
      const mgr = new RBACManager(
        makePolicy(
          [makeRole("custom", rules)],
          [{ agentId: "agent-1", roles: ["custom"] }],
        ),
      );
      const resolved = mgr.resolvePermissions("agent-1");
      expect(resolved).toEqual(rules);
    });

    it("merges rules from multiple roles", () => {
      const role1 = makeRole("r1", [makeRule("Bash", "allow")]);
      const role2 = makeRole("r2", [makeRule("Read", "deny")]);
      const mgr = new RBACManager(
        makePolicy(
          [role1, role2],
          [{ agentId: "agent-1", roles: ["r1", "r2"] }],
        ),
      );
      const resolved = mgr.resolvePermissions("agent-1");
      expect(resolved).toHaveLength(2);
      expect(resolved.map((r) => r.toolName)).toContain("Bash");
      expect(resolved.map((r) => r.toolName)).toContain("Read");
    });

    it("resolves inherited roles", () => {
      const base = makeRole("base", [makeRule("Read", "allow")]);
      const child = makeRole("child", [makeRule("Bash", "allow")], ["base"]);
      const mgr = new RBACManager(
        makePolicy(
          [base, child],
          [{ agentId: "agent-1", roles: ["child"] }],
        ),
      );
      const resolved = mgr.resolvePermissions("agent-1");
      expect(resolved).toHaveLength(2);
      // base rules come first (deepest ancestor first)
      expect(resolved[0].toolName).toBe("Read");
      expect(resolved[1].toolName).toBe("Bash");
    });

    it("deep inheritance chain (3+ levels)", () => {
      const grandparent = makeRole("gp", [makeRule("Glob", "allow")]);
      const parent = makeRole("parent", [makeRule("Read", "allow")], ["gp"]);
      const child = makeRole("child", [makeRule("Bash", "allow")], ["parent"]);
      const mgr = new RBACManager(
        makePolicy(
          [grandparent, parent, child],
          [{ agentId: "agent-1", roles: ["child"] }],
        ),
      );
      const resolved = mgr.resolvePermissions("agent-1");
      expect(resolved).toHaveLength(3);
      expect(resolved[0].toolName).toBe("Glob");
      expect(resolved[1].toolName).toBe("Read");
      expect(resolved[2].toolName).toBe("Bash");
    });

    it("deduplicates identical rules", () => {
      const sharedRule = makeRule("Read", "allow");
      const role1 = makeRole("r1", [sharedRule]);
      const role2 = makeRole("r2", [sharedRule]);
      const mgr = new RBACManager(
        makePolicy(
          [role1, role2],
          [{ agentId: "agent-1", roles: ["r1", "r2"] }],
        ),
      );
      const resolved = mgr.resolvePermissions("agent-1");
      expect(resolved).toHaveLength(1);
    });

    it("detects circular inheritance", () => {
      const roleA = makeRole("a", [makeRule("Read", "allow")], ["b"]);
      const roleB = makeRole("b", [makeRule("Bash", "allow")], ["a"]);
      const mgr = new RBACManager(
        makePolicy(
          [roleA, roleB],
          [{ agentId: "agent-1", roles: ["a"] }],
        ),
      );
      expect(() => mgr.resolvePermissions("agent-1")).toThrow(
        /Circular role inheritance detected/,
      );
    });

    it("uses default role when no assignment", () => {
      const role = makeRole("default-role", [makeRule("Read", "allow")]);
      const mgr = new RBACManager(makePolicy([role], [], "default-role"));
      const resolved = mgr.resolvePermissions("unassigned-agent");
      expect(resolved).toHaveLength(1);
      expect(resolved[0].toolName).toBe("Read");
    });

    it("returns empty for unknown agent with no default", () => {
      const mgr = new RBACManager();
      // Remove built-in roles to get a clean slate for this test
      mgr.removeRole("admin");
      mgr.removeRole("developer");
      mgr.removeRole("viewer");
      const resolved = mgr.resolvePermissions("unknown-agent");
      expect(resolved).toEqual([]);
    });
  });

  // =========================================================================
  // matchesAssignment (tested via getRoles with glob patterns)
  // =========================================================================

  describe("matchesAssignment (via getRoles)", () => {
    it("exact match", () => {
      const mgr = new RBACManager(
        makePolicy(
          [],
          [{ agentId: "agent-1", roles: ["admin"] }],
        ),
      );
      expect(mgr.getRoles("agent-1")).toEqual(["admin"]);
    });

    it("glob pattern with wildcard", () => {
      const mgr = new RBACManager(
        makePolicy(
          [],
          [{ agentId: "agent-*", roles: ["viewer"] }],
        ),
      );
      expect(mgr.getRoles("agent-123")).toEqual(["viewer"]);
      expect(mgr.getRoles("agent-abc")).toEqual(["viewer"]);
    });

    it("no match", () => {
      const mgr = new RBACManager(
        makePolicy(
          [],
          [{ agentId: "agent-*", roles: ["viewer"] }],
        ),
      );
      expect(mgr.getRoles("other-123")).toEqual([]);
    });
  });

  // =========================================================================
  // Built-in roles
  // =========================================================================

  describe("built-in roles", () => {
    it("admin role allows all tools", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["admin"]);
      const permissions = mgr.resolvePermissions("agent-1");
      expect(permissions).toHaveLength(1);
      expect(permissions[0].toolName).toBe("*");
      expect(permissions[0].behavior).toBe("allow");
    });

    it("viewer role allows only read tools", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["viewer"]);
      const permissions = mgr.resolvePermissions("agent-1");
      const allowedTools = permissions
        .filter((r) => r.behavior === "allow")
        .map((r) => r.toolName);
      expect(allowedTools).toEqual(["Read", "Grep", "Glob", "WebFetch"]);
      // Should NOT include Bash, Write, or Edit
      expect(allowedTools).not.toContain("Bash");
      expect(allowedTools).not.toContain("Write");
    });

    it("developer role allows tools but denies dangerous patterns", () => {
      const mgr = new RBACManager();
      mgr.assignRoles("agent-1", ["developer"]);
      const permissions = mgr.resolvePermissions("agent-1");
      const allowed = permissions.filter((r) => r.behavior === "allow");
      const denied = permissions.filter((r) => r.behavior === "deny");
      expect(allowed.length).toBeGreaterThan(0);
      expect(denied.length).toBeGreaterThan(0);
      // Check specific deny patterns
      const denyPatterns = denied.map((r) => r.pattern);
      expect(denyPatterns).toContain("rm -rf *");
      expect(denyPatterns).toContain("sudo *");
    });
  });
});

// ---------------------------------------------------------------------------
// PermissionManager + RBAC integration
// ---------------------------------------------------------------------------

describe("PermissionManager with RBAC", () => {
  it("checkPermission with agentId uses RBAC", () => {
    const policy = makePolicy(
      [makeRole("allow-read", [makeRule("Read", "allow")])],
      [{ agentId: "agent-1", roles: ["allow-read"] }],
    );
    const pm = new PermissionManager("default", [], policy);
    const decision = pm.checkPermission("Read", { file_path: "/a" }, "agent-1");
    expect(decision.behavior).toBe("allow");
  });

  it("checkPermission without agentId ignores RBAC", () => {
    const policy = makePolicy(
      [makeRole("allow-read", [makeRule("Read", "allow")])],
      [{ agentId: "agent-1", roles: ["allow-read"] }],
    );
    const pm = new PermissionManager("default", [], policy);
    // Without agentId, should fall back to default (ask)
    const decision = pm.checkPermission("Read", { file_path: "/a" });
    expect(decision.behavior).toBe("ask");
  });

  it("RBAC rules merge with existing rules", () => {
    const policy = makePolicy(
      [makeRole("custom", [makeRule("Read", "allow")])],
      [{ agentId: "agent-1", roles: ["custom"] }],
    );
    // Existing session rule denies Read (session > project priority)
    const pm = new PermissionManager(
      "default",
      [makeRule("Read", "deny", "session")],
      policy,
    );
    const decision = pm.checkPermission(
      "Read",
      { file_path: "/a" },
      "agent-1",
    );
    // Session rule (priority 2) should beat RBAC project rule (priority 1)
    expect(decision.behavior).toBe("deny");
  });
});
