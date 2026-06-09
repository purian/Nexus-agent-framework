/**
 * Nexus Runner — long-running daemon that wires:
 *   - NexusEngine (with Anthropic provider + built-in tools)
 *   - TelegramAdapter (long-polling, allowlist-gated)
 *   - TaskScheduler (cron task: daily briefing pushed to Telegram)
 *
 * Designed to run under launchd. Reads config from config.json (editable),
 * secrets from environment (set by start.sh from ~/.nexus/secrets.env).
 */

import {
  NexusEngine,
  AnthropicProvider,
  PermissionManager,
  TaskScheduler,
  createPlatform,
  createDefaultTools,
  type IncomingMessage,
  type NexusConfig,
  type PlatformAdapter,
  type PermissionMode,
} from "nexus-agent";

// SchedulerEvent isn't re-exported from nexus-agent's index, so re-declare locally.
type SchedulerEvent =
  | { type: "task_triggered"; taskId: string; taskName: string }
  | { type: "task_completed"; taskId: string; taskName: string; durationMs: number }
  | { type: "task_error"; taskId: string; taskName: string; error: string }
  | { type: "task_skipped"; taskId: string; taskName: string; reason: string };
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { ReminderManager, type Reminder } from "./reminders.js";
import { MissionControlLogger } from "./mission-control.js";
import { ConversationMemory } from "./conversation-memory.js";
import { ControlCenter, extractControls, type ControlResult } from "./control.js";

const execFileAsync = promisify(execFile);

/**
 * Run a child process with stdin explicitly closed (so the child doesn't hang
 * waiting for input). Returns stdout + stderr + exit code. Used for `claude -p`
 * which otherwise emits a "no stdin data received in 3s" warning + may hang.
 */
function runWithClosedStdin(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;

    // CRITICAL: close child stdin so it doesn't wait for input
    proc.stdin.end();

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > maxBuffer) {
        killed = true;
        proc.kill("SIGKILL");
        rejectP(new Error(`stdout exceeded maxBuffer (${maxBuffer})`));
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
        rejectP(new Error(`timeout after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!killed) rejectP(err);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) return;
      resolveP({ stdout, stderr, code: code ?? -1 });
    });
  });
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// Config path resolution:
//   1. NEXUS_RUNNER_CONFIG env var (used when bundled+deployed to ~/.nexus/runner)
//   2. config.json sibling of the bundled .mjs (deployed mode)
//   3. ../config.json relative to dist/ (dev mode)
const CONFIG_PATH = process.env.NEXUS_RUNNER_CONFIG
  ?? (existsSync(resolve(__dirname, "config.json")) ? resolve(__dirname, "config.json") : resolve(ROOT, "config.json"));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
type BackendName = "claude-code" | "nexus";

interface RunnerConfig {
  backend: BackendName;
  claudeCode: {
    model: string;
    permissionMode: string;
    maxBudgetUsdPerMessage: number;
    timeoutSeconds: number;
    extraArgs: string[];
  };
  nexus: {
    model: string;
    permissionMode: PermissionMode;
    maxBudgetUsdPerSession: number;
    maxTurnsPerMessage: number;
  };
  schedule: {
    briefingCron: string | null;
    briefingCommand: string;
  };
  allowlist: {
    users: number[];
    groups: number[];
    pendingGroups: number[];
  };
  telegram: {
    pollIntervalMs: number;
  };
  _configPath?: string;  // absolute path to config.json (set by loader)
  whisper: {
    enabled: boolean;
    command: string;
    model: string;
    extraArgs: string[];
  };
}

function loadRunnerConfig(): RunnerConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return {
    _configPath: CONFIG_PATH,
    backend: (raw.backend ?? "claude-code") as BackendName,
    claudeCode: {
      model: raw.claudeCode?.model ?? "sonnet",
      permissionMode: raw.claudeCode?.permissionMode ?? "bypassPermissions",
      maxBudgetUsdPerMessage: raw.claudeCode?.maxBudgetUsdPerMessage ?? 0.5,
      timeoutSeconds: raw.claudeCode?.timeoutSeconds ?? 300,
      extraArgs: raw.claudeCode?.extraArgs ?? [],
    },
    nexus: {
      model: raw.nexus?.model ?? "claude-sonnet-4-6",
      permissionMode: (raw.nexus?.permissionMode ?? "allowAll") as PermissionMode,
      maxBudgetUsdPerSession: raw.nexus?.maxBudgetUsdPerSession ?? 1.0,
      maxTurnsPerMessage: raw.nexus?.maxTurnsPerMessage ?? 30,
    },
    schedule: {
      briefingCron: raw.schedule?.briefingCron ?? null,
      briefingCommand: raw.schedule?.briefingCommand ?? "",
    },
    allowlist: {
      users: raw.allowlist?.users ?? [],
      groups: raw.allowlist?.groups ?? [],
      pendingGroups: raw.allowlist?.pendingGroups ?? [],
    },
    telegram: {
      pollIntervalMs: raw.telegram?.pollIntervalMs ?? 1000,
    },
    whisper: {
      enabled: raw.whisper?.enabled ?? true,
      command: raw.whisper?.command ?? "whisper",
      model: raw.whisper?.model ?? "base",
      extraArgs: raw.whisper?.extraArgs ?? [],
    },
  };
}

function saveRunnerConfig(cfg: RunnerConfig): void {
  // Round-trip preserving the _comment fields and structure
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  raw.allowlist = {
    ...raw.allowlist,
    users: cfg.allowlist.users,
    groups: cfg.allowlist.groups,
    pendingGroups: cfg.allowlist.pendingGroups,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
type AllowDecision =
  | { allowed: true }
  | { allowed: false; reason: string; pendingGroupAdded?: number };

function checkAllowlist(msg: IncomingMessage, cfg: RunnerConfig): AllowDecision {
  const chatId = Number(msg.chatId);
  const userId = Number(msg.userId);
  const isGroup = chatId < 0;

  if (isGroup) {
    const groupApproved = cfg.allowlist.groups.includes(chatId);
    const userApproved = cfg.allowlist.users.includes(userId);
    if (groupApproved && userApproved) return { allowed: true };
    if (!groupApproved) {
      // Track unknown group so user can review
      let added: number | undefined;
      if (!cfg.allowlist.pendingGroups.includes(chatId)) {
        cfg.allowlist.pendingGroups.push(chatId);
        added = chatId;
        try {
          saveRunnerConfig(cfg);
        } catch (e) {
          log("warn", `failed to persist pending group: ${(e as Error).message}`);
        }
      }
      return {
        allowed: false,
        reason: `group ${chatId} not approved (added to pendingGroups)`,
        pendingGroupAdded: added,
      };
    }
    return { allowed: false, reason: `user ${userId} not in allowlist` };
  }

  // 1:1 DM
  if (cfg.allowlist.users.includes(userId)) return { allowed: true };
  return { allowed: false, reason: `user ${userId} not in allowlist` };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
// Write directly to a file via fs.appendFileSync. This bypasses Node's
// stdout buffering (which becomes 4KB-block when stdout is a redirected file
// in nohup/launchd contexts) and gives us guaranteed real-time visibility.
import { appendFileSync } from "node:fs";
const LOG_FILE = process.env.NEXUS_RUNNER_LOG ?? "/tmp/nexus-runner.log";

function log(level: "info" | "warn" | "error", msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${msg}\n`;
  // stderr is line-buffered to terminals; in nohup/launchd it's still mostly OK,
  // but the file write below is the source of truth.
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort: if log file is unwritable, fall back to stdout
  }
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// Backend abstraction
// ---------------------------------------------------------------------------
interface Backend {
  readonly name: BackendName;
  send(chatId: string, prompt: string, extraContext?: string): Promise<{ text: string; error?: Error; metadata?: Record<string, unknown> }>;
  reset(chatId: string): void;
}

// ---- Nexus backend (uses NexusEngine + ANTHROPIC_API_KEY directly) ----
class NexusBackend implements Backend {
  readonly name = "nexus" as const;
  private engines = new Map<string, NexusEngine>();
  constructor(private cfg: RunnerConfig) {}

  private build(): NexusEngine {
    const provider = new AnthropicProvider();
    const nexusConfig: NexusConfig = {
      defaultModel: this.cfg.nexus.model,
      defaultProvider: "anthropic",
      workingDirectory: process.cwd(),
      dataDirectory: process.env.HOME + "/.nexus",
      permissionMode: this.cfg.nexus.permissionMode,
      permissionRules: [],
      mcpServers: [],
      platforms: {},
      plugins: [],
      maxBudgetUsd: this.cfg.nexus.maxBudgetUsdPerSession,
      maxConcurrentTools: 4,
      thinking: { enabled: false, budgetTokens: 5000 },
    };
    const permissions = new PermissionManager(this.cfg.nexus.permissionMode, []);
    const engine = new NexusEngine(provider, nexusConfig, permissions);
    for (const tool of createDefaultTools()) engine.registerTool(tool);
    return engine;
  }

  async send(chatId: string, prompt: string): Promise<{ text: string; error?: Error }> {
    let engine = this.engines.get(chatId);
    if (!engine) {
      engine = this.build();
      this.engines.set(chatId, engine);
    }
    const chunks: string[] = [];
    let error: Error | undefined;
    try {
      for await (const event of engine.run(prompt, { maxTurns: this.cfg.nexus.maxTurnsPerMessage })) {
        if (event.type === "text") chunks.push(event.text);
        else if (event.type === "error") error = event.error;
      }
    } catch (e) {
      error = e as Error;
    }
    return { text: chunks.join("").trim(), error };
  }

  reset(chatId: string): void {
    this.engines.delete(chatId);
  }
}

// ---- Claude Code backend (shells out to `claude` CLI; uses subscription) ----
//
// Session model:
//   - First message in a chat: don't pass --session-id (let claude generate one).
//     We capture session_id from the JSON response and store it.
//   - Subsequent messages: pass --resume <stored-session-id> to continue.
//   - On /reset: delete the stored session id; the next message starts fresh.
//
// Why not --session-id? Because that flag is for *creating* a session with a
// specific UUID — it errors with "Session ID is already in use" if you call
// it twice with the same UUID. --resume is the correct flag for continuation.
class ClaudeCodeBackend implements Backend {
  readonly name = "claude-code" as const;
  // chatId -> claude session UUID (only set after the first successful message).
  // Persisted to disk so conversation continuity survives runner restarts.
  private sessions = new Map<string, string>();
  private readonly sessionsPath: string;

  constructor(private cfg: RunnerConfig) {
    this.sessionsPath = resolve(dirname(cfg._configPath ?? ""), "sessions.json");
    this.loadSessions();
  }

  private loadSessions(): void {
    try {
      if (existsSync(this.sessionsPath)) {
        const data = JSON.parse(readFileSync(this.sessionsPath, "utf-8")) as Record<string, string>;
        this.sessions = new Map(Object.entries(data));
      }
    } catch {
      // Corrupt/unreadable file: start fresh rather than crash.
      this.sessions = new Map();
    }
  }

  private saveSessions(): void {
    try {
      writeFileSync(this.sessionsPath, JSON.stringify(Object.fromEntries(this.sessions), null, 2) + "\n", "utf-8");
    } catch {
      // Non-fatal: in-memory map still works for this process lifetime.
    }
  }

  async send(chatId: string, prompt: string, extraContext?: string): Promise<{ text: string; error?: Error; metadata?: Record<string, unknown> }> {
    const existingSid = this.sessions.get(chatId);

    // Load system prompt and inject current time so Claude can compute reminder timestamps.
    const systemPromptPath = resolve(dirname(this.cfg._configPath ?? ""), "system-prompt.md");
    let systemPrompt = "";
    if (existsSync(systemPromptPath)) {
      systemPrompt = readFileSync(systemPromptPath, "utf-8");
    }
    const now = new Date();
    const timeContext = `\n\nCurrent date/time: ${now.toLocaleDateString("en-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Jerusalem" })} ${now.toLocaleTimeString("en-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem", hour12: false })} (Asia/Jerusalem)`;
    systemPrompt += timeContext;
    if (extraContext) systemPrompt += extraContext;

    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", this.cfg.claudeCode.permissionMode,
      "--model", this.cfg.claudeCode.model,
      "--max-budget-usd", String(this.cfg.claudeCode.maxBudgetUsdPerMessage),
    ];

    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }

    if (existingSid) {
      args.push("--resume", existingSid);
    }

    args.push(...this.cfg.claudeCode.extraArgs);
    args.push(prompt);

    // Strip ANTHROPIC_API_KEY so claude uses OAuth/subscription auth, not pay-per-token API.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    try {
      const { stdout, stderr, code } = await runWithClosedStdin("claude", args, {
        env,
        timeoutMs: this.cfg.claudeCode.timeoutSeconds * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (code !== 0 && !stdout.trim()) {
        return {
          text: "",
          error: new Error(`claude exited with code ${code}: ${stderr.trim().slice(0, 500) || "(no stderr)"}`),
        };
      }

      // claude -p --output-format json emits a single JSON object on stdout
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Sometimes claude prints stream chunks; fall back to raw stdout
        return { text: stdout.trim(), error: undefined, metadata: { stderr: stderr || undefined, parseFallback: true } };
      }

      const text = String(parsed.result ?? "").trim();
      const isError = Boolean(parsed.is_error);

      // Always pin the session_id from the response — this is the canonical
      // session for this chat going forward.
      const respSid = parsed.session_id;
      if (typeof respSid === "string" && this.sessions.get(chatId) !== respSid) {
        this.sessions.set(chatId, respSid);
        this.saveSessions();
      }

      return {
        text: text || "(no response)",
        error: isError ? new Error(text || `claude returned an error (stderr: ${stderr?.slice(0, 300) || "none"})`) : undefined,
        metadata: {
          session_id: parsed.session_id,
          model: Object.keys((parsed.modelUsage as Record<string, unknown>) ?? {})[0],
          informational_cost_usd: parsed.total_cost_usd,
          num_turns: parsed.num_turns,
        },
      };
    } catch (e) {
      return { text: "", error: e as Error };
    }
  }

  reset(chatId: string): void {
    if (this.sessions.delete(chatId)) {
      this.saveSessions();
    }
  }
}

function buildBackend(cfg: RunnerConfig): Backend {
  if (cfg.backend === "claude-code") return new ClaudeCodeBackend(cfg);
  if (cfg.backend === "nexus") return new NexusBackend(cfg);
  throw new Error(`Unknown backend: ${cfg.backend}`);
}

// ---------------------------------------------------------------------------
// Local Whisper transcription
// ---------------------------------------------------------------------------
async function transcribeVoice(
  audioData: Buffer,
  mimeType: string,
  cfg: RunnerConfig,
): Promise<string> {
  const ext = mimeType.includes("ogg") ? ".ogg" : mimeType.includes("mp4") ? ".mp4" : ".ogg";
  const tmpDir = mkdtempSync(resolve(tmpdir(), "whisper-"));
  const audioPath = resolve(tmpDir, `audio${ext}`);
  try {
    fsWriteFileSync(audioPath, audioData);
    const { stdout } = await execFileAsync(cfg.whisper.command, [
      audioPath,
      "--model", cfg.whisper.model,
      "--output_format", "txt",
      "--output_dir", tmpDir,
      ...cfg.whisper.extraArgs,
    ]);
    // whisper writes a .txt file alongside the audio file
    const txtPath = audioPath.replace(/\.[^.]+$/, ".txt");
    if (existsSync(txtPath)) {
      return readFileSync(txtPath, "utf-8").trim();
    }
    return stdout.trim();
  } finally {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Telegram message length limit (4096 chars). Chunk longer responses.
// ---------------------------------------------------------------------------
const TG_MAX = 4000;
function chunkMessage(text: string): string[] {
  if (text.length <= TG_MAX) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + TG_MAX, text.length);
    if (end < text.length) {
      // try to break on a newline
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + TG_MAX / 2) end = nl;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reminder block parser — extracts <reminder>...</reminder> from Claude's response
// ---------------------------------------------------------------------------
interface ParsedReminder {
  time: string;
  message: string;
  recurring?: string;
}

function extractReminders(response: string): { cleaned: string; reminders: ParsedReminder[] } {
  const reminders: ParsedReminder[] = [];
  const cleaned = response.replace(/<reminder>([\s\S]*?)<\/reminder>/g, (_match, json) => {
    try {
      const parsed = JSON.parse(json.trim());
      if (parsed.time && parsed.message) {
        reminders.push({
          time: parsed.time,
          message: parsed.message,
          recurring: parsed.recurring ?? null,
        });
      }
    } catch {
      log("warn", `failed to parse reminder JSON: ${json.trim().slice(0, 100)}`);
    }
    return ""; // strip the block from the user-visible response
  });
  return { cleaned: cleaned.trim(), reminders };
}

// ---------------------------------------------------------------------------
// Slash commands handled directly (don't reach the LLM)
// ---------------------------------------------------------------------------
async function handleSlashCommand(
  text: string,
  msg: IncomingMessage,
  telegram: PlatformAdapter,
  backend: Backend,
  cfg: RunnerConfig,
  reminderMgr: ReminderManager,
  control: ControlCenter,
  pendingConfirm: Map<string, { action: string; args: Record<string, unknown> }>,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const actor = msg.userId || "user";

  // Run a control action; if it needs confirmation, stash it and ask.
  const runControl = async (action: string, args: Record<string, unknown>) => {
    const r = control.execute(actor, action, args);
    if (r.needsConfirmation) {
      pendingConfirm.set(msg.chatId, { action, args });
      await telegram.sendMessage(msg.chatId, `⚠️ This will ${r.message}. Reply "yes" to confirm or "no" to cancel.`);
    } else {
      for (const chunk of chunkMessage(r.message)) await telegram.sendMessage(msg.chatId, chunk);
    }
  };

  switch (cmd) {
    case "start":
    case "help":
      await telegram.sendMessage(
        msg.chatId,
        [
          "Nexus personal assistant online.",
          "",
          "Commands:",
          "/briefing — run the daily project briefing now",
          "/schedule briefing HH:MM | off — set or disable the morning briefing",
          "/status — show config & health",
          "/set model <name> | budget <usd> — change a setting",
          "/pause · /resume — do-not-disturb on/off",
          "/logs [N] — show recent log lines",
          "/allowlist add|remove <userId>",
          "/restart — restart the bot",
          "/sessions — list background dev sessions",
          "/reminders — list active reminders",
          "/reset — clear this conversation's history",
          "/whoami — show your user / chat IDs",
          "/help — this message",
          "",
          "You can also just ask in plain language, e.g. \"stop the morning briefing\".",
        ].join("\n"),
      );
      return true;

    case "status":
      await runControl("status", {});
      return true;

    case "schedule": {
      // /schedule briefing 08:00  |  /schedule briefing off
      const what = (rest[0] || "").toLowerCase();
      if (what !== "briefing") {
        await telegram.sendMessage(msg.chatId, "Usage: /schedule briefing HH:MM  (or /schedule briefing off)");
        return true;
      }
      await runControl("set_schedule", { value: rest[1] ?? "" });
      return true;
    }

    case "set": {
      const key = (rest[0] || "").toLowerCase();
      const value = rest.slice(1).join(" ");
      if (!key || !value) {
        await telegram.sendMessage(msg.chatId, "Usage: /set model <name>  |  /set budget <usd>");
        return true;
      }
      await runControl("set", { key, value });
      return true;
    }

    case "pause":
      await runControl("pause", {});
      return true;

    case "resume":
      await runControl("resume", {});
      return true;

    case "logs":
      await runControl("logs", { lines: Number(rest[0]) || 30 });
      return true;

    case "allowlist": {
      const op = (rest[0] || "").toLowerCase();
      const id = rest[1];
      if (op !== "add" && op !== "remove") {
        await telegram.sendMessage(msg.chatId, "Usage: /allowlist add <userId>  |  /allowlist remove <userId>");
        return true;
      }
      await runControl(op === "add" ? "allowlist_add" : "allowlist_remove", { id });
      return true;
    }

    case "restart":
      await runControl("restart", {});
      return true;

    case "whoami":
      await telegram.sendMessage(
        msg.chatId,
        `userId: ${msg.userId}\nchatId: ${msg.chatId}\nallowed: yes`,
      );
      return true;

    case "reset":
      backend.reset(msg.chatId);
      await telegram.sendMessage(msg.chatId, "Conversation history cleared.");
      return true;

    case "briefing":
      try {
        const { stdout } = await execFileAsync("/bin/sh", ["-c", cfg.schedule.briefingCommand], {
          maxBuffer: 1024 * 1024,
        });
        const out = stdout.trim() || "(empty briefing)";
        for (const chunk of chunkMessage(out)) {
          await telegram.sendMessage(msg.chatId, chunk);
        }
      } catch (e) {
        await telegram.sendMessage(msg.chatId, `Briefing failed: ${(e as Error).message}`);
      }
      return true;

    case "sessions": {
      try {
        const { stdout } = await execFileAsync("/bin/bash", ["-c",
          `for f in ~/.nexus/dev-sessions/*.status; do [ -f "$f" ] || continue; id=$(basename "$f" .status); status=$(cat "$f"); echo "$id: $status"; done`
        ]);
        const out = stdout.trim() || "No dev sessions found.";
        await telegram.sendMessage(msg.chatId, `Dev Sessions:\n\n${out}`);
      } catch (e) {
        await telegram.sendMessage(msg.chatId, "No dev sessions found.");
      }
      return true;
    }

    case "reminders": {
      const upcoming = reminderMgr.list();
      if (!upcoming.length) {
        await telegram.sendMessage(msg.chatId, "No active reminders.");
      } else {
        const lines = upcoming.map((r) => {
          const due = new Date(r.dueAt);
          const dateStr = due.toLocaleDateString("en-IL", { weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Jerusalem" });
          const timeStr = due.toLocaleTimeString("en-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem", hour12: false });
          const rec = r.recurring ? ` (${r.recurring})` : "";
          return `${dateStr} ${timeStr} — ${r.message}${rec}  [${r.id}]`;
        });
        await telegram.sendMessage(msg.chatId, `Active reminders (${upcoming.length}):\n\n${lines.join("\n")}`);
      }
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Daily briefing scheduled task
// ---------------------------------------------------------------------------
async function runScheduledBriefing(
  telegram: PlatformAdapter,
  cfg: RunnerConfig,
): Promise<void> {
  log("info", "scheduled briefing firing");
  let output: string;
  try {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", cfg.schedule.briefingCommand], {
      maxBuffer: 1024 * 1024,
    });
    output = stdout.trim() || "(empty briefing)";
  } catch (e) {
    output = `Briefing failed: ${(e as Error).message}`;
  }

  // Send to every allowlisted user (DMs only — not pushed to groups)
  for (const userId of cfg.allowlist.users) {
    try {
      for (const chunk of chunkMessage(output)) {
        await telegram.sendMessage(String(userId), chunk);
      }
    } catch (e) {
      log("error", `failed to send briefing to ${userId}: ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cfg = loadRunnerConfig();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log("error", "TELEGRAM_BOT_TOKEN not set in environment. Aborting.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log("error", "ANTHROPIC_API_KEY not set in environment. Aborting.");
    process.exit(1);
  }

  if (cfg.backend === "claude-code") {
    log("info", `loaded config: backend=claude-code model=${cfg.claudeCode.model} budget=$${cfg.claudeCode.maxBudgetUsdPerMessage}/msg`);
  } else {
    log("info", `loaded config: backend=nexus model=${cfg.nexus.model} mode=${cfg.nexus.permissionMode} budget=$${cfg.nexus.maxBudgetUsdPerSession}/session`);
  }
  log("info", `allowlist: ${cfg.allowlist.users.length} user(s), ${cfg.allowlist.groups.length} group(s)`);
  if (cfg.allowlist.users.length === 0) {
    log("warn", "allowlist.users is empty — nobody can talk to the bot. Edit config.json and add your user ID.");
  }

  const telegram = createPlatform("telegram") as PlatformAdapter;
  await telegram.connect({ token, pollingInterval: cfg.telegram.pollIntervalMs });
  log("info", "telegram connected");

  const backend = buildBackend(cfg);
  log("info", `backend: ${backend.name}`);

  // Runtime control state.
  let paused = false;
  // chatId -> a pending risky control action awaiting "yes" confirmation.
  const pendingConfirm = new Map<string, { action: string; args: Record<string, unknown> }>();

  // Mission Control message logging (fire-and-forget observability).
  const mcLogger = new MissionControlLogger(log);
  log("info", `mission-control logging: ${mcLogger.enabled ? "enabled" : "disabled"}`);

  // Persistent cross-session conversation memory (keyword recall).
  const convMemory = new ConversationMemory(resolve(dirname(CONFIG_PATH), "conversations.json"));

  // ------- Reminders -------
  const remindersPath = resolve(dirname(CONFIG_PATH), "reminders.json");
  const reminderMgr = new ReminderManager(remindersPath);
  reminderMgr.startChecker(30_000, async (reminder: Reminder) => {
    log("info", `reminder due: "${reminder.message}" (id=${reminder.id})`);
    for (const userId of cfg.allowlist.users) {
      try {
        await telegram.sendMessage(String(userId), `⏰ Reminder: ${reminder.message}`);
      } catch (e) {
        log("error", `failed to send reminder to ${userId}: ${(e as Error).message}`);
      }
    }
  });
  log("info", `reminders loaded: ${reminderMgr.list().length} active`);

  telegram.onMessage(async (msg: IncomingMessage) => {
    log("info", `incoming: chat=${msg.chatId} user=${msg.userId} text=${(msg.text ?? "").slice(0, 60)}`);

    const decision = checkAllowlist(msg, cfg);
    if (!decision.allowed) {
      log("warn", `dropped: ${decision.reason}`);
      // For DMs from unknown users, send a friendly notice once.
      if (Number(msg.chatId) > 0) {
        try {
          await telegram.sendMessage(
            msg.chatId,
            `Not authorized. Your user ID is ${msg.userId}. Ask Eli to add it to the allowlist.`,
          );
        } catch {}
      }
      return;
    }

    let text = msg.text ?? "";

    // Transcribe voice messages using local Whisper.
    // IMPORTANT: prefer local whisper over Telegram's server-side transcription
    // (which is often poor — e.g., reduces a 20s message to "We"). If a voice
    // attachment is present, transcribe it locally regardless of whether `text`
    // is already set by Telegram.
    const voiceAttachment = msg.attachments?.find(
      (a: { type: string; url: string; data?: Buffer }) => a.type === "voice",
    );
    if (cfg.whisper.enabled && voiceAttachment?.data) {
      const tgTranscript = (msg.metadata?.telegramTranscript as string | null) ?? null;
      try {
        const mimeType = (msg.metadata?.mimeType as string | undefined) ?? "audio/ogg";
        log("info", `transcribing voice message (${voiceAttachment.data.length} bytes, model=${cfg.whisper.model})${tgTranscript ? ` [tg-transcript=${JSON.stringify(tgTranscript.slice(0, 40))}]` : ""}`);
        text = await transcribeVoice(voiceAttachment.data, mimeType, cfg);
        log("info", `transcript: ${text.slice(0, 80)}`);
      } catch (e) {
        log("error", `whisper transcription failed: ${(e as Error).message}`);
        // If whisper failed but we have Telegram's transcription, fall back to it
        // rather than dropping the message entirely.
        if (tgTranscript) {
          log("warn", `falling back to Telegram transcript`);
          text = tgTranscript;
        } else {
          await telegram.sendMessage(msg.chatId, `Voice transcription failed: ${(e as Error).message}`);
          return;
        }
      }
    }

    // Handle document attachments (CSV, PDF, etc.) by saving to a temp file
    // so Claude Code can read it
    const documentAttachment = msg.attachments?.find(
      (a: { type: string; url: string; data?: Buffer }) => a.type === "document",
    );
    if (documentAttachment?.data) {
      const fileName = (msg.metadata?.fileName as string | undefined) ?? "document";
      const fileSize = (msg.metadata?.fileSize as number | undefined) ?? documentAttachment.data.length;
      log("info", `received document: ${fileName} (${fileSize} bytes)`);

      try {
        // Save to temp file
        const tmpDir = mkdtempSync(`${tmpdir()}/nexus-doc-`);
        const tmpPath = `${tmpDir}/${fileName}`;
        fsWriteFileSync(tmpPath, documentAttachment.data);
        log("info", `saved document to ${tmpPath}`);

        // Prepend file info to the text
        if (!text) {
          text = `I received a file: ${fileName} (${fileSize} bytes). Please read and analyze it.`;
        }
        text = `[File attached: ${tmpPath}]\n\n${text}`;
      } catch (e) {
        log("error", `failed to save document: ${(e as Error).message}`);
        await telegram.sendMessage(msg.chatId, `Failed to process document: ${(e as Error).message}`);
        return;
      }
    }

    if (!text) return;

    // If a risky control action is awaiting confirmation, interpret yes/no here.
    const pending = pendingConfirm.get(msg.chatId);
    if (pending) {
      const t = text.trim().toLowerCase();
      const yes = ["yes", "y", "confirm", "כן", "ok", "אישור"].includes(t);
      const no = ["no", "n", "cancel", "לא", "ביטול"].includes(t);
      if (yes || no) {
        pendingConfirm.delete(msg.chatId);
        if (no) { await telegram.sendMessage(msg.chatId, "Cancelled."); return; }
        const r = control.execute(msg.userId || "user", pending.action, pending.args, true);
        await telegram.sendMessage(msg.chatId, r.message);
        return;
      }
      // Any other message cancels the pending confirmation and proceeds normally.
      pendingConfirm.delete(msg.chatId);
    }

    if (await handleSlashCommand(text, msg, telegram, backend, cfg, reminderMgr, control, pendingConfirm)) return;

    // Do-not-disturb: stay online but don't process messages (allow /resume through above).
    if (paused) {
      log("info", `paused — ignoring message from ${msg.chatId}`);
      return;
    }

    // Show "typing..." indicator and send acknowledgment while processing
    const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || "";
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (botToken) {
      const sendTyping = () => {
        fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: msg.chatId, action: "typing" }),
        }).catch(() => {});
      };
      sendTyping();
      typingInterval = setInterval(sendTyping, 4000);

      // Send acknowledgment for long messages (>100 chars suggest complex requests)
      if (text.length > 100) {
        try {
          await telegram.sendMessage(msg.chatId, "⏳ Processing your request...");
        } catch {}
      }
    }

    // Fire-and-forget: log this message as a Mission Control task. We hold the
    // promise (not awaited) so we can update it after the reply without ever
    // blocking the conversation on Mission Control availability.
    const mcTaskPromise: Promise<number | null> = mcLogger.enabled
      ? mcLogger.startMessageTask(text).catch(() => null)
      : Promise.resolve(null);

    // Recall relevant past context from earlier sessions and inject it.
    let recalledContext = "";
    try {
      recalledContext = convMemory.recallAndFormat(msg.chatId, text);
      if (recalledContext) log("info", `recalled past context for ${msg.chatId}`);
    } catch (e) {
      log("warn", `conversation recall failed: ${(e as Error).message}`);
    }

    // Route through the configured backend (with retry on failure)
    let response = "";
    let error: Error | undefined;
    let metadata: Record<string, unknown> | undefined;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await backend.send(msg.chatId, text, recalledContext || undefined);
      response = result.text;
      error = result.error;
      metadata = result.metadata;

      if (!error) break;

      log("warn", `backend attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${msg.chatId}: ${error.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Stop typing indicator
    if (typingInterval) clearInterval(typingInterval);

    if (error) {
      log("error", `backend error for ${msg.chatId} (all retries exhausted): ${error.message}`);
      // Reset session to avoid repeating the same error on next message
      backend.reset(msg.chatId);
      log("info", `session reset for ${msg.chatId} after error`);
      void mcTaskPromise.then((id) => {
        if (id !== null) mcLogger.finishMessageTask(id, false, { sessionId: metadata?.session_id });
      });
      try {
        await telegram.sendMessage(msg.chatId, `Error: ${error.message}\n\n(Session reset — next message starts fresh)`);
      } catch {}
      return;
    }

    if (metadata) {
      log("info", `reply ok: ${JSON.stringify(metadata)}`);
    }

    void mcTaskPromise.then((id) => {
      if (id !== null) {
        mcLogger.finishMessageTask(id, true, {
          cost: metadata?.informational_cost_usd,
          turns: metadata?.num_turns,
          model: metadata?.model,
          sessionId: metadata?.session_id,
        });
      }
    });

    // Extract <reminder> blocks from Claude's response and schedule them
    const { cleaned: noReminders, reminders: parsedReminders } = extractReminders(response);
    for (const pr of parsedReminders) {
      const r = reminderMgr.add(pr.message, pr.time, "voice", pr.recurring ?? null);
      const dueDate = new Date(pr.time);
      const friendlyTime = dueDate.toLocaleTimeString("en-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem", hour12: false });
      const friendlyDate = dueDate.toLocaleDateString("en-IL", { weekday: "short", month: "short", day: "numeric", timeZone: "Asia/Jerusalem" });
      log("info", `reminder created: id=${r.id} "${r.message}" at ${pr.time}`);
    }

    // Extract <control> blocks the LLM emitted and execute them (with confirmation
    // for risky ones). Append the outcome so the user sees what happened.
    const { cleaned, controls } = extractControls(noReminders);
    const controlNotes: string[] = [];
    for (const c of controls) {
      const r = control.execute(msg.userId || "user", c.action, c.args);
      if (r.needsConfirmation) {
        pendingConfirm.set(msg.chatId, { action: c.action, args: c.args });
        controlNotes.push(`⚠️ This will ${r.message}. Reply "yes" to confirm or "no" to cancel.`);
      } else {
        controlNotes.push(r.message);
      }
    }

    let reply = (parsedReminders.length > 0 || controls.length > 0 ? cleaned : response) || "";
    if (controlNotes.length) reply = (reply ? reply + "\n\n" : "") + controlNotes.join("\n");
    if (!reply) reply = "(no response)";

    // Persist this exchange for future cross-session recall.
    try {
      convMemory.add(msg.chatId, text, reply);
    } catch (e) {
      log("warn", `conversation store failed: ${(e as Error).message}`);
    }

    for (const chunk of chunkMessage(reply)) {
      try {
        await telegram.sendMessage(msg.chatId, chunk);
      } catch (e) {
        log("error", `send failed: ${(e as Error).message}`);
      }
    }
  });

  // ------- Scheduler (restartable at runtime via ControlCenter) -------
  let scheduler: TaskScheduler | null = null;
  const applyBriefingSchedule = (cron: string | null) => {
    try { scheduler?.stop(); } catch {}
    scheduler = null;
    if (!cron) {
      log("info", "scheduler disabled (briefingCron is null)");
      return;
    }
    scheduler = new TaskScheduler({
      enabled: true,
      tasks: [
        { name: "daily-briefing", schedule: cron, prompt: "(handled directly)", enabled: true, maxConcurrent: 1 },
      ],
    });
    scheduler.on("event", async (e: SchedulerEvent) => {
      if (e.type === "task_triggered" && e.taskName === "daily-briefing") {
        const startedAt = Date.now();
        try {
          await runScheduledBriefing(telegram, cfg);
          scheduler!.completeTask(e.taskId, Date.now() - startedAt);
        } catch (err) {
          scheduler!.errorTask(e.taskId, (err as Error).message);
        }
      }
    });
    scheduler.start();
    log("info", `scheduler started: briefing cron='${cron}'`);
  };
  applyBriefingSchedule(cfg.schedule.briefingCron);

  // ------- Control center (bot self-configuration) -------
  const startedAt = Date.now();
  const control = new ControlCenter(cfg as never, {
    applyBriefingSchedule,
    setPaused: (p) => { paused = p; },
    isPaused: () => paused,
    tailLog: (n) => {
      try {
        const logFile = process.env.NEXUS_RUNNER_LOG || resolve(dirname(CONFIG_PATH), "runner.log");
        const lines = readFileSync(logFile, "utf-8").trimEnd().split("\n");
        return lines.slice(-n).join("\n") || "(log empty)";
      } catch (e) {
        return `(could not read log: ${(e as Error).message})`;
      }
    },
    restart: () => {
      // launchd KeepAlive respawns us on exit; kickstart guarantees a clean cycle.
      try {
        spawn("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/com.eli.nexus-runner`], { detached: true, stdio: "ignore" }).unref();
      } catch { /* fall through to exit */ }
      setTimeout(() => process.exit(0), 500);
    },
    uptimeSeconds: () => Math.floor((Date.now() - startedAt) / 1000),
  }, log);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, shutting down`);
    try { scheduler?.stop(); } catch {}
    try { reminderMgr.stopChecker(); } catch {}
    try { await telegram.disconnect(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log("info", "runner is live. Waiting for messages.");
}

main().catch((err) => {
  log("error", `fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
