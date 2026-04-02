import { randomUUID } from "node:crypto";
import { EventEmitter } from "eventemitter3";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { TaskScheduler } from "../core/scheduler.js";

// ============================================================================
// Types
// ============================================================================

export interface ProactiveAgentConfig {
  id: string;
  name: string;
  /** Condition to check — a shell command, file path, or custom checker */
  trigger: ProactiveTrigger;
  /** Prompt to run when trigger fires */
  prompt: string;
  /** Cooldown between triggers in seconds (default: 300) */
  cooldownSeconds?: number;
  /** Max triggers before auto-disable (0 = unlimited) */
  maxTriggers?: number;
  /** Agent config overrides */
  agentConfig?: { model?: string; maxTurns?: number; systemPrompt?: string };
  /** Whether enabled */
  enabled: boolean;
}

export type ProactiveTrigger =
  | { type: "file_change"; paths: string[]; patterns?: string[] }
  | {
      type: "command";
      command: string;
      /** Fire when exit code is (default: 0) */
      exitCode?: number;
    }
  | { type: "webhook"; path: string }
  | { type: "interval"; seconds: number }
  | { type: "cron"; expression: string };

export type ProactiveEvent =
  | { type: "trigger_fired"; agentId: string; trigger: ProactiveTrigger }
  | { type: "agent_started"; agentId: string }
  | { type: "agent_completed"; agentId: string; durationMs: number }
  | { type: "agent_error"; agentId: string; error: string }
  | { type: "cooldown_active"; agentId: string; remainingSeconds: number }
  | { type: "max_triggers_reached"; agentId: string };

// ============================================================================
// ProactiveAgentManager
// ============================================================================

/**
 * ProactiveAgentManager — monitors conditions and emits events to trigger
 * agent runs without explicit user prompting.
 *
 * Like the TaskScheduler, actual engine invocation is handled externally
 * by consumers listening to the emitted events.
 */
export class ProactiveAgentManager extends EventEmitter<{
  event: [ProactiveEvent];
}> {
  private agents = new Map<string, ProactiveAgentConfig>();
  private watchers = new Map<string, { cleanup: () => void }>();
  private lastTriggered = new Map<string, number>(); // timestamp ms
  private triggerCounts = new Map<string, number>();
  private running = false;

  constructor() {
    super();
  }

  // --------------------------------------------------------------------------
  // Agent management
  // --------------------------------------------------------------------------

  register(config: ProactiveAgentConfig): void {
    this.agents.set(config.id, config);
    this.triggerCounts.set(config.id, 0);

    if (this.running && config.enabled) {
      this.startWatcher(config);
    }
  }

  unregister(id: string): void {
    this.stopWatcher(id);
    this.agents.delete(id);
    this.lastTriggered.delete(id);
    this.triggerCounts.delete(id);
  }

  enable(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.enabled = true;
    if (this.running) {
      this.startWatcher(agent);
    }
  }

  disable(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.enabled = false;
    this.stopWatcher(id);
  }

  getAgent(id: string): ProactiveAgentConfig | undefined {
    return this.agents.get(id);
  }

  listAgents(): ProactiveAgentConfig[] {
    return Array.from(this.agents.values());
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const agent of this.agents.values()) {
      if (agent.enabled) {
        this.startWatcher(agent);
      }
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const id of this.watchers.keys()) {
      this.stopWatcher(id);
    }
  }

  // --------------------------------------------------------------------------
  // Watcher management
  // --------------------------------------------------------------------------

  private startWatcher(config: ProactiveAgentConfig): void {
    // Stop any existing watcher for this agent
    this.stopWatcher(config.id);

    let watcher: { cleanup: () => void };

    switch (config.trigger.type) {
      case "file_change":
        watcher = this.startFileWatcher(config);
        break;
      case "command":
        watcher = this.startCommandWatcher(config);
        break;
      case "interval":
        watcher = this.startIntervalWatcher(config);
        break;
      case "cron":
        watcher = this.startCronWatcher(config);
        break;
      case "webhook":
        // Webhook watchers are passive — they're triggered by HTTP requests
        // externally. We just register a no-op watcher.
        watcher = { cleanup: () => {} };
        break;
      default:
        return;
    }

    this.watchers.set(config.id, watcher);
  }

  private stopWatcher(id: string): void {
    const watcher = this.watchers.get(id);
    if (watcher) {
      watcher.cleanup();
      this.watchers.delete(id);
    }
  }

  // --------------------------------------------------------------------------
  // Trigger handling
  // --------------------------------------------------------------------------

  private checkCooldown(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    const cooldownMs = (agent.cooldownSeconds ?? 300) * 1000;
    const lastTime = this.lastTriggered.get(id);

    if (lastTime === undefined) return true;

    return Date.now() - lastTime >= cooldownMs;
  }

  handleTrigger(id: string): void {
    const agent = this.agents.get(id);
    if (!agent || !agent.enabled) return;

    // Check max triggers
    const maxTriggers = agent.maxTriggers ?? 0;
    const currentCount = this.triggerCounts.get(id) ?? 0;

    if (maxTriggers > 0 && currentCount >= maxTriggers) {
      agent.enabled = false;
      this.stopWatcher(id);
      this.emit("event", { type: "max_triggers_reached", agentId: id });
      return;
    }

    // Check cooldown
    if (!this.checkCooldown(id)) {
      const lastTime = this.lastTriggered.get(id) ?? 0;
      const cooldownMs = (agent.cooldownSeconds ?? 300) * 1000;
      const elapsed = Date.now() - lastTime;
      const remainingSeconds = Math.ceil((cooldownMs - elapsed) / 1000);

      this.emit("event", {
        type: "cooldown_active",
        agentId: id,
        remainingSeconds,
      });
      return;
    }

    // Fire trigger
    this.lastTriggered.set(id, Date.now());
    this.triggerCounts.set(id, currentCount + 1);

    this.emit("event", {
      type: "trigger_fired",
      agentId: id,
      trigger: agent.trigger,
    });
  }

  // --------------------------------------------------------------------------
  // Watcher implementations
  // --------------------------------------------------------------------------

  private startFileWatcher(config: ProactiveAgentConfig): {
    cleanup: () => void;
  } {
    const trigger = config.trigger as Extract<
      ProactiveTrigger,
      { type: "file_change" }
    >;
    const watchers: fs.FSWatcher[] = [];

    for (const watchPath of trigger.paths) {
      try {
        const watcher = fs.watch(watchPath, () => {
          this.handleTrigger(config.id);
        });
        watchers.push(watcher);
      } catch {
        // Path might not exist yet — silently skip
      }
    }

    return {
      cleanup: () => {
        for (const w of watchers) {
          w.close();
        }
      },
    };
  }

  private startCommandWatcher(config: ProactiveAgentConfig): {
    cleanup: () => void;
  } {
    const trigger = config.trigger as Extract<
      ProactiveTrigger,
      { type: "command" }
    >;
    const expectedExitCode = trigger.exitCode ?? 0;

    const checkCommand = () => {
      const child = spawn("sh", ["-c", trigger.command], {
        stdio: "ignore",
      });
      child.on("close", (code) => {
        if (code === expectedExitCode) {
          this.handleTrigger(config.id);
        }
      });
    };

    // Check every 30 seconds
    const interval = setInterval(checkCommand, 30000);
    // Also run immediately
    checkCommand();

    return {
      cleanup: () => clearInterval(interval),
    };
  }

  private startIntervalWatcher(config: ProactiveAgentConfig): {
    cleanup: () => void;
  } {
    const trigger = config.trigger as Extract<
      ProactiveTrigger,
      { type: "interval" }
    >;
    const interval = setInterval(
      () => this.handleTrigger(config.id),
      trigger.seconds * 1000,
    );

    return {
      cleanup: () => clearInterval(interval),
    };
  }

  private startCronWatcher(config: ProactiveAgentConfig): {
    cleanup: () => void;
  } {
    const trigger = config.trigger as Extract<
      ProactiveTrigger,
      { type: "cron" }
    >;

    // Create a minimal scheduler to parse and match the cron expression
    const scheduler = new TaskScheduler({
      enabled: true,
      tasks: [],
    });
    const parts = scheduler.parseCronExpression(trigger.expression);

    // Check every 60 seconds (cron granularity is 1 minute)
    let lastMatchedMinute = -1;

    const interval = setInterval(() => {
      const now = new Date();
      const currentMinute =
        now.getFullYear() * 525960 +
        now.getMonth() * 43800 +
        now.getDate() * 1440 +
        now.getHours() * 60 +
        now.getMinutes();

      if (currentMinute !== lastMatchedMinute && scheduler.matchesCron(parts, now)) {
        lastMatchedMinute = currentMinute;
        this.handleTrigger(config.id);
      }
    }, 60000);

    return {
      cleanup: () => clearInterval(interval),
    };
  }
}
