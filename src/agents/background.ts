import { randomUUID } from "node:crypto";
import { EventEmitter } from "eventemitter3";
import type { NexusEngine } from "../core/engine.js";
import type { EngineEvent } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export type BackgroundAgentStatus = "running" | "completed" | "error" | "stopped";

export interface BackgroundAgentInfo {
  id: string;
  prompt: string;
  status: BackgroundAgentStatus;
  startedAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  events: EngineEvent[];
}

export interface BackgroundAgentNotification {
  agentId: string;
  status: BackgroundAgentStatus;
  result?: string;
  error?: string;
  duration: number; // milliseconds
}

// ============================================================================
// BackgroundAgentManager
// ============================================================================

interface ManagedBackgroundAgent {
  info: BackgroundAgentInfo;
  abortController: AbortController;
}

/**
 * BackgroundAgentManager — launches agents that run in the background,
 * collecting their events and emitting notifications on completion.
 */
export class BackgroundAgentManager extends EventEmitter<{
  notification: [BackgroundAgentNotification];
}> {
  private agents: Map<string, ManagedBackgroundAgent> = new Map();

  /**
   * Launch an agent in the background. Returns immediately with the agent ID.
   * The engine.run() call is started as an async task (fire-and-forget).
   */
  launch(agentId: string, engine: NexusEngine, prompt: string): string {
    const id = agentId || randomUUID();

    const abortController = new AbortController();

    const info: BackgroundAgentInfo = {
      id,
      prompt,
      status: "running",
      startedAt: new Date(),
      events: [],
    };

    const managed: ManagedBackgroundAgent = {
      info,
      abortController,
    };

    this.agents.set(id, managed);

    // Fire-and-forget: start the engine run and collect events
    this.runInBackground(managed, engine, prompt);

    return id;
  }

  /**
   * Get info about a background agent.
   */
  get(agentId: string): BackgroundAgentInfo | undefined {
    return this.agents.get(agentId)?.info;
  }

  /**
   * List all background agents, optionally filtered by status.
   */
  list(status?: BackgroundAgentStatus): BackgroundAgentInfo[] {
    const all = Array.from(this.agents.values()).map((m) => m.info);
    if (status) {
      return all.filter((a) => a.status === status);
    }
    return all;
  }

  /**
   * Stop a running background agent.
   */
  stop(agentId: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;

    if (managed.info.status === "running") {
      managed.abortController.abort();
      managed.info.status = "stopped";
      managed.info.completedAt = new Date();

      const duration =
        managed.info.completedAt.getTime() - managed.info.startedAt.getTime();

      this.emit("notification", {
        agentId,
        status: "stopped",
        duration,
      });
    }
  }

  /**
   * Get the collected events for replay/review.
   */
  getEvents(agentId: string): EngineEvent[] {
    return this.agents.get(agentId)?.info.events ?? [];
  }

  /**
   * Clean up completed/errored/stopped agents from the list.
   * Returns the count of pruned agents.
   */
  prune(): number {
    let count = 0;
    for (const [id, managed] of this.agents) {
      if (
        managed.info.status === "completed" ||
        managed.info.status === "error" ||
        managed.info.status === "stopped"
      ) {
        this.agents.delete(id);
        count++;
      }
    }
    return count;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async runInBackground(
    managed: ManagedBackgroundAgent,
    engine: NexusEngine,
    prompt: string,
  ): Promise<void> {
    const { info, abortController } = managed;

    try {
      const generator = engine.run(prompt, {
        signal: abortController.signal,
      });

      for await (const event of generator) {
        // If we were stopped while iterating, bail out
        if (info.status === "stopped") return;

        info.events.push(event);

        // Accumulate text output
        if (event.type === "text") {
          info.result = (info.result ?? "") + event.text;
        }
      }

      // Only set completed if we weren't stopped during iteration
      if (info.status === "running") {
        info.status = "completed";
        info.completedAt = new Date();

        const duration =
          info.completedAt.getTime() - info.startedAt.getTime();

        this.emit("notification", {
          agentId: info.id,
          status: "completed",
          result: info.result,
          duration,
        });
      }
    } catch (err) {
      // If we were already stopped, don't overwrite the status
      if (info.status === "stopped") return;

      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
      info.completedAt = new Date();

      const duration =
        info.completedAt.getTime() - info.startedAt.getTime();

      this.emit("notification", {
        agentId: info.id,
        status: "error",
        error: info.error,
        duration,
      });
    }
  }
}
