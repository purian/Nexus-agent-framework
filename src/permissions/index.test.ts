import { describe, it, expect } from "vitest";
import { PermissionManager } from "./index.js";
import type {
  NexusConfig,
  PermissionMode,
  PermissionRule,
  PermissionSource,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  toolName: string,
  behavior: "allow" | "deny" | "ask",
  source: PermissionSource = "user",
  pattern?: string,
): PermissionRule {
  return { toolName, behavior, source, pattern };
}

function makeConfig(
  mode: PermissionMode = "default",
  rules: PermissionRule[] = [],
): NexusConfig {
  return {
    defaultModel: "test-model",
    defaultProvider: "test-provider",
    workingDirectory: "/tmp",
    dataDirectory: "/tmp/data",
    permissionMode: mode,
    permissionRules: rules,
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 1,
    thinking: { enabled: false },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PermissionManager", () => {
  // =========================================================================
  // Construction
  // =========================================================================

  describe("construction", () => {
    it("defaults to 'default' mode and empty rules", () => {
      const pm = new PermissionManager();
      expect(pm.mode).toBe("default");
      expect(pm.rules).toEqual([]);
    });

    it("accepts a mode and rules", () => {
      const rules = [makeRule("Bash", "allow", "user")];
      const pm = new PermissionManager("allowAll", rules);
      expect(pm.mode).toBe("allowAll");
      expect(pm.rules).toEqual(rules);
    });

    it("does not share the rules array with the caller", () => {
      const rules = [makeRule("Bash", "allow", "user")];
      const pm = new PermissionManager("default", rules);
      rules.push(makeRule("Read", "deny", "user"));
      expect(pm.rules).toHaveLength(1);
    });
  });

  // =========================================================================
  // createFromConfig
  // =========================================================================

  describe("createFromConfig", () => {
    it("creates a manager from a NexusConfig", () => {
      const rules = [makeRule("Bash", "deny", "project")];
      const config = makeConfig("plan", rules);
      const pm = PermissionManager.createFromConfig(config);
      expect(pm.mode).toBe("plan");
      expect(pm.rules).toEqual(rules);
    });

    it("works with an empty config", () => {
      const config = makeConfig();
      const pm = PermissionManager.createFromConfig(config);
      expect(pm.mode).toBe("default");
      expect(pm.rules).toEqual([]);
    });
  });

  // =========================================================================
  // Mode behavior
  // =========================================================================

  describe("mode: allowAll", () => {
    it("always returns allow regardless of tool or input", () => {
      const pm = new PermissionManager("allowAll");
      expect(pm.checkPermission("Bash", { command: "rm -rf /" })).toEqual({
        behavior: "allow",
      });
      expect(pm.checkPermission("Write", { file_path: "/etc/passwd" })).toEqual(
        { behavior: "allow" },
      );
    });

    it("ignores deny rules", () => {
      const pm = new PermissionManager("allowAll", [
        makeRule("Bash", "deny", "cli"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" })).toEqual({
        behavior: "allow",
      });
    });
  });

  describe("mode: denyAll", () => {
    it("always returns deny with a reason", () => {
      const pm = new PermissionManager("denyAll");
      const decision = pm.checkPermission("Read", { file_path: "/tmp/a.txt" });
      expect(decision.behavior).toBe("deny");
      expect(decision).toHaveProperty("reason");
    });

    it("ignores allow rules", () => {
      const pm = new PermissionManager("denyAll", [
        makeRule("Read", "allow", "cli"),
      ]);
      const decision = pm.checkPermission("Read", { file_path: "/tmp/a.txt" });
      expect(decision.behavior).toBe("deny");
    });
  });

  describe("mode: plan", () => {
    it("allows read-only tools", () => {
      const pm = new PermissionManager("plan");
      for (const tool of ["Read", "Grep", "Glob", "WebFetch"]) {
        const decision = pm.checkPermission(tool, {});
        expect(decision.behavior).toBe("allow");
      }
    });

    it("denies non-read-only tools by default", () => {
      const pm = new PermissionManager("plan");
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision.behavior).toBe("deny");
      expect(decision).toHaveProperty("reason");
    });

    it("allows a non-read-only tool if an explicit allow rule exists", () => {
      const pm = new PermissionManager("plan", [
        makeRule("Bash", "allow", "session", "git *"),
      ]);
      const decision = pm.checkPermission("Bash", { command: "git status" });
      expect(decision.behavior).toBe("allow");
    });

    it("denies a non-read-only tool when rule matches but behavior is deny", () => {
      const pm = new PermissionManager("plan", [
        makeRule("Bash", "deny", "session", "rm *"),
      ]);
      const decision = pm.checkPermission("Bash", { command: "rm -rf /tmp" });
      expect(decision.behavior).toBe("deny");
    });

    it("denies a non-read-only tool when no rules match the input", () => {
      const pm = new PermissionManager("plan", [
        makeRule("Bash", "allow", "session", "git *"),
      ]);
      const decision = pm.checkPermission("Bash", { command: "npm install" });
      expect(decision.behavior).toBe("deny");
    });
  });

  // =========================================================================
  // Default mode: rule evaluation
  // =========================================================================

  describe("mode: default (rule evaluation)", () => {
    it("falls back to 'ask' when no rules match", () => {
      const pm = new PermissionManager("default");
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision.behavior).toBe("ask");
      expect(decision).toHaveProperty("message");
    });

    it("returns allow when a matching allow rule exists", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "allow", "user"),
      ]);
      const decision = pm.checkPermission("Read", { file_path: "/tmp/a" });
      expect(decision.behavior).toBe("allow");
    });

    it("returns deny when a matching deny rule exists", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "deny", "user"),
      ]);
      const decision = pm.checkPermission("Bash", { command: "rm -rf /" });
      expect(decision.behavior).toBe("deny");
      expect(decision).toHaveProperty("reason");
    });

    it("returns ask when a matching ask rule exists", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "ask", "user"),
      ]);
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision.behavior).toBe("ask");
      expect(decision).toHaveProperty("message");
    });
  });

  // =========================================================================
  // Rule matching: exact name and pattern
  // =========================================================================

  describe("rule matching", () => {
    it("matches by exact tool name when no pattern is specified", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "allow", "user"),
      ]);
      expect(pm.checkPermission("Read", { file_path: "/a" }).behavior).toBe(
        "allow",
      );
      // Different tool should NOT match
      expect(pm.checkPermission("Write", { file_path: "/a" }).behavior).toBe(
        "ask",
      );
    });

    it("matches a pattern against the primary input field", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "git *"),
      ]);
      expect(
        pm.checkPermission("Bash", { command: "git status" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Bash", { command: "git push origin main" })
          .behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Bash", { command: "npm install" }).behavior,
      ).toBe("ask"); // no match
    });

    it("matches Read tool pattern against file_path", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "allow", "user", "/home/*"),
      ]);
      expect(
        pm.checkPermission("Read", { file_path: "/home/user/file.txt" })
          .behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Read", { file_path: "/etc/passwd" }).behavior,
      ).toBe("ask");
    });

    it("matches Grep tool pattern against the pattern input", () => {
      const pm = new PermissionManager("default", [
        makeRule("Grep", "deny", "user", "password*"),
      ]);
      expect(
        pm.checkPermission("Grep", { pattern: "password123" }).behavior,
      ).toBe("deny");
    });

    it("supports inline pattern syntax like Bash(git *)", () => {
      const pm = new PermissionManager("default", [
        { toolName: "Bash(git *)", behavior: "allow", source: "user" as const },
      ]);
      expect(
        pm.checkPermission("Bash", { command: "git status" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Bash", { command: "npm test" }).behavior,
      ).toBe("ask");
    });

    it("falls back to JSON input when tool is unknown", () => {
      const pm = new PermissionManager("default", [
        makeRule("CustomTool", "allow", "user", '*"key":"value"*'),
      ]);
      expect(
        pm.checkPermission("CustomTool", { key: "value" }).behavior,
      ).toBe("allow");
    });
  });

  // =========================================================================
  // Pattern edge cases
  // =========================================================================

  describe("pattern edge cases", () => {
    it("wildcard * matches any string", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "*"),
      ]);
      expect(pm.checkPermission("Bash", { command: "anything" }).behavior).toBe(
        "allow",
      );
      expect(
        pm.checkPermission("Bash", { command: "literally anything at all" })
          .behavior,
      ).toBe("allow");
    });

    it("no pattern matches all invocations of the tool", () => {
      const pm = new PermissionManager("default", [
        makeRule("Write", "deny", "project"),
      ]);
      expect(
        pm.checkPermission("Write", { file_path: "/a.txt" }).behavior,
      ).toBe("deny");
      expect(
        pm.checkPermission("Write", { file_path: "/b/c/d.ts" }).behavior,
      ).toBe("deny");
      expect(pm.checkPermission("Write", {}).behavior).toBe("deny");
    });

    it("? matches exactly one character", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "git ?"),
      ]);
      // Single char after "git " should match
      // "git s" has one char after "git " => matches
      // Wait - the pattern is "git ?" which means "git " + one char
      // "git status" has multiple chars => should NOT match
      expect(
        pm.checkPermission("Bash", { command: "git s" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Bash", { command: "git status" }).behavior,
      ).toBe("ask");
    });

    it("** matches any sequence including empty", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "allow", "user", "/home/**"),
      ]);
      expect(
        pm.checkPermission("Read", { file_path: "/home/" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Read", { file_path: "/home/user/file" }).behavior,
      ).toBe("allow");
    });

    it("regex special characters in pattern are escaped", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "echo (hello)"),
      ]);
      // Should match literal parentheses, not regex groups
      expect(
        pm.checkPermission("Bash", { command: "echo (hello)" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Bash", { command: "echo hello" }).behavior,
      ).toBe("ask");
    });

    it("pipe character in pattern is treated literally", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "cat * | grep *"),
      ]);
      expect(
        pm.checkPermission("Bash", { command: "cat file.txt | grep foo" })
          .behavior,
      ).toBe("allow");
    });
  });

  // =========================================================================
  // Rule priority
  // =========================================================================

  describe("rule priority (cli > session > project > user)", () => {
    it("cli rule overrides user rule", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
        makeRule("Bash", "deny", "cli"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "deny",
      );
    });

    it("session rule overrides project and user rules", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "deny", "user"),
        makeRule("Bash", "deny", "project"),
        makeRule("Bash", "allow", "session"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "allow",
      );
    });

    it("project rule overrides user rule", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
        makeRule("Bash", "deny", "project"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "deny",
      );
    });

    it("user rule does not override higher priority sources", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "cli"),
        makeRule("Bash", "deny", "user"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "allow",
      );
    });

    it("last-added rule wins when source priority is equal", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "deny", "user"),
        makeRule("Bash", "allow", "user"),
      ]);
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "allow",
      );
    });

    it("considers all four priority levels correctly", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "deny", "user"),
        makeRule("Read", "ask", "project"),
        makeRule("Read", "deny", "session"),
        makeRule("Read", "allow", "cli"),
      ]);
      expect(
        pm.checkPermission("Read", { file_path: "/any" }).behavior,
      ).toBe("allow");
    });
  });

  // =========================================================================
  // addRule and removeRule
  // =========================================================================

  describe("addRule", () => {
    it("adds a rule that takes effect immediately", () => {
      const pm = new PermissionManager("default");
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "ask",
      );

      pm.addRule(makeRule("Bash", "allow", "session"));
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "allow",
      );
    });

    it("appended rule wins over earlier same-source rule (last-writer-wins)", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "deny", "session"),
      ]);
      pm.addRule(makeRule("Bash", "allow", "session"));
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "allow",
      );
    });
  });

  describe("removeRule", () => {
    it("removes a rule by tool name", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
      ]);
      pm.removeRule("Bash");
      expect(pm.checkPermission("Bash", { command: "ls" }).behavior).toBe(
        "ask",
      );
    });

    it("removes only rules matching both tool name and pattern", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "git *"),
        makeRule("Bash", "deny", "user", "rm *"),
      ]);
      pm.removeRule("Bash", "git *");
      expect(pm.rules).toHaveLength(1);
      expect(pm.rules[0].pattern).toBe("rm *");
    });

    it("removes all matching rules when only tool name is given", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user", "git *"),
        makeRule("Bash", "deny", "user", "rm *"),
      ]);
      pm.removeRule("Bash");
      expect(pm.rules).toHaveLength(0);
    });

    it("does not remove rules for other tools", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
        makeRule("Read", "allow", "user"),
      ]);
      pm.removeRule("Bash");
      expect(pm.rules).toHaveLength(1);
      expect(pm.rules[0].toolName).toBe("Read");
    });
  });

  // =========================================================================
  // getRules
  // =========================================================================

  describe("getRules", () => {
    it("returns all rules when no source is specified", () => {
      const rules = [
        makeRule("Bash", "allow", "user"),
        makeRule("Read", "deny", "project"),
      ];
      const pm = new PermissionManager("default", rules);
      expect(pm.getRules()).toEqual(rules);
    });

    it("returns a copy, not the internal array", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
      ]);
      const returned = pm.getRules();
      returned.push(makeRule("Read", "deny", "cli"));
      expect(pm.rules).toHaveLength(1);
    });

    it("filters by source when provided", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "allow", "user"),
        makeRule("Read", "deny", "project"),
        makeRule("Write", "ask", "user"),
      ]);
      const userRules = pm.getRules("user");
      expect(userRules).toHaveLength(2);
      expect(userRules.every((r) => r.source === "user")).toBe(true);
    });
  });

  // =========================================================================
  // checkPermission return shape
  // =========================================================================

  describe("checkPermission return shape", () => {
    it("allow decision has behavior 'allow'", () => {
      const pm = new PermissionManager("allowAll");
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision).toEqual({ behavior: "allow" });
    });

    it("deny decision has behavior 'deny' and a reason string", () => {
      const pm = new PermissionManager("denyAll");
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision.behavior).toBe("deny");
      if (decision.behavior === "deny") {
        expect(typeof decision.reason).toBe("string");
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });

    it("ask decision has behavior 'ask' and a message string", () => {
      const pm = new PermissionManager("default");
      const decision = pm.checkPermission("Bash", { command: "ls" });
      expect(decision.behavior).toBe("ask");
      if (decision.behavior === "ask") {
        expect(typeof decision.message).toBe("string");
        expect(decision.message.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Complex scenarios
  // =========================================================================

  describe("complex scenarios", () => {
    it("pattern-specific rule and catch-all rule coexist correctly", () => {
      const pm = new PermissionManager("default", [
        makeRule("Bash", "deny", "project"), // deny all Bash
        makeRule("Bash", "allow", "session", "git *"), // allow git commands
      ]);
      // git commands allowed (session > project)
      expect(
        pm.checkPermission("Bash", { command: "git status" }).behavior,
      ).toBe("allow");
      // non-git commands denied (only project rule matches)
      expect(
        pm.checkPermission("Bash", { command: "rm -rf /" }).behavior,
      ).toBe("deny");
    });

    it("multiple tools with different rules", () => {
      const pm = new PermissionManager("default", [
        makeRule("Read", "allow", "user"),
        makeRule("Write", "deny", "project"),
        makeRule("Bash", "ask", "session"),
      ]);
      expect(
        pm.checkPermission("Read", { file_path: "/a" }).behavior,
      ).toBe("allow");
      expect(
        pm.checkPermission("Write", { file_path: "/b" }).behavior,
      ).toBe("deny");
      expect(
        pm.checkPermission("Bash", { command: "ls" }).behavior,
      ).toBe("ask");
      // Unmatched tool falls back to ask
      expect(
        pm.checkPermission("Edit", { file_path: "/c" }).behavior,
      ).toBe("ask");
    });

    it("inline pattern in toolName overrides rule.pattern", () => {
      const pm = new PermissionManager("default", [
        {
          toolName: "Bash(npm *)",
          behavior: "allow",
          source: "user" as const,
          pattern: "git *", // this should be ignored because inline takes precedence
        },
      ]);
      // npm commands match the inline pattern
      expect(
        pm.checkPermission("Bash", { command: "npm install" }).behavior,
      ).toBe("allow");
      // git commands would match rule.pattern but inline pattern takes precedence
      expect(
        pm.checkPermission("Bash", { command: "git push" }).behavior,
      ).toBe("ask");
    });
  });
});
