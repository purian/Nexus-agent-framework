/**
 * Reminder storage + scheduler.
 * Persists to a JSON file. The runner checks every 30s for due reminders.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface Reminder {
  id: string;
  message: string;
  dueAt: string;       // ISO-8601 with timezone
  createdAt: string;    // ISO-8601
  completed: boolean;
  notified: boolean;
  recurring: string | null;  // null = one-time, "daily", "weekly", "monthly"
  source: "voice" | "text" | "web" | "auto";
}

export interface RemindersStore {
  reminders: Reminder[];
}

export class ReminderManager {
  private store: RemindersStore = { reminders: [] };
  private filePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onDue: ((reminder: Reminder) => void) | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      try {
        this.store = JSON.parse(readFileSync(this.filePath, "utf-8"));
      } catch {
        this.store = { reminders: [] };
      }
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.store, null, 2) + "\n", "utf-8");
  }

  add(message: string, dueAt: string, source: Reminder["source"] = "text", recurring: string | null = null): Reminder {
    const reminder: Reminder = {
      id: randomUUID().slice(0, 8),
      message,
      dueAt,
      createdAt: new Date().toISOString(),
      completed: false,
      notified: false,
      recurring,
      source,
    };
    this.store.reminders.push(reminder);
    this.save();
    return reminder;
  }

  remove(id: string): boolean {
    const before = this.store.reminders.length;
    this.store.reminders = this.store.reminders.filter((r) => r.id !== id);
    if (this.store.reminders.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  complete(id: string): boolean {
    const r = this.store.reminders.find((r) => r.id === id);
    if (!r) return false;
    r.completed = true;
    this.save();
    return true;
  }

  list(includeCompleted = false): Reminder[] {
    return this.store.reminders
      .filter((r) => includeCompleted || !r.completed)
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  }

  listUpcoming(hours = 24): Reminder[] {
    const now = Date.now();
    const cutoff = now + hours * 3600_000;
    return this.list().filter((r) => {
      const due = new Date(r.dueAt).getTime();
      return due >= now && due <= cutoff;
    });
  }

  /** Get all reminders (including completed) for the web calendar. */
  all(): Reminder[] {
    return [...this.store.reminders].sort(
      (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
    );
  }

  /** Start checking for due reminders every `intervalMs`. */
  startChecker(intervalMs: number, callback: (reminder: Reminder) => void): void {
    this.onDue = callback;
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stopChecker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private check(): void {
    const now = Date.now();
    for (const r of this.store.reminders) {
      if (r.completed || r.notified) continue;
      const dueTime = new Date(r.dueAt).getTime();
      if (isNaN(dueTime)) continue;
      if (dueTime <= now) {
        r.notified = true;

        // Handle recurring: schedule the next occurrence
        if (r.recurring) {
          const nextDue = this.computeNextOccurrence(r.dueAt, r.recurring);
          if (nextDue) {
            this.add(r.message, nextDue, r.source, r.recurring);
          }
          r.completed = true;
        }

        this.save();
        this.onDue?.(r);
      }
    }
  }

  private computeNextOccurrence(current: string, recurring: string): string | null {
    const d = new Date(current);
    if (isNaN(d.getTime())) return null;
    switch (recurring) {
      case "daily":
        d.setDate(d.getDate() + 1);
        break;
      case "weekly":
        d.setDate(d.getDate() + 7);
        break;
      case "monthly":
        d.setMonth(d.getMonth() + 1);
        break;
      default:
        return null;
    }
    return d.toISOString();
  }

  /** JSON-serializable representation for the web API. */
  toJSON(): RemindersStore {
    return this.store;
  }
}
