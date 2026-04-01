import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "./worktree.js";
import type { WorktreeInfo } from "./worktree.js";

const execFile = promisify(execFileCb);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a temporary git repo with an initial commit.
 * Returns the path to the repo root.
 */
async function createTempRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), "nexus-wt-test-"));
  await execFile("git", ["init", repoDir]);
  await execFile("git", ["-C", repoDir, "config", "user.email", "test@nexus.dev"]);
  await execFile("git", ["-C", repoDir, "config", "user.name", "Test"]);

  // Create an initial commit so HEAD exists
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  await execFile("git", ["-C", repoDir, "add", "."]);
  await execFile("git", ["-C", repoDir, "commit", "-m", "Initial commit"]);

  return repoDir;
}

// ============================================================================
// WorktreeManager Tests
// ============================================================================

describe("WorktreeManager", () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    repoDir = await createTempRepo();
    manager = new WorktreeManager(repoDir);
  });

  afterEach(async () => {
    // Clean up all worktrees managed by this instance
    await manager.cleanup();
  });

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe("create", () => {
    it("creates a worktree and returns info with valid fields", async () => {
      const info = await manager.create();

      expect(info.id).toBeTruthy();
      expect(info.path).toBeTruthy();
      expect(info.branch).toMatch(/^nexus-agent-[a-f0-9]{8}$/);
      expect(info.createdAt).toBeInstanceOf(Date);
      expect(existsSync(info.path)).toBe(true);
    });

    it("creates a worktree directory that contains a .git file", async () => {
      const info = await manager.create();

      // Worktrees have a .git file (not a directory) pointing to the main repo
      expect(existsSync(join(info.path, ".git"))).toBe(true);
    });

    it("creates the branch in the main repo", async () => {
      const info = await manager.create();

      const { stdout } = await execFile("git", ["branch", "--list", info.branch], {
        cwd: repoDir,
      });
      expect(stdout.trim()).toContain(info.branch);
    });

    it("associates agentId when provided", async () => {
      const info = await manager.create({ agentId: "agent-xyz" });

      expect(info.agentId).toBe("agent-xyz");
    });

    it("creates worktree from a custom baseBranch", async () => {
      // Create a branch with a different file
      await execFile("git", ["-C", repoDir, "checkout", "-b", "feature-branch"]);
      writeFileSync(join(repoDir, "feature.txt"), "feature content\n");
      await execFile("git", ["-C", repoDir, "add", "."]);
      await execFile("git", ["-C", repoDir, "commit", "-m", "Add feature"]);
      await execFile("git", ["-C", repoDir, "checkout", "-"]);

      const info = await manager.create({ baseBranch: "feature-branch" });

      // The worktree should contain the feature file
      expect(existsSync(join(info.path, "feature.txt"))).toBe(true);
    });

    it("creates multiple worktrees without conflict", async () => {
      const info1 = await manager.create();
      const info2 = await manager.create();
      const info3 = await manager.create();

      expect(info1.id).not.toBe(info2.id);
      expect(info2.id).not.toBe(info3.id);
      expect(info1.path).not.toBe(info2.path);
      expect(info1.branch).not.toBe(info2.branch);

      expect(existsSync(info1.path)).toBe(true);
      expect(existsSync(info2.path)).toBe(true);
      expect(existsSync(info3.path)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // remove
  // --------------------------------------------------------------------------

  describe("remove", () => {
    it("removes the worktree directory and branch", async () => {
      const info = await manager.create();
      const worktreePath = info.path;
      const branch = info.branch;

      await manager.remove(info.id);

      // Path should no longer exist
      expect(existsSync(worktreePath)).toBe(false);

      // Branch should be deleted
      const { stdout } = await execFile("git", ["branch", "--list", branch], {
        cwd: repoDir,
      });
      expect(stdout.trim()).toBe("");
    });

    it("removes the worktree from the managed list", async () => {
      const info = await manager.create();
      expect(manager.get(info.id)).toBeDefined();

      await manager.remove(info.id);
      expect(manager.get(info.id)).toBeUndefined();
    });

    it("throws an error when removing a non-existent worktree", async () => {
      await expect(manager.remove("nonexistent-id")).rejects.toThrow(
        /not found/,
      );
    });
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  describe("list", () => {
    it("returns an empty array when no worktrees exist", () => {
      expect(manager.list()).toEqual([]);
    });

    it("returns one worktree after creating one", async () => {
      const info = await manager.create();
      const list = manager.list();

      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(info.id);
    });

    it("returns multiple worktrees", async () => {
      await manager.create();
      await manager.create();
      await manager.create();

      expect(manager.list()).toHaveLength(3);
    });

    it("reflects removals", async () => {
      const info1 = await manager.create();
      const info2 = await manager.create();

      expect(manager.list()).toHaveLength(2);

      await manager.remove(info1.id);

      const remaining = manager.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(info2.id);
    });
  });

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  describe("get", () => {
    it("returns the worktree info for a known ID", async () => {
      const info = await manager.create({ agentId: "test-agent" });
      const retrieved = manager.get(info.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(info.id);
      expect(retrieved!.path).toBe(info.path);
      expect(retrieved!.branch).toBe(info.branch);
      expect(retrieved!.agentId).toBe("test-agent");
    });

    it("returns undefined for an unknown ID", () => {
      expect(manager.get("unknown")).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // isWorktree
  // --------------------------------------------------------------------------

  describe("isWorktree", () => {
    it("returns true for a path that matches a worktree", async () => {
      const info = await manager.create();

      expect(manager.isWorktree(info.path)).toBe(true);
    });

    it("returns true for a path inside a worktree", async () => {
      const info = await manager.create();

      expect(manager.isWorktree(join(info.path, "src", "file.ts"))).toBe(true);
    });

    it("returns false for a path outside any worktree", async () => {
      await manager.create();

      expect(manager.isWorktree("/some/random/path")).toBe(false);
    });

    it("returns false when no worktrees exist", () => {
      expect(manager.isWorktree("/any/path")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // cleanup
  // --------------------------------------------------------------------------

  describe("cleanup", () => {
    it("removes all managed worktrees", async () => {
      const info1 = await manager.create();
      const info2 = await manager.create();
      const info3 = await manager.create();

      expect(manager.list()).toHaveLength(3);

      await manager.cleanup();

      expect(manager.list()).toHaveLength(0);
      expect(existsSync(info1.path)).toBe(false);
      expect(existsSync(info2.path)).toBe(false);
      expect(existsSync(info3.path)).toBe(false);
    });

    it("is a no-op when no worktrees exist", async () => {
      await expect(manager.cleanup()).resolves.not.toThrow();
      expect(manager.list()).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // hasChanges
  // --------------------------------------------------------------------------

  describe("hasChanges", () => {
    it("returns false for a clean worktree", async () => {
      const info = await manager.create();

      const changed = await manager.hasChanges(info.id);
      expect(changed).toBe(false);
    });

    it("returns true when files are modified in the worktree", async () => {
      const info = await manager.create();

      // Modify a file in the worktree
      writeFileSync(join(info.path, "README.md"), "modified content\n");

      const changed = await manager.hasChanges(info.id);
      expect(changed).toBe(true);
    });

    it("returns true when files are staged in the worktree", async () => {
      const info = await manager.create();

      // Add a new file and stage it
      writeFileSync(join(info.path, "new-file.txt"), "new content\n");
      await execFile("git", ["-C", info.path, "add", "new-file.txt"]);

      const changed = await manager.hasChanges(info.id);
      expect(changed).toBe(true);
    });

    it("throws for a non-existent worktree ID", async () => {
      await expect(manager.hasChanges("nonexistent")).rejects.toThrow(
        /not found/,
      );
    });
  });
});
