import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * AuditLogger — logs every tool execution to a JSONL file.
 *
 * Each entry includes: timestamp, tool name, input, output (truncated),
 * permission decision, duration, success/error status, and agent ID.
 */

export interface AuditEntry {
  timestamp: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  output?: string;
  isError: boolean;
  permissionDecision: "allow" | "deny" | "ask";
  durationMs: number;
  agentId?: string;
  sessionId: string;
}

export class AuditLogger {
  private logPath: string;
  private sessionId: string;
  private enabled: boolean;
  private maxOutputChars: number;

  constructor(options: {
    dataDirectory: string;
    sessionId?: string;
    enabled?: boolean;
    maxOutputChars?: number;
  }) {
    this.logPath = join(options.dataDirectory, "audit.jsonl");
    this.sessionId =
      options.sessionId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.enabled = options.enabled ?? true;
    this.maxOutputChars = options.maxOutputChars ?? 1000;

    // Ensure directory exists
    if (this.enabled) {
      const dir = dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Log a tool execution event.
   */
  log(entry: Omit<AuditEntry, "timestamp" | "sessionId">): void {
    if (!this.enabled) return;

    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      output: entry.output
        ? entry.output.length > this.maxOutputChars
          ? entry.output.slice(0, this.maxOutputChars) + "...[truncated]"
          : entry.output
        : undefined,
      // Scrub potentially sensitive input fields
      input: this.scrubSensitive(entry.input),
    };

    try {
      appendFileSync(this.logPath, JSON.stringify(fullEntry) + "\n");
    } catch {
      // Best-effort logging — never crash the agent
    }
  }

  /**
   * Scrub known sensitive fields from input before logging.
   */
  private scrubSensitive(
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const scrubbed = { ...input };
    const sensitivePatterns = [
      "api_key",
      "apikey",
      "token",
      "password",
      "secret",
      "authorization",
    ];
    for (const key of Object.keys(scrubbed)) {
      if (sensitivePatterns.some((s) => key.toLowerCase().includes(s))) {
        scrubbed[key] = "[REDACTED]";
      }
    }
    return scrubbed;
  }

  getLogPath(): string {
    return this.logPath;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
