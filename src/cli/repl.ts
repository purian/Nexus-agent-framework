import * as readline from "node:readline";
import chalk from "chalk";
import type { NexusEngine } from "../core/engine.js";
import type { Plan } from "../core/plan-mode.js";
import type { BackgroundAgentManager } from "../agents/background.js";
import type { EngineEvent, PermissionDecision, TokenUsage } from "../types/index.js";

// ============================================================================
// REPL State
// ============================================================================

interface ReplState {
  engine: NexusEngine;
  rl: readline.Interface;
  sessionUsage: TokenUsage;
  turnCount: number;
  aborted: boolean;
  backgroundManager?: BackgroundAgentManager;
}

// ============================================================================
// Event Rendering
// ============================================================================

function renderEvent(event: EngineEvent, state: ReplState): void {
  switch (event.type) {
    case "turn_start":
      // Subtle separator between turns (only after the first)
      if (event.turnNumber > 1) {
        process.stdout.write(chalk.dim("\n--- turn " + event.turnNumber + " ---\n\n"));
      }
      break;

    case "text":
      process.stdout.write(event.text);
      break;

    case "thinking":
      process.stdout.write(chalk.dim.italic(event.text));
      break;

    case "tool_start":
      process.stdout.write(
        "\n" +
          chalk.blue("[Tool: " + event.toolName + "]") +
          chalk.dim(" " + summarizeInput(event.input)) +
          "\n",
      );
      break;

    case "tool_progress":
      process.stdout.write(
        chalk.dim("  " + event.progress.message) +
          (event.progress.percent !== undefined
            ? chalk.dim(` (${event.progress.percent}%)`)
            : "") +
          "\n",
      );
      break;

    case "tool_end":
      if (event.isError) {
        process.stdout.write(chalk.red("  Error: " + truncate(event.result, 200)) + "\n");
      } else {
        process.stdout.write(
          chalk.green("  Done") +
            chalk.dim(" (" + truncate(event.result, 120) + ")") +
            "\n",
        );
      }
      break;

    case "turn_end":
      state.sessionUsage.inputTokens += event.usage.inputTokens;
      state.sessionUsage.outputTokens += event.usage.outputTokens;
      state.sessionUsage.cacheReadTokens =
        (state.sessionUsage.cacheReadTokens ?? 0) +
        (event.usage.cacheReadTokens ?? 0);
      state.sessionUsage.cacheWriteTokens =
        (state.sessionUsage.cacheWriteTokens ?? 0) +
        (event.usage.cacheWriteTokens ?? 0);
      state.turnCount++;
      break;

    case "error":
      process.stderr.write(chalk.red("\nError: " + event.error.message) + "\n");
      break;

    case "done":
      process.stdout.write("\n");
      showTurnUsage(event.totalUsage);
      break;

    case "plan_action_intercepted":
      process.stdout.write(
        chalk.magenta("  [Plan] Queued: ") +
          chalk.bold(event.toolName) +
          chalk.dim(" — " + truncate(event.description, 80)) +
          "\n",
      );
      break;

    case "plan_created":
      process.stdout.write(
        "\n" +
          chalk.magenta.bold("Plan created") +
          chalk.dim(` (${event.actionCount} action${event.actionCount === 1 ? "" : "s"})`) +
          "\n" +
          chalk.dim("Use /plan show to review, /plan approve to approve, /plan execute to run.") +
          "\n",
      );
      break;

    // permission_request is handled separately via the engine event emitter
    default:
      break;
  }
}

function showTurnUsage(usage: TokenUsage): void {
  const parts = [
    chalk.dim(`tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`),
  ];
  if (usage.cacheReadTokens) {
    parts.push(chalk.dim(`cache-read: ${usage.cacheReadTokens}`));
  }
  process.stdout.write(parts.join("  ") + "\n");
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  // Show the first value as a summary, truncated
  const [key, value] = entries[0];
  const strVal = typeof value === "string" ? value : JSON.stringify(value);
  return `${key}=${truncate(strVal, 60)}`;
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, " ");
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

// ============================================================================
// Permission Prompt
// ============================================================================

/**
 * Wire up the engine's permission_request events so we can prompt the user.
 * We listen via the EventEmitter interface on the engine.
 */
function setupPermissionHandler(state: ReplState): void {
  state.engine.on("event", async (event: EngineEvent) => {
    if (event.type !== "permission_request") return;

    const { toolName, input, resolve } = event;

    process.stdout.write(
      "\n" +
        chalk.yellow("Permission required: ") +
        chalk.bold(toolName) +
        "\n" +
        chalk.dim(JSON.stringify(input, null, 2).slice(0, 300)) +
        "\n",
    );

    const answer = await askYesNo(state.rl, "Allow this action? (y/n) ");
    const decision: PermissionDecision = answer
      ? { behavior: "allow" }
      : { behavior: "deny", reason: "User denied permission" };

    resolve(decision);
  });
}

function askYesNo(rl: readline.Interface, prompt: string): Promise<boolean> {
  return new Promise((res) => {
    rl.question(prompt, (answer) => {
      const normalized = answer.trim().toLowerCase();
      res(normalized === "y" || normalized === "yes");
    });
  });
}

// ============================================================================
// Slash Commands
// ============================================================================

function handleSlashCommand(line: string, state: ReplState): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return false;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case "/quit":
    case "/exit":
      state.aborted = true;
      state.rl.close();
      return true;

    case "/reset":
      state.engine.reset();
      state.sessionUsage = { inputTokens: 0, outputTokens: 0 };
      state.turnCount = 0;
      process.stdout.write(chalk.yellow("Conversation reset.\n"));
      return true;

    case "/tools": {
      const tools = state.engine.getTools();
      if (tools.length === 0) {
        process.stdout.write(chalk.dim("No tools registered.\n"));
      } else {
        process.stdout.write(chalk.bold("Registered tools:\n"));
        for (const tool of tools) {
          process.stdout.write(
            "  " + chalk.cyan(tool.name) + chalk.dim(" - " + tool.description) + "\n",
          );
        }
      }
      return true;
    }

    case "/usage":
      process.stdout.write(chalk.bold("Session usage:\n"));
      process.stdout.write(
        `  Input tokens:  ${state.sessionUsage.inputTokens}\n` +
          `  Output tokens: ${state.sessionUsage.outputTokens}\n` +
          `  Turns:         ${state.turnCount}\n`,
      );
      return true;

    case "/plan":
      handlePlanCommand(parts.slice(1), state);
      return true;

    case "/bg":
      handleBgCommand(parts.slice(1), state);
      return true;

    case "/help":
      process.stdout.write(
        chalk.bold("Commands:\n") +
          "  /quit, /exit          Exit the REPL\n" +
          "  /reset                Clear conversation history\n" +
          "  /tools                List registered tools\n" +
          "  /usage                Show token usage stats\n" +
          "  /plan [subcommand]    Plan mode controls\n" +
          "  /bg [subcommand]      Background agent controls\n" +
          "  /help                 Show this help\n",
      );
      return true;

    default:
      process.stdout.write(chalk.red(`Unknown command: ${cmd}\n`));
      return true;
  }
}

// ============================================================================
// Plan Commands
// ============================================================================

function handlePlanCommand(args: string[], state: ReplState): void {
  const sub = args[0] ?? "";
  const engine = state.engine;
  const executor = engine.getPlanExecutor();

  switch (sub) {
    case "":
    case "on":
      engine.enterPlanMode();
      process.stdout.write(
        chalk.magenta.bold("Plan mode ON") +
          chalk.dim(" — write actions will be queued for review instead of executed.") +
          "\n",
      );
      break;

    case "off":
      engine.exitPlanMode();
      process.stdout.write(chalk.yellow("Plan mode OFF") + "\n");
      break;

    case "status":
      process.stdout.write(
        "Plan mode: " +
          (engine.isPlanMode() ? chalk.magenta.bold("ON") : chalk.dim("OFF")) +
          "\n",
      );
      break;

    case "show": {
      const plans = executor.getPlans().filter((p) => p.status === "pending" || p.status === "partial");
      if (plans.length === 0) {
        process.stdout.write(chalk.dim("No pending plans.\n"));
        break;
      }
      for (const plan of plans) {
        renderPlan(plan);
      }
      break;
    }

    case "approve": {
      const planId = args[1];
      const actionId = args[2];
      const plans = executor.getPlans().filter((p) => p.status === "pending" || p.status === "partial");

      if (plans.length === 0) {
        process.stdout.write(chalk.dim("No pending plans to approve.\n"));
        break;
      }

      const target = planId ? executor.getPlan(planId) : plans[plans.length - 1];
      if (!target) {
        process.stdout.write(chalk.red("Plan not found.\n"));
        break;
      }

      if (actionId) {
        executor.approveAction(target.id, actionId);
        process.stdout.write(chalk.green(`Action ${actionId.slice(0, 8)} approved.\n`));
      } else {
        executor.approvePlan(target.id);
        process.stdout.write(chalk.green(`Plan approved (${target.actions.length} actions).\n`));
      }
      break;
    }

    case "reject": {
      const planId = args[1];
      const actionId = args[2];
      const plans = executor.getPlans().filter((p) => p.status === "pending" || p.status === "partial");

      if (plans.length === 0) {
        process.stdout.write(chalk.dim("No pending plans to reject.\n"));
        break;
      }

      const target = planId ? executor.getPlan(planId) : plans[plans.length - 1];
      if (!target) {
        process.stdout.write(chalk.red("Plan not found.\n"));
        break;
      }

      if (actionId) {
        executor.rejectAction(target.id, actionId);
        process.stdout.write(chalk.red(`Action ${actionId.slice(0, 8)} rejected.\n`));
      } else {
        executor.rejectPlan(target.id);
        process.stdout.write(chalk.red(`Plan rejected.\n`));
      }
      break;
    }

    case "execute": {
      const plans = executor.getPlans().filter(
        (p) => p.status === "approved" || p.status === "partial",
      );
      if (plans.length === 0) {
        process.stdout.write(chalk.dim("No approved plans to execute. Use /plan approve first.\n"));
        break;
      }

      const target = args[1] ? executor.getPlan(args[1]) : plans[plans.length - 1];
      if (!target) {
        process.stdout.write(chalk.red("Plan not found.\n"));
        break;
      }

      // Execute asynchronously and render events
      executePlanAsync(target.id, state);
      break;
    }

    case "yes": {
      // Shortcut: approve + execute the latest pending plan in one step
      const pendingPlans = executor.getPlans().filter(
        (p) => p.status === "pending" || p.status === "partial",
      );
      if (pendingPlans.length === 0) {
        process.stdout.write(chalk.dim("No pending plans.\n"));
        break;
      }

      const target = args[1] ? executor.getPlan(args[1]) : pendingPlans[pendingPlans.length - 1];
      if (!target) {
        process.stdout.write(chalk.red("Plan not found.\n"));
        break;
      }

      executor.approvePlan(target.id);
      process.stdout.write(
        chalk.green(`Plan approved (${target.actions.length} actions).`) + "\n",
      );
      executePlanAsync(target.id, state);
      break;
    }

    default:
      process.stdout.write(
        chalk.bold("Plan commands:\n") +
          "  /plan             Enter plan mode (alias: /plan on)\n" +
          "  /plan off         Exit plan mode\n" +
          "  /plan status      Show plan mode status\n" +
          "  /plan show        Show pending plans with previews\n" +
          "  /plan approve     Approve latest plan (or /plan approve <planId> [actionId])\n" +
          "  /plan reject      Reject latest plan (or /plan reject <planId> [actionId])\n" +
          "  /plan execute     Execute latest approved plan\n" +
          "  /plan yes         Approve and execute latest plan in one step\n",
      );
      break;
  }
}

// ============================================================================
// Background Agent Commands
// ============================================================================

function handleBgCommand(args: string[], state: ReplState): void {
  const sub = args[0] ?? "";
  const bgManager = state.backgroundManager;

  if (!bgManager) {
    process.stdout.write(chalk.dim("Background agent manager not available.\n"));
    return;
  }

  switch (sub) {
    case "":
    case "list": {
      const agents = bgManager.list();
      if (agents.length === 0) {
        process.stdout.write(chalk.dim("No background agents.\n"));
        break;
      }
      process.stdout.write(chalk.bold("Background agents:\n"));
      for (const agent of agents) {
        const statusColor =
          agent.status === "completed"
            ? chalk.green
            : agent.status === "error"
              ? chalk.red
              : agent.status === "stopped"
                ? chalk.yellow
                : chalk.cyan;

        const elapsed = agent.completedAt
          ? agent.completedAt.getTime() - agent.startedAt.getTime()
          : Date.now() - agent.startedAt.getTime();
        const elapsedStr = (elapsed / 1000).toFixed(1) + "s";

        process.stdout.write(
          "  " +
            chalk.dim(agent.id.slice(0, 8)) +
            " " +
            statusColor(`[${agent.status}]`) +
            chalk.dim(` (${elapsedStr})`) +
            chalk.dim(" — " + truncate(agent.prompt, 60)) +
            "\n",
        );
      }
      break;
    }

    case "show": {
      const agentId = args[1];
      if (!agentId) {
        process.stdout.write(chalk.red("Usage: /bg show <id>\n"));
        break;
      }

      // Find agent by full ID or prefix
      const agents = bgManager.list();
      const agent = agents.find(
        (a) => a.id === agentId || a.id.startsWith(agentId),
      );

      if (!agent) {
        process.stdout.write(chalk.red(`Background agent "${agentId}" not found.\n`));
        break;
      }

      const statusColor =
        agent.status === "completed"
          ? chalk.green
          : agent.status === "error"
            ? chalk.red
            : agent.status === "stopped"
              ? chalk.yellow
              : chalk.cyan;

      process.stdout.write(
        "\n" +
          chalk.bold("Agent ") +
          chalk.dim(agent.id.slice(0, 8)) +
          " " +
          statusColor(`[${agent.status}]`) +
          "\n" +
          chalk.dim("  Prompt: ") +
          agent.prompt +
          "\n" +
          chalk.dim("  Started: ") +
          agent.startedAt.toLocaleTimeString() +
          "\n",
      );

      if (agent.completedAt) {
        const duration = agent.completedAt.getTime() - agent.startedAt.getTime();
        process.stdout.write(
          chalk.dim("  Duration: ") + (duration / 1000).toFixed(1) + "s\n",
        );
      }

      if (agent.result) {
        process.stdout.write(
          chalk.dim("  Result: ") + "\n" + agent.result + "\n",
        );
      }

      if (agent.error) {
        process.stdout.write(
          chalk.red("  Error: ") + agent.error + "\n",
        );
      }
      break;
    }

    case "stop": {
      const agentId = args[1];
      if (!agentId) {
        process.stdout.write(chalk.red("Usage: /bg stop <id>\n"));
        break;
      }

      const agents = bgManager.list();
      const agent = agents.find(
        (a) => a.id === agentId || a.id.startsWith(agentId),
      );

      if (!agent) {
        process.stdout.write(chalk.red(`Background agent "${agentId}" not found.\n`));
        break;
      }

      bgManager.stop(agent.id);
      process.stdout.write(chalk.yellow(`Background agent ${agent.id.slice(0, 8)} stopped.\n`));
      break;
    }

    case "prune": {
      const count = bgManager.prune();
      process.stdout.write(
        chalk.dim(`Pruned ${count} completed/errored agent${count === 1 ? "" : "s"}.\n`),
      );
      break;
    }

    default:
      process.stdout.write(
        chalk.bold("Background agent commands:\n") +
          "  /bg               List all background agents (alias: /bg list)\n" +
          "  /bg show <id>     Show details and result of a background agent\n" +
          "  /bg stop <id>     Stop a running background agent\n" +
          "  /bg prune         Clean up completed/errored agents\n",
      );
      break;
  }
}

// ============================================================================
// Background Notification Handler
// ============================================================================

function setupBackgroundNotifications(state: ReplState): void {
  const bgManager = state.backgroundManager;
  if (!bgManager) return;

  bgManager.on("notification", (notification) => {
    const idShort = notification.agentId.slice(0, 8);
    const durationStr = (notification.duration / 1000).toFixed(1) + "s";

    if (notification.status === "completed") {
      const resultPreview = notification.result
        ? truncate(notification.result, 100)
        : "(no output)";
      process.stdout.write(
        "\n" +
          chalk.cyan(`[Background] Agent ${idShort} completed (${durationStr})`) +
          chalk.dim(` — ${resultPreview}`) +
          "\n",
      );
    } else if (notification.status === "error") {
      process.stdout.write(
        "\n" +
          chalk.red(`[Background] Agent ${idShort} failed`) +
          chalk.dim(` — ${notification.error ?? "unknown error"}`) +
          "\n",
      );
    } else if (notification.status === "stopped") {
      process.stdout.write(
        "\n" +
          chalk.yellow(`[Background] Agent ${idShort} stopped (${durationStr})`) +
          "\n",
      );
    }
  });
}

function renderPlan(plan: Plan): void {
  const statusColor =
    plan.status === "approved"
      ? chalk.green
      : plan.status === "rejected"
        ? chalk.red
        : plan.status === "partial"
          ? chalk.yellow
          : chalk.dim;

  process.stdout.write(
    "\n" +
      chalk.bold("Plan ") +
      chalk.dim(plan.id.slice(0, 8)) +
      " " +
      statusColor(`[${plan.status}]`) +
      chalk.dim(` — ${plan.summary}`) +
      "\n",
  );

  for (let i = 0; i < plan.actions.length; i++) {
    const action = plan.actions[i];
    const actionStatus =
      action.status === "approved" || action.status === "executed"
        ? chalk.green("✓")
        : action.status === "rejected"
          ? chalk.red("✗")
          : chalk.dim("○");

    process.stdout.write(
      `  ${actionStatus} ${i + 1}. ` +
        chalk.cyan(action.toolName) +
        chalk.dim(` — ${truncate(action.description, 60)}`) +
        chalk.dim(` [${action.id.slice(0, 8)}]`) +
        "\n",
    );

    // Show diff preview for EditFile actions
    renderActionPreview(action);
  }
}

/**
 * Render a preview of what an action will do. For EditFile actions,
 * shows a diff-style old → new view. For WriteFile, shows a snippet
 * of the content to be written.
 */
function renderActionPreview(action: {
  toolName: string;
  input: Record<string, unknown>;
}): void {
  const input = action.input;

  if (action.toolName === "EditFile" && input.old_string && input.new_string) {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    const oldStr = String(input.old_string);
    const newStr = String(input.new_string);

    process.stdout.write(chalk.dim(`     ${filePath}\n`));

    const oldLines = oldStr.split("\n");
    const newLines = newStr.split("\n");
    const maxPreviewLines = 8;

    for (let j = 0; j < Math.min(oldLines.length, maxPreviewLines); j++) {
      process.stdout.write(chalk.red(`     - ${oldLines[j]}`) + "\n");
    }
    if (oldLines.length > maxPreviewLines) {
      process.stdout.write(chalk.dim(`     ... (${oldLines.length - maxPreviewLines} more lines)\n`));
    }

    for (let j = 0; j < Math.min(newLines.length, maxPreviewLines); j++) {
      process.stdout.write(chalk.green(`     + ${newLines[j]}`) + "\n");
    }
    if (newLines.length > maxPreviewLines) {
      process.stdout.write(chalk.dim(`     ... (${newLines.length - maxPreviewLines} more lines)\n`));
    }
  } else if (action.toolName === "WriteFile" && input.content) {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    const content = String(input.content);
    const lines = content.split("\n");
    const maxPreviewLines = 6;

    process.stdout.write(chalk.dim(`     ${filePath} (new file)\n`));
    for (let j = 0; j < Math.min(lines.length, maxPreviewLines); j++) {
      process.stdout.write(chalk.green(`     + ${lines[j]}`) + "\n");
    }
    if (lines.length > maxPreviewLines) {
      process.stdout.write(chalk.dim(`     ... (${lines.length - maxPreviewLines} more lines)\n`));
    }
  } else if (action.toolName === "Bash" && input.command) {
    process.stdout.write(chalk.dim(`     $ ${truncate(String(input.command), 80)}`) + "\n");
  }
}

async function executePlanAsync(planId: string, state: ReplState): Promise<void> {
  const executor = state.engine.getPlanExecutor();

  process.stdout.write(chalk.magenta.bold("\nExecuting plan...\n"));

  try {
    for await (const event of executor.executePlan(planId, state.engine)) {
      renderEvent(event, state);
    }
    process.stdout.write(chalk.green.bold("Plan execution complete.\n"));
  } catch (err) {
    process.stdout.write(
      chalk.red("Plan execution error: " + (err instanceof Error ? err.message : String(err))) +
        "\n",
    );
  }
}

// ============================================================================
// Main REPL Loop
// ============================================================================

/**
 * Run the interactive REPL. This function returns a promise that resolves
 * when the user exits (/quit or Ctrl+C).
 */
export async function startRepl(
  engine: NexusEngine,
  options?: { systemPrompt?: string; backgroundManager?: BackgroundAgentManager },
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  const state: ReplState = {
    engine,
    rl,
    sessionUsage: { inputTokens: 0, outputTokens: 0 },
    turnCount: 0,
    aborted: false,
    backgroundManager: options?.backgroundManager,
  };

  // Wire up permission handler on the engine's event emitter
  setupPermissionHandler(state);

  // Wire up background agent notification handler
  setupBackgroundNotifications(state);

  // Graceful Ctrl+C handling
  let runningAbortController: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (runningAbortController) {
      // If a run is in progress, abort it
      runningAbortController.abort();
      runningAbortController = null;
      process.stdout.write(chalk.yellow("\nAborted.\n"));
    } else {
      // Otherwise, exit
      process.stdout.write(chalk.dim("\nGoodbye.\n"));
      state.aborted = true;
      rl.close();
    }
  });

  process.stdout.write(
    chalk.bold("Nexus Agent") +
      chalk.dim(" v0.1.0") +
      "\n" +
      chalk.dim('Type /help for commands, or start chatting. Ctrl+C to abort/quit.') +
      "\n\n",
  );

  // Main prompt loop
  const prompt = (): Promise<string> =>
    new Promise((resolve, reject) => {
      rl.question(chalk.green("> "), (answer) => resolve(answer));
      rl.once("close", () => reject(new Error("closed")));
    });

  while (!state.aborted) {
    let input: string;
    try {
      input = await prompt();
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (trimmed === "") continue;

    // Handle slash commands
    if (handleSlashCommand(trimmed, state)) {
      if (state.aborted) break;
      continue;
    }

    // Run the agent loop
    const ac = new AbortController();
    runningAbortController = ac;

    try {
      const stream = engine.run(trimmed, {
        signal: ac.signal,
        systemPrompt: options?.systemPrompt,
      });
      for await (const event of stream) {
        renderEvent(event, state);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        // Already handled by SIGINT handler
      } else {
        process.stderr.write(
          chalk.red(
            "\nFatal error: " +
              (err instanceof Error ? err.message : String(err)),
          ) + "\n",
        );
      }
    } finally {
      runningAbortController = null;
    }
  }

  process.stdout.write(chalk.dim("Session ended.\n"));
}
