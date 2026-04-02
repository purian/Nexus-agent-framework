import { randomUUID } from "node:crypto";
import { EventEmitter } from "eventemitter3";

// ============================================================================
// Types
// ============================================================================

export interface ScheduledTask {
  id: string;
  name: string;
  /** Cron expression (e.g., every 5 minutes: 0/5 * * * *) */
  schedule: string;
  /** The prompt to send to the agent */
  prompt: string;
  /** Whether the task is currently enabled */
  enabled: boolean;
  /** Max concurrent runs (default: 1) */
  maxConcurrent?: number;
  /** Agent config overrides */
  agentConfig?: { model?: string; maxTurns?: number; systemPrompt?: string };
  /** Last run timestamp */
  lastRunAt?: Date;
  /** Next scheduled run */
  nextRunAt?: Date;
  /** Run count */
  runCount: number;
  /** Created at */
  createdAt: Date;
}

export interface SchedulerConfig {
  enabled: boolean;
  tasks: Omit<
    ScheduledTask,
    "id" | "lastRunAt" | "nextRunAt" | "runCount" | "createdAt"
  >[];
  /** Check interval in ms (how often to check for due tasks, default: 1000) */
  checkIntervalMs?: number;
}

export type SchedulerEvent =
  | { type: "task_triggered"; taskId: string; taskName: string }
  | {
      type: "task_completed";
      taskId: string;
      taskName: string;
      durationMs: number;
    }
  | { type: "task_error"; taskId: string; taskName: string; error: string }
  | { type: "task_skipped"; taskId: string; taskName: string; reason: string };

// ============================================================================
// Cron Parsing
// ============================================================================

interface CronParts {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

// ============================================================================
// TaskScheduler
// ============================================================================

/**
 * TaskScheduler — cron-like task scheduler that triggers agent runs on a schedule.
 *
 * The scheduler itself does not run engines. It emits events that external
 * consumers (e.g., the CLI or a coordinator) listen to and invoke the engine.
 */
export class TaskScheduler extends EventEmitter<{ event: [SchedulerEvent] }> {
  private tasks = new Map<string, ScheduledTask>();
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private activeTasks = new Map<string, number>(); // taskId -> running count
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    super();
    this.config = config;

    // Register initial tasks from config
    for (const taskDef of config.tasks) {
      this.addTask(taskDef);
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = this.config.checkIntervalMs ?? 1000;
    this.timer = setInterval(() => this.checkDueTasks(), intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Task management
  // --------------------------------------------------------------------------

  addTask(
    task: Omit<
      ScheduledTask,
      "id" | "lastRunAt" | "nextRunAt" | "runCount" | "createdAt"
    >,
  ): ScheduledTask {
    const id = randomUUID();
    const now = new Date();
    const scheduled: ScheduledTask = {
      ...task,
      id,
      runCount: 0,
      createdAt: now,
      nextRunAt: this.calculateNextRun(task.schedule, now),
    };
    this.tasks.set(id, scheduled);
    this.activeTasks.set(id, 0);
    return scheduled;
  }

  removeTask(id: string): void {
    this.tasks.delete(id);
    this.activeTasks.delete(id);
  }

  enableTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.enabled = true;
      task.nextRunAt = this.calculateNextRun(task.schedule);
    }
  }

  disableTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.enabled = false;
    }
  }

  getTask(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /** Manually trigger a task immediately */
  triggerTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.executeTask(task);
  }

  // --------------------------------------------------------------------------
  // Internal scheduling logic
  // --------------------------------------------------------------------------

  private checkDueTasks(): void {
    const now = new Date();

    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (!task.nextRunAt || task.nextRunAt > now) continue;

      const maxConcurrent = task.maxConcurrent ?? 1;
      const activeCount = this.activeTasks.get(task.id) ?? 0;

      if (activeCount >= maxConcurrent) {
        this.emit("event", {
          type: "task_skipped",
          taskId: task.id,
          taskName: task.name,
          reason: `Max concurrent runs reached (${maxConcurrent})`,
        });
        // Still advance nextRunAt so we don't spam skips every tick
        task.nextRunAt = this.calculateNextRun(task.schedule, now);
        continue;
      }

      this.executeTask(task);
    }
  }

  private executeTask(task: ScheduledTask): void {
    const now = new Date();
    task.lastRunAt = now;
    task.runCount++;
    task.nextRunAt = this.calculateNextRun(task.schedule, now);

    this.activeTasks.set(task.id, (this.activeTasks.get(task.id) ?? 0) + 1);

    this.emit("event", {
      type: "task_triggered",
      taskId: task.id,
      taskName: task.name,
    });
  }

  /**
   * Mark a task execution as completed (called externally after engine finishes).
   */
  completeTask(taskId: string, durationMs: number): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const count = this.activeTasks.get(taskId) ?? 1;
    this.activeTasks.set(taskId, Math.max(0, count - 1));

    this.emit("event", {
      type: "task_completed",
      taskId: task.id,
      taskName: task.name,
      durationMs,
    });
  }

  /**
   * Mark a task execution as errored (called externally on engine failure).
   */
  errorTask(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const count = this.activeTasks.get(taskId) ?? 1;
    this.activeTasks.set(taskId, Math.max(0, count - 1));

    this.emit("event", {
      type: "task_error",
      taskId: task.id,
      taskName: task.name,
      error,
    });
  }

  // --------------------------------------------------------------------------
  // Cron parsing and matching
  // --------------------------------------------------------------------------

  /** Parse a standard 5-field cron expression into expanded arrays of matching values */
  parseCronExpression(expression: string): CronParts {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(
        `Invalid cron expression: expected 5 fields, got ${fields.length}`,
      );
    }

    return {
      minute: this.parseField(fields[0], 0, 59),
      hour: this.parseField(fields[1], 0, 23),
      dayOfMonth: this.parseField(fields[2], 1, 31),
      month: this.parseField(fields[3], 1, 12),
      dayOfWeek: this.parseField(fields[4], 0, 6),
    };
  }

  private parseField(field: string, min: number, max: number): number[] {
    const values = new Set<number>();

    for (const part of field.split(",")) {
      if (part === "*") {
        for (let i = min; i <= max; i++) values.add(i);
      } else if (part.includes("/")) {
        const [range, stepStr] = part.split("/");
        const step = parseInt(stepStr, 10);
        let start = min;
        let end = max;
        if (range !== "*") {
          if (range.includes("-")) {
            const [s, e] = range.split("-");
            start = parseInt(s, 10);
            end = parseInt(e, 10);
          } else {
            start = parseInt(range, 10);
          }
        }
        for (let i = start; i <= end; i += step) {
          values.add(i);
        }
      } else if (part.includes("-")) {
        const [startStr, endStr] = part.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        for (let i = start; i <= end; i++) {
          values.add(i);
        }
      } else {
        values.add(parseInt(part, 10));
      }
    }

    return Array.from(values).sort((a, b) => a - b);
  }

  /** Check if a Date matches the given cron parts */
  matchesCron(parts: CronParts, date: Date): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // JS months are 0-indexed
    const dayOfWeek = date.getDay(); // 0 = Sunday

    return (
      parts.minute.includes(minute) &&
      parts.hour.includes(hour) &&
      parts.dayOfMonth.includes(dayOfMonth) &&
      parts.month.includes(month) &&
      parts.dayOfWeek.includes(dayOfWeek)
    );
  }

  /** Calculate the next run time from a cron expression, starting from `from` (or now) */
  calculateNextRun(schedule: string, from?: Date): Date {
    const parts = this.parseCronExpression(schedule);
    const start = from ? new Date(from.getTime()) : new Date();

    // Move to the next minute boundary
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    // Search up to 366 days ahead
    const maxIterations = 366 * 24 * 60;

    for (let i = 0; i < maxIterations; i++) {
      if (this.matchesCron(parts, start)) {
        return new Date(start.getTime());
      }
      start.setMinutes(start.getMinutes() + 1);
    }

    // Should never reach here for valid cron expressions
    throw new Error(
      `Could not find next run for schedule "${schedule}" within 366 days`,
    );
  }
}
