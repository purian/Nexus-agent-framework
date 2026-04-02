import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskScheduler } from "./scheduler.js";
import type { SchedulerConfig, SchedulerEvent } from "./scheduler.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createConfig(
  overrides: Partial<SchedulerConfig> = {},
): SchedulerConfig {
  return {
    enabled: true,
    tasks: [],
    checkIntervalMs: 1000,
    ...overrides,
  };
}

function createTaskDef(overrides: Partial<{ name: string; schedule: string; prompt: string; enabled: boolean; maxConcurrent: number }> = {}) {
  return {
    name: overrides.name ?? "test-task",
    schedule: overrides.schedule ?? "*/5 * * * *",
    prompt: overrides.prompt ?? "Run test",
    enabled: overrides.enabled ?? true,
    maxConcurrent: overrides.maxConcurrent,
  };
}

function collectEvents(scheduler: TaskScheduler): SchedulerEvent[] {
  const events: SchedulerEvent[] = [];
  scheduler.on("event", (e) => events.push(e));
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe("TaskScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1
  it("constructor - initializes with config", () => {
    const config = createConfig({
      tasks: [createTaskDef({ name: "initial-task" })],
    });
    const scheduler = new TaskScheduler(config);
    const tasks = scheduler.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("initial-task");
  });

  // 2
  it("addTask - creates task with generated ID", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ name: "my-task" }));
    expect(task.id).toBeDefined();
    expect(typeof task.id).toBe("string");
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.name).toBe("my-task");
    expect(task.runCount).toBe(0);
    expect(task.createdAt).toBeInstanceOf(Date);
  });

  // 3
  it("addTask - calculates nextRunAt", () => {
    vi.setSystemTime(new Date("2025-01-15T10:30:00Z"));
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ schedule: "0 11 * * *" }));
    expect(task.nextRunAt).toBeInstanceOf(Date);
    expect(task.nextRunAt!.getHours()).toBe(11);
    expect(task.nextRunAt!.getMinutes()).toBe(0);
  });

  // 4
  it("removeTask - removes task", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef());
    expect(scheduler.listTasks()).toHaveLength(1);
    scheduler.removeTask(task.id);
    expect(scheduler.listTasks()).toHaveLength(0);
    expect(scheduler.getTask(task.id)).toBeUndefined();
  });

  // 5
  it("enableTask / disableTask - toggles enabled", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ enabled: false }));
    expect(scheduler.getTask(task.id)!.enabled).toBe(false);

    scheduler.enableTask(task.id);
    expect(scheduler.getTask(task.id)!.enabled).toBe(true);

    scheduler.disableTask(task.id);
    expect(scheduler.getTask(task.id)!.enabled).toBe(false);
  });

  // 6
  it("getTask / listTasks - retrieval", () => {
    const scheduler = new TaskScheduler(createConfig());
    const t1 = scheduler.addTask(createTaskDef({ name: "task-1" }));
    const t2 = scheduler.addTask(createTaskDef({ name: "task-2" }));

    expect(scheduler.getTask(t1.id)?.name).toBe("task-1");
    expect(scheduler.getTask(t2.id)?.name).toBe("task-2");
    expect(scheduler.listTasks()).toHaveLength(2);
  });

  // 7
  it("triggerTask - manually triggers and emits event", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ name: "manual-trigger" }));
    const events = collectEvents(scheduler);

    scheduler.triggerTask(task.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task_triggered",
      taskId: task.id,
      taskName: "manual-trigger",
    });
    expect(scheduler.getTask(task.id)!.runCount).toBe(1);
  });

  // 8
  it("start/stop - lifecycle", () => {
    const scheduler = new TaskScheduler(createConfig());
    scheduler.start();
    // Starting again is a no-op
    scheduler.start();
    scheduler.stop();
    // Stopping again is a no-op
    scheduler.stop();
  });

  // 9
  it("parseCronExpression - * * * * * (every minute)", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("* * * * *");
    expect(parts.minute).toHaveLength(60); // 0-59
    expect(parts.hour).toHaveLength(24); // 0-23
    expect(parts.dayOfMonth).toHaveLength(31); // 1-31
    expect(parts.month).toHaveLength(12); // 1-12
    expect(parts.dayOfWeek).toHaveLength(7); // 0-6
  });

  // 10
  it("parseCronExpression - */5 * * * * (every 5 min)", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("*/5 * * * *");
    expect(parts.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  // 11
  it("parseCronExpression - 0 9 * * 1-5 (weekdays at 9am)", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("0 9 * * 1-5");
    expect(parts.minute).toEqual([0]);
    expect(parts.hour).toEqual([9]);
    expect(parts.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  // 12
  it("parseCronExpression - 0 0 1 * * (first of month)", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("0 0 1 * *");
    expect(parts.minute).toEqual([0]);
    expect(parts.hour).toEqual([0]);
    expect(parts.dayOfMonth).toEqual([1]);
  });

  // 13
  it("parseCronExpression - 30 14 * * * (2:30pm daily)", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("30 14 * * *");
    expect(parts.minute).toEqual([30]);
    expect(parts.hour).toEqual([14]);
  });

  // 14
  it("parseCronExpression - lists 1,3,5 * * * *", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("1,3,5 * * * *");
    expect(parts.minute).toEqual([1, 3, 5]);
  });

  // 15
  it("matchesCron - matches correct time", () => {
    const scheduler = new TaskScheduler(createConfig());
    // Use a date and check its local time components
    const date = new Date(2025, 0, 15, 14, 30, 0); // Jan 15, 2025 14:30 local
    const parts = scheduler.parseCronExpression(`30 14 15 1 ${date.getDay()}`);
    expect(scheduler.matchesCron(parts, date)).toBe(true);
  });

  // 16
  it("matchesCron - rejects non-matching time", () => {
    const scheduler = new TaskScheduler(createConfig());
    const parts = scheduler.parseCronExpression("30 14 * * *");
    const date = new Date(2025, 0, 15, 15, 30, 0); // 15:30 local - doesn't match 14:30
    expect(scheduler.matchesCron(parts, date)).toBe(false);
  });

  // 17
  it("calculateNextRun - finds next matching minute", () => {
    const from = new Date(2025, 0, 15, 10, 27, 0); // 10:27 local
    vi.setSystemTime(from);
    const scheduler = new TaskScheduler(createConfig());
    const next = scheduler.calculateNextRun("*/5 * * * *", from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(10);
  });

  // 18
  it("checkDueTasks - triggers due tasks", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig({ checkIntervalMs: 100 }));
    const task = scheduler.addTask(createTaskDef({ schedule: "* * * * *" }));
    const events = collectEvents(scheduler);

    scheduler.start();

    // Advance to when the task is due (nextRunAt should be 10:01)
    vi.setSystemTime(new Date("2025-01-15T10:01:00Z"));
    vi.advanceTimersByTime(100);

    scheduler.stop();

    const triggered = events.filter((e) => e.type === "task_triggered");
    expect(triggered.length).toBeGreaterThanOrEqual(1);
    expect(triggered[0]).toMatchObject({
      type: "task_triggered",
      taskId: task.id,
    });
  });

  // 19
  it("checkDueTasks - skips disabled tasks", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig({ checkIntervalMs: 100 }));
    scheduler.addTask(createTaskDef({ enabled: false, schedule: "* * * * *" }));
    const events = collectEvents(scheduler);

    scheduler.start();
    vi.setSystemTime(new Date("2025-01-15T10:01:00Z"));
    vi.advanceTimersByTime(100);
    scheduler.stop();

    expect(events).toHaveLength(0);
  });

  // 20
  it("checkDueTasks - respects maxConcurrent", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig({ checkIntervalMs: 100 }));
    const task = scheduler.addTask(
      createTaskDef({ schedule: "* * * * *", maxConcurrent: 1 }),
    );
    const events = collectEvents(scheduler);

    // Trigger once manually (simulates an active run that hasn't completed)
    scheduler.triggerTask(task.id);

    scheduler.start();
    vi.setSystemTime(new Date("2025-01-15T10:01:00Z"));
    vi.advanceTimersByTime(100);
    scheduler.stop();

    const skipped = events.filter((e) => e.type === "task_skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
  });

  // 21
  it("checkDueTasks - emits task_skipped when at max concurrent", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig({ checkIntervalMs: 100 }));
    const task = scheduler.addTask(
      createTaskDef({ schedule: "* * * * *", maxConcurrent: 1 }),
    );
    const events = collectEvents(scheduler);

    scheduler.triggerTask(task.id);

    scheduler.start();
    vi.setSystemTime(new Date("2025-01-15T10:01:00Z"));
    vi.advanceTimersByTime(100);
    scheduler.stop();

    const skipped = events.filter((e) => e.type === "task_skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0]).toMatchObject({
      type: "task_skipped",
      taskId: task.id,
      reason: expect.stringContaining("Max concurrent"),
    });
  });

  // 22
  it("executeTask - updates lastRunAt and runCount", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef());
    expect(task.runCount).toBe(0);
    expect(task.lastRunAt).toBeUndefined();

    scheduler.triggerTask(task.id);

    const updated = scheduler.getTask(task.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toBeInstanceOf(Date);
  });

  // 23
  it("executeTask - emits task_triggered", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ name: "emit-test" }));
    const events = collectEvents(scheduler);

    scheduler.triggerTask(task.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task_triggered",
      taskName: "emit-test",
    });
  });

  // 24
  it("task lifecycle - create, trigger, complete cycle", () => {
    const scheduler = new TaskScheduler(createConfig());
    const task = scheduler.addTask(createTaskDef({ name: "lifecycle" }));
    const events = collectEvents(scheduler);

    scheduler.triggerTask(task.id);
    scheduler.completeTask(task.id, 1500);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("task_triggered");
    expect(events[1]).toMatchObject({
      type: "task_completed",
      taskId: task.id,
      durationMs: 1500,
    });
  });

  // 25
  it("multiple tasks - independent scheduling", () => {
    vi.setSystemTime(new Date("2025-01-15T10:00:00Z"));
    const scheduler = new TaskScheduler(createConfig({ checkIntervalMs: 100 }));
    const t1 = scheduler.addTask(
      createTaskDef({ name: "task-a", schedule: "* * * * *" }),
    );
    const t2 = scheduler.addTask(
      createTaskDef({ name: "task-b", schedule: "* * * * *" }),
    );
    const events = collectEvents(scheduler);

    scheduler.start();
    vi.setSystemTime(new Date("2025-01-15T10:01:00Z"));
    vi.advanceTimersByTime(100);
    scheduler.stop();

    const triggered = events.filter((e) => e.type === "task_triggered");
    const taskIds = triggered.map((e) => (e as { taskId: string }).taskId);
    expect(taskIds).toContain(t1.id);
    expect(taskIds).toContain(t2.id);
  });
});
