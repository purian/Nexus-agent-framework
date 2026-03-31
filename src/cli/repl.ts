import * as readline from "node:readline";
import chalk from "chalk";
import type { NexusEngine } from "../core/engine.js";
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

  const [cmd] = trimmed.split(/\s+/);

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

    case "/help":
      process.stdout.write(
        chalk.bold("Commands:\n") +
          "  /quit, /exit   Exit the REPL\n" +
          "  /reset         Clear conversation history\n" +
          "  /tools         List registered tools\n" +
          "  /usage         Show token usage stats\n" +
          "  /help          Show this help\n",
      );
      return true;

    default:
      process.stdout.write(chalk.red(`Unknown command: ${cmd}\n`));
      return true;
  }
}

// ============================================================================
// Main REPL Loop
// ============================================================================

/**
 * Run the interactive REPL. This function returns a promise that resolves
 * when the user exits (/quit or Ctrl+C).
 */
export async function startRepl(engine: NexusEngine): Promise<void> {
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
  };

  // Wire up permission handler on the engine's event emitter
  setupPermissionHandler(state);

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
      const stream = engine.run(trimmed, { signal: ac.signal });
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
