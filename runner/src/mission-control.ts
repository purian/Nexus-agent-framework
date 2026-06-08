// Fire-and-forget logging of each conversation message to the Mission Control
// dashboard (https://tc.purian.uk). Every Telegram message becomes a task that
// moves in_progress -> completed/blocked, annotated with cost/turns/session.
//
// Auth: HTTP basic auth with the `nexus` user (creds in ~/.nexus/secrets.env as
// MC_API_URL / MC_API_USER / MC_API_PASS). The backend API key is injected
// server-side by the proxy; this client never holds it.
//
// Design: NOTHING here may block or break a conversation. Every call is wrapped
// so a Mission Control outage only produces a warning in the runner log.

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

interface McConfig {
  baseUrl: string;
  user: string;
  pass: string;
}

// Keyword -> project name. First match wins; checked against lowercased text.
const PROJECT_KEYWORDS: Array<[RegExp, string]> = [
  [/\bticket(s)?\b|whatsapp/i, "Ticket Bridge"],
  [/\breddit|linkedin|topic monitor|insights\b/i, "Topic Monitor"],
  [/\bnexus\b/i, "Nexus Runner"],
  [/\bmission control|tc\.purian\b/i, "Mission Control"],
  [/\barsenal\b/i, "Arsenal Bot"],
  [/\bsnooker\b/i, "Snooker Scoreboard"],
  [/\bonebeat|onebee\b/i, "OneBee"],
  [/\bbriefing|akamai\b/i, "Akamai Research"],
  [/\binfra|dashboard|docker|deploy|server\b/i, "Infra Dashboard"],
];

const UNCLASSIFIED = "Unclassified";

export class MissionControlLogger {
  private cfg: McConfig | null;
  private projectIdCache = new Map<string, number>();

  constructor(private log: Logger) {
    const baseUrl = process.env.MC_API_URL;
    const user = process.env.MC_API_USER;
    const pass = process.env.MC_API_PASS;
    if (baseUrl && user && pass) {
      this.cfg = { baseUrl: baseUrl.replace(/\/$/, ""), user, pass };
    } else {
      this.cfg = null;
      this.log("warn", "mission-control: MC_API_* env not set; message logging disabled");
    }
  }

  get enabled(): boolean {
    return this.cfg !== null;
  }

  private authHeader(): string {
    const c = this.cfg!;
    return "Basic " + Buffer.from(`${c.user}:${c.pass}`).toString("base64");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 8000,
  ): Promise<unknown | null> {
    if (!this.cfg) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        this.log("warn", `mission-control: ${method} ${path} -> ${res.status}`);
        return null;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      this.log("warn", `mission-control: ${method} ${path} failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pick a project name for a message based on keyword routing. */
  routeProjectName(text: string): string {
    for (const [re, name] of PROJECT_KEYWORDS) {
      if (re.test(text)) return name;
    }
    return UNCLASSIFIED;
  }

  /** Resolve a project name to an id, creating the project if it doesn't exist. */
  private async ensureProjectId(name: string): Promise<number | null> {
    const cached = this.projectIdCache.get(name);
    if (cached !== undefined) return cached;

    const projects = (await this.request("GET", "/projects")) as
      | Array<{ id: number; name: string }>
      | null;
    if (Array.isArray(projects)) {
      const found = projects.find((p) => p.name === name);
      if (found) {
        this.projectIdCache.set(name, found.id);
        return found.id;
      }
    }

    // Not found: create it (only the fallback bucket is auto-created on demand).
    const created = (await this.request("POST", "/projects", {
      name,
      status: "active",
      description:
        name === UNCLASSIFIED
          ? "Auto-created bucket for Nexus messages with no matched project. Triage and reassign."
          : "Auto-created by Nexus runner message logging.",
    })) as { id: number } | null;
    if (created && typeof created.id === "number") {
      this.projectIdCache.set(name, created.id);
      return created.id;
    }
    return null;
  }

  /**
   * Create an in_progress task for an incoming message. Returns the task id,
   * or null if logging failed (caller must tolerate null).
   */
  async startMessageTask(text: string): Promise<number | null> {
    if (!this.cfg) return null;
    const projectName = this.routeProjectName(text);
    const projectId = await this.ensureProjectId(projectName);
    if (projectId === null) return null;

    const title = text.replace(/\s+/g, " ").trim().slice(0, 60) || "(empty message)";
    const created = (await this.request("POST", "/tasks", {
      project_id: projectId,
      title,
      description: text.slice(0, 2000),
      status: "in_progress",
      priority: "medium",
    })) as { id?: number } | null;
    if (created && typeof created.id === "number") return created.id;

    // The Mission Control create endpoint sometimes returns null even on a
    // successful 201 (it can't read back last_insert_rowid). Fall back to
    // finding the just-created task by re-fetching this project's tasks.
    const tasks = (await this.request("GET", `/tasks?project_id=${projectId}`)) as
      | Array<{ id: number; title: string; status: string }>
      | null;
    if (Array.isArray(tasks)) {
      const match = tasks
        .filter((t) => t.title === title && t.status === "in_progress")
        .sort((a, b) => b.id - a.id)[0];
      if (match) return match.id;
    }
    return null;
  }

  /** Mark a message task done (or blocked on error), with run metadata. */
  async finishMessageTask(
    taskId: number,
    ok: boolean,
    meta: { cost?: unknown; turns?: unknown; model?: unknown; sessionId?: unknown },
  ): Promise<void> {
    if (!this.cfg) return;
    const parts: string[] = [];
    if (meta.model) parts.push(`model=${meta.model}`);
    if (meta.turns !== undefined) parts.push(`turns=${meta.turns}`);
    if (meta.cost !== undefined) parts.push(`cost=$${meta.cost}`);
    if (meta.sessionId) parts.push(`session=${meta.sessionId}`);
    await this.request("PUT", `/tasks/${taskId}`, {
      status: ok ? "completed" : "blocked",
      description: parts.join(" · "),
    });
  }
}
