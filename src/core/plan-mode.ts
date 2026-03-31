import { randomUUID } from "node:crypto";
import type { EngineEvent, Tool } from "../types/index.js";
import type { NexusEngine } from "./engine.js";

// ============================================================================
// Plan Types
// ============================================================================

export interface Plan {
  id: string;
  status: "pending" | "approved" | "rejected" | "partial";
  actions: PlannedAction[];
  summary: string;
}

export interface PlannedAction {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  status: "pending" | "approved" | "rejected" | "executed";
}

// ============================================================================
// PlanExecutor
// ============================================================================

/**
 * PlanExecutor intercepts write tool calls when plan mode is active,
 * collecting them as proposed actions instead of executing them immediately.
 * Read-only tools execute normally. Plans can then be reviewed, approved
 * (fully or partially), rejected, and finally executed.
 */
export class PlanExecutor {
  private plans: Map<string, Plan> = new Map();

  /**
   * Determine whether a tool call should be intercepted (i.e. collected
   * into a plan rather than executed). A call is intercepted when the
   * tool's `isReadOnly()` method returns false.
   */
  shouldIntercept(tool: Tool, input: Record<string, unknown>): boolean {
    return !tool.isReadOnly(input);
  }

  // --------------------------------------------------------------------------
  // Plan CRUD
  // --------------------------------------------------------------------------

  /**
   * Create a new plan from a set of proposed actions and a human-readable
   * summary. All actions start in "pending" status.
   */
  createPlan(
    actions: Array<{
      toolName: string;
      input: Record<string, unknown>;
      description: string;
    }>,
    summary: string,
  ): Plan {
    const plan: Plan = {
      id: randomUUID(),
      status: "pending",
      summary,
      actions: actions.map((a) => ({
        id: randomUUID(),
        toolName: a.toolName,
        input: a.input,
        description: a.description,
        status: "pending",
      })),
    };

    this.plans.set(plan.id, plan);
    return plan;
  }

  /**
   * Approve every action in a plan.
   */
  approvePlan(planId: string): Plan {
    const plan = this.requirePlan(planId);
    for (const action of plan.actions) {
      if (action.status === "pending") {
        action.status = "approved";
      }
    }
    this.recomputeStatus(plan);
    return plan;
  }

  /**
   * Reject every action in a plan.
   */
  rejectPlan(planId: string): Plan {
    const plan = this.requirePlan(planId);
    for (const action of plan.actions) {
      if (action.status === "pending") {
        action.status = "rejected";
      }
    }
    this.recomputeStatus(plan);
    return plan;
  }

  /**
   * Approve a single action within a plan.
   */
  approveAction(planId: string, actionId: string): PlannedAction {
    const plan = this.requirePlan(planId);
    const action = this.requireAction(plan, actionId);
    action.status = "approved";
    this.recomputeStatus(plan);
    return action;
  }

  /**
   * Reject a single action within a plan.
   */
  rejectAction(planId: string, actionId: string): PlannedAction {
    const plan = this.requirePlan(planId);
    const action = this.requireAction(plan, actionId);
    action.status = "rejected";
    this.recomputeStatus(plan);
    return action;
  }

  /**
   * Execute all approved actions in a plan against the given engine,
   * yielding EngineEvents for each action as it executes.
   */
  async *executePlan(
    planId: string,
    engine: NexusEngine,
  ): AsyncGenerator<EngineEvent> {
    const plan = this.requirePlan(planId);
    const tools = engine.getTools();
    const toolMap = new Map(tools.map((t) => [t.name, t]));

    for (const action of plan.actions) {
      if (action.status !== "approved") continue;

      const tool = toolMap.get(action.toolName);
      if (!tool) {
        yield {
          type: "error",
          error: new Error(
            `Unknown tool "${action.toolName}" in action ${action.id}`,
          ),
        };
        continue;
      }

      yield {
        type: "tool_start",
        toolName: action.toolName,
        toolUseId: action.id,
        input: action.input,
      };

      try {
        const parseResult = tool.inputSchema.safeParse(action.input);
        if (!parseResult.success) {
          throw new Error(`Invalid input: ${parseResult.error.message}`);
        }

        const context = {
          workingDirectory: (engine as any).config.workingDirectory,
          abortSignal: new AbortController().signal,
          permissions: (engine as any).permissions,
          config: (engine as any).config,
        };

        const result = await tool.execute(parseResult.data, context);
        const resultStr =
          typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2);

        action.status = "executed";

        yield {
          type: "tool_end",
          toolUseId: action.id,
          result: resultStr,
          isError: false,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        yield {
          type: "tool_end",
          toolUseId: action.id,
          result: errorMsg,
          isError: true,
        };
      }
    }

    this.recomputeStatus(plan);
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /**
   * Return all plans.
   */
  getPlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  /**
   * Return a plan by id, or undefined if it does not exist.
   */
  getPlan(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private requirePlan(planId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }
    return plan;
  }

  private requireAction(plan: Plan, actionId: string): PlannedAction {
    const action = plan.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new Error(
        `Action ${actionId} not found in plan ${plan.id}`,
      );
    }
    return action;
  }

  /**
   * Recompute a plan's aggregate status from its actions.
   *
   * - All approved/executed → "approved"
   * - All rejected → "rejected"
   * - All pending → "pending"
   * - Otherwise → "partial"
   */
  private recomputeStatus(plan: Plan): void {
    const statuses = new Set(plan.actions.map((a) => a.status));

    if (statuses.size === 0) {
      plan.status = "pending";
      return;
    }

    // "executed" counts as approved for plan-level status.
    const normalised = new Set(
      [...statuses].map((s) => (s === "executed" ? "approved" : s)),
    );

    if (normalised.size === 1) {
      const only = [...normalised][0];
      if (only === "approved") {
        plan.status = "approved";
      } else if (only === "rejected") {
        plan.status = "rejected";
      } else {
        plan.status = "pending";
      }
    } else {
      plan.status = "partial";
    }
  }
}
