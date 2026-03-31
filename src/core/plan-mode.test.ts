import { describe, it, expect, beforeEach } from "vitest";
import { PlanExecutor } from "./plan-mode.js";
import type { Plan, PlannedAction } from "./plan-mode.js";

// ============================================================================
// Test Helpers
// ============================================================================

function sampleActions() {
  return [
    {
      toolName: "WriteFile",
      input: { file_path: "/tmp/a.txt", content: "hello" },
      description: "Create file a.txt",
    },
    {
      toolName: "EditFile",
      input: { file_path: "/tmp/b.txt", old_string: "x", new_string: "y" },
      description: "Edit file b.txt",
    },
    {
      toolName: "Bash",
      input: { command: "echo done" },
      description: "Run echo command",
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe("PlanExecutor", () => {
  let executor: PlanExecutor;

  beforeEach(() => {
    executor = new PlanExecutor();
  });

  // --------------------------------------------------------------------------
  // createPlan
  // --------------------------------------------------------------------------

  describe("createPlan", () => {
    it("creates a plan with pending actions", () => {
      const plan = executor.createPlan(sampleActions(), "Test plan");

      expect(plan.id).toBeDefined();
      expect(plan.status).toBe("pending");
      expect(plan.summary).toBe("Test plan");
      expect(plan.actions).toHaveLength(3);

      for (const action of plan.actions) {
        expect(action.id).toBeDefined();
        expect(action.status).toBe("pending");
      }

      expect(plan.actions[0].toolName).toBe("WriteFile");
      expect(plan.actions[1].toolName).toBe("EditFile");
      expect(plan.actions[2].toolName).toBe("Bash");
    });

    it("stores the plan for later retrieval", () => {
      const plan = executor.createPlan(sampleActions(), "Test plan");
      expect(executor.getPlan(plan.id)).toBe(plan);
    });
  });

  // --------------------------------------------------------------------------
  // approvePlan
  // --------------------------------------------------------------------------

  describe("approvePlan", () => {
    it("approves all pending actions", () => {
      const plan = executor.createPlan(sampleActions(), "Approve me");
      const approved = executor.approvePlan(plan.id);

      expect(approved.status).toBe("approved");
      for (const action of approved.actions) {
        expect(action.status).toBe("approved");
      }
    });

    it("throws for unknown plan id", () => {
      expect(() => executor.approvePlan("nonexistent")).toThrow(
        "Plan not found",
      );
    });
  });

  // --------------------------------------------------------------------------
  // rejectPlan
  // --------------------------------------------------------------------------

  describe("rejectPlan", () => {
    it("rejects all pending actions", () => {
      const plan = executor.createPlan(sampleActions(), "Reject me");
      const rejected = executor.rejectPlan(plan.id);

      expect(rejected.status).toBe("rejected");
      for (const action of rejected.actions) {
        expect(action.status).toBe("rejected");
      }
    });

    it("throws for unknown plan id", () => {
      expect(() => executor.rejectPlan("nonexistent")).toThrow(
        "Plan not found",
      );
    });
  });

  // --------------------------------------------------------------------------
  // approveAction / rejectAction
  // --------------------------------------------------------------------------

  describe("approveAction", () => {
    it("approves a single action", () => {
      const plan = executor.createPlan(sampleActions(), "Partial");
      const actionId = plan.actions[0].id;

      const action = executor.approveAction(plan.id, actionId);
      expect(action.status).toBe("approved");
      expect(plan.actions[1].status).toBe("pending");
      expect(plan.actions[2].status).toBe("pending");
    });

    it("throws for unknown action id", () => {
      const plan = executor.createPlan(sampleActions(), "Test");
      expect(() => executor.approveAction(plan.id, "bad-id")).toThrow(
        "Action bad-id not found",
      );
    });
  });

  describe("rejectAction", () => {
    it("rejects a single action", () => {
      const plan = executor.createPlan(sampleActions(), "Partial");
      const actionId = plan.actions[1].id;

      const action = executor.rejectAction(plan.id, actionId);
      expect(action.status).toBe("rejected");
      expect(plan.actions[0].status).toBe("pending");
      expect(plan.actions[2].status).toBe("pending");
    });

    it("throws for unknown action id", () => {
      const plan = executor.createPlan(sampleActions(), "Test");
      expect(() => executor.rejectAction(plan.id, "bad-id")).toThrow(
        "Action bad-id not found",
      );
    });
  });

  // --------------------------------------------------------------------------
  // getPlan / getPlans
  // --------------------------------------------------------------------------

  describe("getPlan", () => {
    it("returns plan by id", () => {
      const plan = executor.createPlan(sampleActions(), "Find me");
      expect(executor.getPlan(plan.id)).toBe(plan);
    });

    it("returns undefined for missing plan", () => {
      expect(executor.getPlan("does-not-exist")).toBeUndefined();
    });
  });

  describe("getPlans", () => {
    it("returns all plans", () => {
      executor.createPlan(sampleActions(), "Plan 1");
      executor.createPlan(sampleActions(), "Plan 2");
      executor.createPlan(sampleActions(), "Plan 3");

      const plans = executor.getPlans();
      expect(plans).toHaveLength(3);
      expect(plans.map((p) => p.summary)).toEqual([
        "Plan 1",
        "Plan 2",
        "Plan 3",
      ]);
    });

    it("returns empty array when no plans exist", () => {
      expect(executor.getPlans()).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Plan status logic
  // --------------------------------------------------------------------------

  describe("plan status computation", () => {
    it("is 'approved' when all actions are approved", () => {
      const plan = executor.createPlan(sampleActions(), "All approved");
      executor.approvePlan(plan.id);
      expect(plan.status).toBe("approved");
    });

    it("is 'rejected' when all actions are rejected", () => {
      const plan = executor.createPlan(sampleActions(), "All rejected");
      executor.rejectPlan(plan.id);
      expect(plan.status).toBe("rejected");
    });

    it("is 'partial' when actions have mixed statuses", () => {
      const plan = executor.createPlan(sampleActions(), "Mixed");
      executor.approveAction(plan.id, plan.actions[0].id);
      executor.rejectAction(plan.id, plan.actions[1].id);
      // Third action remains pending.
      expect(plan.status).toBe("partial");
    });

    it("is 'partial' when some are approved and some rejected (no pending)", () => {
      const plan = executor.createPlan(sampleActions(), "Mixed no pending");
      executor.approveAction(plan.id, plan.actions[0].id);
      executor.approveAction(plan.id, plan.actions[1].id);
      executor.rejectAction(plan.id, plan.actions[2].id);
      expect(plan.status).toBe("partial");
    });

    it("is 'pending' when all actions are still pending", () => {
      const plan = executor.createPlan(sampleActions(), "All pending");
      expect(plan.status).toBe("pending");
    });
  });
});
