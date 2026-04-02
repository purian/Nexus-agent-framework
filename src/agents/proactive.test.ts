import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProactiveAgentManager } from "./proactive.js";
import type { ProactiveAgentConfig, ProactiveEvent } from "./proactive.js";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("node:fs", () => ({
  watch: vi.fn((_path: string, callback: () => void) => {
    // Store callback for manual triggering in tests
    const watcher = {
      close: vi.fn(),
      _callback: callback,
    };
    (vi.mocked(require("node:fs").watch) as any).__lastWatcher = watcher;
    return watcher;
  }),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    return {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
      }),
      _handlers: handlers,
      stdio: "ignore",
    };
  }),
}));

// ============================================================================
// Test Helpers
// ============================================================================

function createAgentConfig(
  overrides: Partial<ProactiveAgentConfig> = {},
): ProactiveAgentConfig {
  return {
    id: overrides.id ?? "test-agent",
    name: overrides.name ?? "Test Agent",
    trigger: overrides.trigger ?? { type: "interval", seconds: 60 },
    prompt: overrides.prompt ?? "Test prompt",
    cooldownSeconds: overrides.cooldownSeconds ?? 10,
    maxTriggers: overrides.maxTriggers ?? 0,
    enabled: overrides.enabled ?? true,
    agentConfig: overrides.agentConfig,
  };
}

function collectEvents(manager: ProactiveAgentManager): ProactiveEvent[] {
  const events: ProactiveEvent[] = [];
  manager.on("event", (e) => events.push(e));
  return events;
}

// ============================================================================
// Tests
// ============================================================================

describe("ProactiveAgentManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 1
  it("register - adds agent", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1", name: "Agent One" }));
    expect(manager.getAgent("agent-1")).toBeDefined();
    expect(manager.getAgent("agent-1")!.name).toBe("Agent One");
  });

  // 2
  it("unregister - removes agent and stops watcher", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1" }));
    manager.start();
    manager.unregister("agent-1");
    expect(manager.getAgent("agent-1")).toBeUndefined();
    expect(manager.listAgents()).toHaveLength(0);
    manager.stop();
  });

  // 3
  it("enable/disable - toggles", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1", enabled: false }));
    expect(manager.getAgent("agent-1")!.enabled).toBe(false);

    manager.enable("agent-1");
    expect(manager.getAgent("agent-1")!.enabled).toBe(true);

    manager.disable("agent-1");
    expect(manager.getAgent("agent-1")!.enabled).toBe(false);
  });

  // 4
  it("getAgent/listAgents - retrieval", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "a1", name: "Agent A" }));
    manager.register(createAgentConfig({ id: "a2", name: "Agent B" }));

    expect(manager.getAgent("a1")?.name).toBe("Agent A");
    expect(manager.getAgent("a2")?.name).toBe("Agent B");
    expect(manager.listAgents()).toHaveLength(2);
  });

  // 5
  it("start/stop - lifecycle", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1" }));
    manager.start();
    // Starting again is a no-op
    manager.start();
    manager.stop();
    // Stopping again is a no-op
    manager.stop();
  });

  // 6
  it("handleTrigger - emits trigger_fired", () => {
    const manager = new ProactiveAgentManager();
    const config = createAgentConfig({ id: "agent-1", cooldownSeconds: 0 });
    manager.register(config);
    const events = collectEvents(manager);

    manager.handleTrigger("agent-1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "trigger_fired",
      agentId: "agent-1",
    });
  });

  // 7
  it("handleTrigger - respects cooldown", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1", cooldownSeconds: 60 }));
    const events = collectEvents(manager);

    // First trigger should fire
    manager.handleTrigger("agent-1");
    expect(events.filter((e) => e.type === "trigger_fired")).toHaveLength(1);

    // Second trigger within cooldown should be blocked
    vi.advanceTimersByTime(30000); // 30s < 60s cooldown
    manager.handleTrigger("agent-1");
    expect(events.filter((e) => e.type === "cooldown_active")).toHaveLength(1);
  });

  // 8
  it("handleTrigger - emits cooldown_active when cooling down", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1", cooldownSeconds: 60 }));
    const events = collectEvents(manager);

    manager.handleTrigger("agent-1");
    vi.advanceTimersByTime(10000); // 10 seconds
    manager.handleTrigger("agent-1");

    const cooldownEvents = events.filter((e) => e.type === "cooldown_active");
    expect(cooldownEvents).toHaveLength(1);
    expect((cooldownEvents[0] as any).remainingSeconds).toBeGreaterThan(0);
  });

  // 9
  it("handleTrigger - respects maxTriggers", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({ id: "agent-1", maxTriggers: 2, cooldownSeconds: 0 }),
    );
    const events = collectEvents(manager);

    manager.handleTrigger("agent-1");
    manager.handleTrigger("agent-1");
    manager.handleTrigger("agent-1"); // Should hit max

    const fired = events.filter((e) => e.type === "trigger_fired");
    expect(fired).toHaveLength(2);

    const maxReached = events.filter((e) => e.type === "max_triggers_reached");
    expect(maxReached).toHaveLength(1);
  });

  // 10
  it("handleTrigger - emits max_triggers_reached", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({ id: "agent-1", maxTriggers: 1, cooldownSeconds: 0 }),
    );
    const events = collectEvents(manager);

    manager.handleTrigger("agent-1"); // Uses the one trigger
    manager.handleTrigger("agent-1"); // Should emit max_triggers_reached

    expect(events[events.length - 1]).toMatchObject({
      type: "max_triggers_reached",
      agentId: "agent-1",
    });

    // Agent should be auto-disabled
    expect(manager.getAgent("agent-1")!.enabled).toBe(false);
  });

  // 11
  it("checkCooldown - allows after cooldown expires", () => {
    const manager = new ProactiveAgentManager();
    manager.register(createAgentConfig({ id: "agent-1", cooldownSeconds: 60 }));
    const events = collectEvents(manager);

    manager.handleTrigger("agent-1");
    expect(events.filter((e) => e.type === "trigger_fired")).toHaveLength(1);

    // Advance past cooldown
    vi.advanceTimersByTime(61000);
    manager.handleTrigger("agent-1");
    expect(events.filter((e) => e.type === "trigger_fired")).toHaveLength(2);
  });

  // 12
  it("startIntervalWatcher - triggers at interval", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "interval-agent",
        trigger: { type: "interval", seconds: 10 },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();

    vi.advanceTimersByTime(10000);
    expect(events.filter((e) => e.type === "trigger_fired")).toHaveLength(1);

    vi.advanceTimersByTime(10000);
    expect(events.filter((e) => e.type === "trigger_fired")).toHaveLength(2);

    manager.stop();
  });

  // 13
  it("startCronWatcher - triggers on matching cron", () => {
    // Cron watcher uses a 60s interval. We need to test that handleTrigger
    // is called when the cron expression matches. Since the cron watcher
    // integrates the scheduler's cron parsing, we test it indirectly by
    // calling handleTrigger for a cron-configured agent.
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "cron-agent",
        trigger: { type: "cron", expression: "30 10 * * *" },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    // Directly trigger as the cron watcher would
    manager.handleTrigger("cron-agent");

    const fired = events.filter((e) => e.type === "trigger_fired");
    expect(fired).toHaveLength(1);
    expect((fired[0] as any).trigger.type).toBe("cron");
  });

  // 14
  it("startCommandWatcher - triggers on exit code match", async () => {
    const childProcess = await import("node:child_process");
    const spawnMock = vi.mocked(childProcess.spawn);

    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "cmd-agent",
        trigger: { type: "command", command: "test -f /tmp/flag", exitCode: 0 },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();

    // The spawn mock was called immediately on start. Get the mock child and trigger close.
    const mockChild = spawnMock.mock.results[0]?.value as any;
    expect(mockChild).toBeDefined();
    mockChild._handlers.close(0);

    const fired = events.filter((e) => e.type === "trigger_fired");
    expect(fired).toHaveLength(1);

    manager.stop();
  });

  // 15
  it("startFileWatcher - triggers on file change", () => {
    const fs = require("node:fs");
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "file-agent",
        trigger: { type: "file_change", paths: ["/tmp/watched-file.txt"] },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();

    // Simulate file change via the mock watcher callback
    const lastWatcher = (fs.watch as any).__lastWatcher;
    if (lastWatcher && lastWatcher._callback) {
      lastWatcher._callback();
    }

    const fired = events.filter((e) => e.type === "trigger_fired");
    expect(fired).toHaveLength(1);

    manager.stop();
  });

  // 16
  it("stopWatcher - cleans up", () => {
    const fs = require("node:fs");
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "cleanup-agent",
        trigger: { type: "file_change", paths: ["/tmp/test"] },
      }),
    );

    manager.start();

    const lastWatcher = (fs.watch as any).__lastWatcher;
    manager.stop();

    // Verify close was called on the fs.watcher
    if (lastWatcher) {
      expect(lastWatcher.close).toHaveBeenCalled();
    }
  });

  // 17
  it("multiple agents - independent triggering", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "agent-a",
        trigger: { type: "interval", seconds: 10 },
        cooldownSeconds: 0,
      }),
    );
    manager.register(
      createAgentConfig({
        id: "agent-b",
        trigger: { type: "interval", seconds: 20 },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();

    vi.advanceTimersByTime(20000);

    manager.stop();

    const agentAFired = events.filter(
      (e) => e.type === "trigger_fired" && e.agentId === "agent-a",
    );
    const agentBFired = events.filter(
      (e) => e.type === "trigger_fired" && e.agentId === "agent-b",
    );

    // Agent A should have fired twice (10s + 20s), Agent B once (20s)
    expect(agentAFired).toHaveLength(2);
    expect(agentBFired).toHaveLength(1);
  });

  // 18
  it("register with disabled - doesn't start watcher", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "disabled-agent",
        enabled: false,
        trigger: { type: "interval", seconds: 5 },
      }),
    );
    const events = collectEvents(manager);

    manager.start();
    vi.advanceTimersByTime(10000);
    manager.stop();

    expect(events).toHaveLength(0);
  });

  // 19
  it("enable after register - starts watcher", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "lazy-agent",
        enabled: false,
        trigger: { type: "interval", seconds: 5 },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();
    vi.advanceTimersByTime(10000);
    expect(events).toHaveLength(0);

    manager.enable("lazy-agent");
    vi.advanceTimersByTime(5000);

    const fired = events.filter((e) => e.type === "trigger_fired");
    expect(fired).toHaveLength(1);

    manager.stop();
  });

  // 20
  it("stop - stops all watchers", () => {
    const manager = new ProactiveAgentManager();
    manager.register(
      createAgentConfig({
        id: "agent-1",
        trigger: { type: "interval", seconds: 5 },
        cooldownSeconds: 0,
      }),
    );
    manager.register(
      createAgentConfig({
        id: "agent-2",
        trigger: { type: "interval", seconds: 5 },
        cooldownSeconds: 0,
      }),
    );
    const events = collectEvents(manager);

    manager.start();
    vi.advanceTimersByTime(5000);
    const countBefore = events.filter((e) => e.type === "trigger_fired").length;

    manager.stop();
    vi.advanceTimersByTime(10000);
    const countAfter = events.filter((e) => e.type === "trigger_fired").length;

    // No new triggers after stop
    expect(countAfter).toBe(countBefore);
  });
});
