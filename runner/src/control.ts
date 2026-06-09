// ControlCenter: a safe, whitelisted surface for the bot to reconfigure itself
// at runtime — driven either by slash commands or by <control> blocks the LLM
// emits. Each action validates input, applies live where possible, persists to
// config.json, and writes an audit line. Actions flagged `risky` require an
// explicit confirmation before they run.
//
// This sits ALONGSIDE the bot's general bash access: common operations go
// through here (so confirmation + audit + live-apply actually work); anything
// novel still falls back to the LLM running shell commands directly.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export interface ControlResult {
  ok: boolean;
  message: string;
  /** When true, the caller must confirm before this is applied. */
  needsConfirmation?: boolean;
  /** True if applying this requires a process restart. */
  needsRestart?: boolean;
}

// Hooks the runner provides so ControlCenter can apply changes to live objects.
export interface ControlHooks {
  /** Reschedule (or disable) the daily briefing live. cron=null disables. */
  applyBriefingSchedule: (cron: string | null) => void;
  /** Toggle do-not-disturb (bot stays online but stops replying). */
  setPaused: (paused: boolean) => void;
  isPaused: () => boolean;
  /** Read recent runner log lines. */
  tailLog: (lines: number) => string;
  /** Self-restart via launchd. */
  restart: () => void;
  /** Snapshot for /status. */
  uptimeSeconds: () => number;
}

interface AnyConfig {
  _configPath?: string;
  backend: string;
  claudeCode: { model: string; maxBudgetUsdPerMessage: number; [k: string]: unknown };
  schedule: { briefingCron: string | null; [k: string]: unknown };
  allowlist: { users: number[]; groups: number[]; pendingGroups: number[] };
  [k: string]: unknown;
}

// "HH:MM" -> cron "M H * * *". Returns null for "off"/"none"/"null"/"disable".
export function timeToCron(value: string): string | null | undefined {
  const v = value.trim().toLowerCase();
  if (["off", "none", "null", "disable", "disabled", "stop"].includes(v)) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return undefined; // invalid
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${min} ${h} * * *`;
}

export function cronToTime(cron: string | null): string {
  if (!cron) return "off";
  const parts = cron.split(/\s+/);
  if (parts.length >= 2) {
    const min = parts[0].padStart(2, "0");
    const h = parts[1].padStart(2, "0");
    if (/^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) return `${h}:${min}`;
  }
  return cron;
}

export class ControlCenter {
  private auditPath: string;

  constructor(
    private cfg: AnyConfig,
    private hooks: ControlHooks,
    private log: Logger,
  ) {
    this.auditPath = resolve(dirname(cfg._configPath ?? ""), "control-audit.log");
  }

  private audit(actor: string, action: string, detail: string): void {
    const line = `${new Date().toISOString()}\t${actor}\t${action}\t${detail}\n`;
    try { appendFileSync(this.auditPath, line); } catch { /* non-fatal */ }
    this.log("info", `control: ${actor} ${action} ${detail}`);
  }

  // Persist the full mutable config back to disk, preserving comments/structure.
  private persist(): void {
    const path = this.cfg._configPath;
    if (!path || !existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.backend = this.cfg.backend;
    raw.claudeCode = { ...raw.claudeCode, model: this.cfg.claudeCode.model, maxBudgetUsdPerMessage: this.cfg.claudeCode.maxBudgetUsdPerMessage };
    raw.schedule = { ...raw.schedule, briefingCron: this.cfg.schedule.briefingCron };
    raw.allowlist = { ...raw.allowlist, users: this.cfg.allowlist.users, groups: this.cfg.allowlist.groups, pendingGroups: this.cfg.allowlist.pendingGroups };
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  }

  // Which actions need a confirmation before applying.
  isRisky(action: string, args: Record<string, unknown> = {}): boolean {
    if (action === "restart") return true;
    if (action === "allowlist_add" || action === "allowlist_remove") return true;
    if (action === "set" && args.key === "budget") {
      const next = Number(args.value);
      // Raising the per-message budget is risky; lowering it isn't.
      return Number.isFinite(next) && next > this.cfg.claudeCode.maxBudgetUsdPerMessage;
    }
    return false;
  }

  // Execute a control action. `confirmed` must be true for risky actions.
  execute(actor: string, action: string, args: Record<string, unknown>, confirmed = false): ControlResult {
    if (this.isRisky(action, args) && !confirmed) {
      return { ok: false, needsConfirmation: true, message: this.describe(action, args) };
    }
    try {
      switch (action) {
        case "status":
          return { ok: true, message: this.status() };

        case "set_schedule": {
          const cron = args.cron === undefined ? timeToCron(String(args.value ?? "")) : (args.cron as string | null);
          if (cron === undefined) return { ok: false, message: "Invalid time. Use HH:MM (e.g. 08:00) or 'off'." };
          this.cfg.schedule.briefingCron = cron;
          this.hooks.applyBriefingSchedule(cron);
          this.persist();
          this.audit(actor, "set_schedule", `briefing=${cron ?? "off"}`);
          return { ok: true, message: cron ? `Daily briefing scheduled for ${cronToTime(cron)}.` : "Daily briefing disabled." };
        }

        case "set": {
          const key = String(args.key);
          const value = args.value;
          return this.setKey(actor, key, value);
        }

        case "pause":
          this.hooks.setPaused(true);
          this.audit(actor, "pause", "");
          return { ok: true, message: "Paused (do-not-disturb). I'll stay online but won't reply until you /resume." };

        case "resume":
          this.hooks.setPaused(false);
          this.audit(actor, "resume", "");
          return { ok: true, message: "Resumed. I'm listening again." };

        case "logs": {
          const n = Math.min(Math.max(Number(args.lines ?? 30), 1), 200);
          return { ok: true, message: this.hooks.tailLog(n) };
        }

        case "allowlist_add":
        case "allowlist_remove": {
          const id = Number(args.id);
          if (!Number.isFinite(id)) return { ok: false, message: "Provide a numeric user id." };
          const users = this.cfg.allowlist.users;
          if (action === "allowlist_add") {
            if (!users.includes(id)) users.push(id);
          } else {
            const i = users.indexOf(id);
            if (i >= 0) users.splice(i, 1);
          }
          this.persist();
          this.audit(actor, action, String(id));
          return { ok: true, message: `Allowlist updated. Users: ${users.join(", ")}` };
        }

        case "restart":
          this.audit(actor, "restart", "");
          // Reply first, then restart shortly after so the message is delivered.
          setTimeout(() => this.hooks.restart(), 1500);
          return { ok: true, message: "Restarting now — back in a few seconds." };

        default:
          return { ok: false, message: `Unknown control action: ${action}` };
      }
    } catch (e) {
      return { ok: false, message: `Control error: ${(e as Error).message}` };
    }
  }

  private setKey(actor: string, key: string, value: unknown): ControlResult {
    switch (key) {
      case "model": {
        const v = String(value);
        this.cfg.claudeCode.model = v;
        this.persist();
        this.audit(actor, "set", `model=${v}`);
        return { ok: true, message: `Model set to "${v}". Applies to your next message.` };
      }
      case "budget": {
        const v = Number(value);
        if (!Number.isFinite(v) || v <= 0) return { ok: false, message: "Budget must be a positive number (USD)." };
        this.cfg.claudeCode.maxBudgetUsdPerMessage = v;
        this.persist();
        this.audit(actor, "set", `budget=${v}`);
        return { ok: true, message: `Per-message budget set to $${v}.` };
      }
      default:
        return { ok: false, message: `"${key}" is not a settable key. Try: model, budget. (For other changes, ask me and I'll do it directly.)` };
    }
  }

  describe(action: string, args: Record<string, unknown>): string {
    if (action === "restart") return "restart the bot";
    if (action === "allowlist_add") return `allow user ${args.id} to talk to the bot`;
    if (action === "allowlist_remove") return `remove user ${args.id} from the allowlist`;
    if (action === "set" && args.key === "budget") return `raise the per-message budget to $${args.value}`;
    return `${action} ${JSON.stringify(args)}`;
  }

  status(): string {
    const up = this.hooks.uptimeSeconds();
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    return [
      "Nexus status",
      `• uptime: ${h}h ${m}m`,
      `• backend: ${this.cfg.backend} (model ${this.cfg.claudeCode.model})`,
      `• budget: $${this.cfg.claudeCode.maxBudgetUsdPerMessage}/msg`,
      `• briefing: ${this.cfg.schedule.briefingCron ? cronToTime(this.cfg.schedule.briefingCron) : "off"}`,
      `• paused: ${this.hooks.isPaused() ? "yes (do-not-disturb)" : "no"}`,
      `• allowlist: ${this.cfg.allowlist.users.length} user(s)`,
    ].join("\n");
  }
}

// Extract <control>{...}</control> blocks from an LLM reply. Returns the cleaned
// text (blocks removed) and the parsed actions.
export function extractControls(text: string): { cleaned: string; controls: Array<{ action: string; args: Record<string, unknown> }> } {
  const controls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const cleaned = text.replace(/<control>\s*([\s\S]*?)\s*<\/control>/g, (_m, json) => {
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj.action === "string") {
        const { action, ...args } = obj;
        controls.push({ action, args });
      }
    } catch { /* ignore malformed */ }
    return "";
  }).trim();
  return { cleaned, controls };
}
