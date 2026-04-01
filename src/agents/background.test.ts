import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackgroundAgentManager } from "./background.js";
import type {
  BackgroundAgentNotification,
} from "./background.js";
import type {
  EngineEvent,
  LLMProvider,
  LLMEvent,
  LLMRequest,
  NexusConfig,
  PermissionContext,
} from "../types/index.js";
import { NexusEngine } from "../core/engine.js";

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Creates a mock LLMProvider whose chat() yields predetermined LLM events.
 */
function createMockProvider(responseText = "Background result"): LLMProvider {
  return {
    name: "mock-provider",
    async *chat(
      _request: LLMRequest,
      _signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-bg-001" };
      yield { type: "text_delta", text: responseText };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

/**
 * Creates a mock provider that throws an error during execution.
 */
function createErrorProvider(errorMessage = "Provider exploded"): LLMProvider {
  return {
    name: "error-provider",
    async *chat(
      _request: LLMRequest,
      _signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-err" };
      throw new Error(errorMessage);
    },
  };
}

/**
 * Creates a mock provider that hangs until aborted.
 */
function createHangingProvider(): LLMProvider {
  return {
    name: "hanging-provider",
    async *chat(
      _request: LLMRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-hang" };
      yield { type: "text_delta", text: "Starting..." };
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/**
 * Creates a mock provider with a configurable delay to allow
 * testing stop while running.
 */
function createSlowProvider(delayMs = 100): LLMProvider {
  return {
    name: "slow-provider",
    async *chat(
      _request: LLMRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<LLMEvent> {
      yield { type: "message_start", messageId: "msg-slow" };
      yield { type: "text_delta", text: "chunk1" };

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        if (signal?.aborted) {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });

      yield { type: "text_delta", text: "chunk2" };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    },
  };
}

function createMockConfig(overrides?: Partial<NexusConfig>): NexusConfig {
  return {
    defaultModel: "test-model",
    defaultProvider: "mock",
    workingDirectory: "/tmp/nexus-test",
    dataDirectory: "/tmp/nexus-test-data",
    permissionMode: "allowAll",
    permissionRules: [],
    mcpServers: [],
    platforms: {},
    plugins: [],
    maxConcurrentTools: 5,
    thinking: { enabled: false },
    ...overrides,
  };
}

function createMockPermissions(): PermissionContext {
  const rules: PermissionContext["rules"] = [];
  return {
    mode: "allowAll",
    rules,
    checkPermission(
      _toolName: string,
      _input: Record<string, unknown>,
    ) {
      return { behavior: "allow" as const };
    },
    addRule(rule) {
      rules.push(rule);
    },
    removeRule(_toolName: string, _pattern?: string) {
      // no-op for tests
    },
  };
}

function createEngine(provider: LLMProvider): NexusEngine {
  return new NexusEngine(provider, createMockConfig(), createMockPermissions());
}

/**
 * Wait for a notification to be emitted on the manager, with a timeout.
 */
function waitForNotification(
  manager: BackgroundAgentManager,
  timeoutMs = 5000,
): Promise<BackgroundAgentNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for notification")),
      timeoutMs,
    );
    manager.once("notification", (notification) => {
      clearTimeout(timer);
      resolve(notification);
    });
  });
}

/**
 * Wait for N notifications.
 */
function waitForNotifications(
  manager: BackgroundAgentManager,
  count: number,
  timeoutMs = 5000,
): Promise<BackgroundAgentNotification[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for notifications")),
      timeoutMs,
    );
    const collected: BackgroundAgentNotification[] = [];
    const handler = (notification: BackgroundAgentNotification) => {
      collected.push(notification);
      if (collected.length >= count) {
        clearTimeout(timer);
        manager.off("notification", handler);
        resolve(collected);
      }
    };
    manager.on("notification", handler);
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("BackgroundAgentManager", () => {
  let manager: BackgroundAgentManager;

  beforeEach(() => {
    manager = new BackgroundAgentManager();
  });

  // --------------------------------------------------------------------------
  // launch + completion
  // --------------------------------------------------------------------------

  describe("launch", () => {
    it("returns the agent ID immediately", () => {
      const engine = createEngine(createMockProvider());
      const id = manager.launch("bg-1", engine, "Do a task");
      expect(id).toBe("bg-1");
    });

    it("sets initial status to running", () => {
      const engine = createEngine(createHangingProvider());
      manager.launch("bg-2", engine, "Run forever");

      const info = manager.get("bg-2");
      expect(info).toBeDefined();
      expect(info!.status).toBe("running");
      expect(info!.prompt).toBe("Run forever");
      expect(info!.startedAt).toBeInstanceOf(Date);

      // Clean up
      manager.stop("bg-2");
    });

    it("completes and sets result after engine finishes", async () => {
      const engine = createEngine(createMockProvider("Hello from background"));
      manager.launch("bg-3", engine, "Say hello");

      const notification = await waitForNotification(manager);

      expect(notification.agentId).toBe("bg-3");
      expect(notification.status).toBe("completed");
      expect(notification.result).toContain("Hello from background");
      expect(notification.duration).toBeGreaterThanOrEqual(0);

      const info = manager.get("bg-3");
      expect(info!.status).toBe("completed");
      expect(info!.result).toContain("Hello from background");
      expect(info!.completedAt).toBeInstanceOf(Date);
    });

    it("generates a UUID when agentId is empty", () => {
      const engine = createEngine(createMockProvider());
      const id = manager.launch("", engine, "task");
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // notification on completion
  // --------------------------------------------------------------------------

  describe("notification on completion", () => {
    it("emits a notification event when agent completes", async () => {
      const engine = createEngine(createMockProvider("done"));
      manager.launch("notify-1", engine, "task");

      const notification = await waitForNotification(manager);

      expect(notification.agentId).toBe("notify-1");
      expect(notification.status).toBe("completed");
      expect(notification.result).toContain("done");
      expect(typeof notification.duration).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // notification on error
  // --------------------------------------------------------------------------

  describe("notification on error", () => {
    it("emits a notification event when agent errors", async () => {
      const engine = createEngine(createErrorProvider("Kaboom"));
      manager.launch("err-1", engine, "fail");

      const notification = await waitForNotification(manager);

      expect(notification.agentId).toBe("err-1");
      expect(notification.status).toBe("error");
      expect(notification.error).toContain("Kaboom");

      const info = manager.get("err-1");
      expect(info!.status).toBe("error");
      expect(info!.error).toContain("Kaboom");
      expect(info!.completedAt).toBeInstanceOf(Date);
    });
  });

  // --------------------------------------------------------------------------
  // stop
  // --------------------------------------------------------------------------

  describe("stop", () => {
    it("stops a running agent and sets status to stopped", async () => {
      const engine = createEngine(createHangingProvider());
      manager.launch("stop-1", engine, "hang forever");

      // Give the engine a moment to start
      await new Promise((r) => setTimeout(r, 20));

      expect(manager.get("stop-1")!.status).toBe("running");

      manager.stop("stop-1");

      const info = manager.get("stop-1");
      expect(info!.status).toBe("stopped");
      expect(info!.completedAt).toBeInstanceOf(Date);
    });

    it("emits a notification when agent is stopped", async () => {
      const engine = createEngine(createHangingProvider());
      manager.launch("stop-2", engine, "hang");

      await new Promise((r) => setTimeout(r, 20));

      const notificationPromise = waitForNotification(manager);
      manager.stop("stop-2");

      const notification = await notificationPromise;
      expect(notification.agentId).toBe("stop-2");
      expect(notification.status).toBe("stopped");
    });

    it("is a no-op for nonexistent agent", () => {
      expect(() => manager.stop("nonexistent")).not.toThrow();
    });

    it("is a no-op for already completed agent", async () => {
      const engine = createEngine(createMockProvider("done"));
      manager.launch("stop-3", engine, "task");

      await waitForNotification(manager);

      // Agent is now completed; stop should not change anything
      manager.stop("stop-3");
      expect(manager.get("stop-3")!.status).toBe("completed");
    });
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  describe("list", () => {
    it("returns all agents when no filter is given", async () => {
      const engine1 = createEngine(createMockProvider("res1"));
      const engine2 = createEngine(createHangingProvider());

      manager.launch("list-1", engine1, "task1");
      manager.launch("list-2", engine2, "task2");

      // Wait for the first one to complete
      await waitForNotification(manager);

      const all = manager.list();
      expect(all).toHaveLength(2);

      // Clean up
      manager.stop("list-2");
    });

    it("filters by status", async () => {
      const engine1 = createEngine(createMockProvider("res1"));
      const engine2 = createEngine(createHangingProvider());

      manager.launch("filter-1", engine1, "task1");
      manager.launch("filter-2", engine2, "task2");

      await waitForNotification(manager);

      const completed = manager.list("completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe("filter-1");

      const running = manager.list("running");
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("filter-2");

      // Clean up
      manager.stop("filter-2");
    });

    it("returns empty array when no agents exist", () => {
      expect(manager.list()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  describe("get", () => {
    it("returns agent info for a known agent", () => {
      const engine = createEngine(createHangingProvider());
      manager.launch("get-1", engine, "task");

      const info = manager.get("get-1");
      expect(info).toBeDefined();
      expect(info!.id).toBe("get-1");
      expect(info!.prompt).toBe("task");

      manager.stop("get-1");
    });

    it("returns undefined for an unknown agent", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getEvents
  // --------------------------------------------------------------------------

  describe("getEvents", () => {
    it("returns collected events after agent completes", async () => {
      const engine = createEngine(createMockProvider("event test"));
      manager.launch("events-1", engine, "task");

      await waitForNotification(manager);

      const events = manager.getEvents("events-1");
      expect(events.length).toBeGreaterThan(0);

      const types = events.map((e) => e.type);
      expect(types).toContain("turn_start");
      expect(types).toContain("text");
      expect(types).toContain("done");
    });

    it("returns empty array for unknown agent", () => {
      expect(manager.getEvents("nonexistent")).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // prune
  // --------------------------------------------------------------------------

  describe("prune", () => {
    it("removes completed and errored agents", async () => {
      const engine1 = createEngine(createMockProvider("done1"));
      const engine2 = createEngine(createErrorProvider("fail"));
      const engine3 = createEngine(createHangingProvider());

      manager.launch("prune-1", engine1, "task1");
      manager.launch("prune-2", engine2, "task2");
      manager.launch("prune-3", engine3, "task3");

      // Wait for both completable agents to finish
      await waitForNotifications(manager, 2);

      expect(manager.list()).toHaveLength(3);

      const pruned = manager.prune();
      expect(pruned).toBe(2); // completed + errored

      const remaining = manager.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("prune-3");

      // Clean up
      manager.stop("prune-3");
    });

    it("also prunes stopped agents", async () => {
      const engine = createEngine(createHangingProvider());
      manager.launch("prune-stop", engine, "task");

      await new Promise((r) => setTimeout(r, 20));
      manager.stop("prune-stop");

      const pruned = manager.prune();
      expect(pruned).toBe(1);
      expect(manager.list()).toHaveLength(0);
    });

    it("returns 0 when nothing to prune", () => {
      expect(manager.prune()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // concurrent launches
  // --------------------------------------------------------------------------

  describe("concurrent launches", () => {
    it("handles multiple agents running concurrently", async () => {
      const engine1 = createEngine(createMockProvider("Result A"));
      const engine2 = createEngine(createMockProvider("Result B"));
      const engine3 = createEngine(createMockProvider("Result C"));

      manager.launch("conc-1", engine1, "task A");
      manager.launch("conc-2", engine2, "task B");
      manager.launch("conc-3", engine3, "task C");

      const notifications = await waitForNotifications(manager, 3);

      expect(notifications).toHaveLength(3);

      const ids = notifications.map((n) => n.agentId).sort();
      expect(ids).toEqual(["conc-1", "conc-2", "conc-3"]);

      // All should be completed
      for (const n of notifications) {
        expect(n.status).toBe("completed");
      }

      // Verify individual results
      expect(manager.get("conc-1")!.result).toContain("Result A");
      expect(manager.get("conc-2")!.result).toContain("Result B");
      expect(manager.get("conc-3")!.result).toContain("Result C");
    });
  });
});
