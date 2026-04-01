import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const execFile = promisify(execFileCb);

// ============================================================================
// Types
// ============================================================================

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  agentId?: string;
  createdAt: Date;
}

// ============================================================================
// WorktreeManager
// ============================================================================

/**
 * WorktreeManager — creates and manages isolated git worktrees for sub-agents.
 *
 * Each worktree gets its own branch and directory so that multiple agents
 * can work on the same repo without conflicting with each other or the
 * main working directory.
 */
export class WorktreeManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private baseDir: string;

  constructor(private repoRoot: string) {
    this.baseDir = join(tmpdir(), "nexus-worktrees");
  }

  /**
   * Create a new worktree with a unique branch.
   */
  async create(options?: {
    agentId?: string;
    baseBranch?: string;
  }): Promise<WorktreeInfo> {
    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const branch = `nexus-agent-${shortId}`;
    const worktreePath = join(this.baseDir, id);

    // Ensure the base directory exists
    mkdirSync(this.baseDir, { recursive: true });

    // Determine the base branch (default to current HEAD)
    const args = ["worktree", "add", worktreePath, "-b", branch];
    if (options?.baseBranch) {
      args.push(options.baseBranch);
    }

    await execFile("git", args, { cwd: this.repoRoot });

    const info: WorktreeInfo = {
      id,
      path: worktreePath,
      branch,
      agentId: options?.agentId,
      createdAt: new Date(),
    };

    this.worktrees.set(id, info);
    return info;
  }

  /**
   * Remove a worktree and clean up its branch.
   */
  async remove(id: string): Promise<void> {
    const info = this.worktrees.get(id);
    if (!info) {
      throw new Error(`Worktree "${id}" not found`);
    }

    // Remove the worktree
    await execFile("git", ["worktree", "remove", info.path, "--force"], {
      cwd: this.repoRoot,
    });

    // Delete the branch
    await execFile("git", ["branch", "-D", info.branch], {
      cwd: this.repoRoot,
    });

    this.worktrees.delete(id);
  }

  /**
   * List all managed worktrees.
   */
  list(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }

  /**
   * Get worktree by ID.
   */
  get(id: string): WorktreeInfo | undefined {
    return this.worktrees.get(id);
  }

  /**
   * Check if a path is inside a managed worktree.
   */
  isWorktree(path: string): boolean {
    for (const info of this.worktrees.values()) {
      if (path === info.path || path.startsWith(info.path + "/")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clean up all managed worktrees.
   */
  async cleanup(): Promise<void> {
    const ids = Array.from(this.worktrees.keys());
    for (const id of ids) {
      try {
        await this.remove(id);
      } catch {
        // Best-effort cleanup — if a worktree was already removed manually,
        // just drop it from the map.
        this.worktrees.delete(id);
      }
    }
  }

  /**
   * Check if a worktree has uncommitted changes.
   */
  async hasChanges(id: string): Promise<boolean> {
    const info = this.worktrees.get(id);
    if (!info) {
      throw new Error(`Worktree "${id}" not found`);
    }

    const { stdout } = await execFile("git", ["diff", "--stat"], {
      cwd: info.path,
    });

    // Also check staged changes
    const { stdout: stagedOut } = await execFile(
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: info.path },
    );

    return stdout.trim().length > 0 || stagedOut.trim().length > 0;
  }
}
