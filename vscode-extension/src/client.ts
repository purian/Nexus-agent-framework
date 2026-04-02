import WebSocket from "ws";

// ============================================================================
// Types
// ============================================================================

export interface NexusMessage {
  role: string;
  content: string;
  timestamp: Date;
}

// ============================================================================
// NexusClient — Communicates with the Nexus Web UI server
// ============================================================================

export class NexusClient {
  private serverUrl: string;
  private authToken: string;
  private ws?: WebSocket;
  private sessionId?: string;
  private eventHandlers = new Map<string, Array<(data: unknown) => void>>();

  constructor(serverUrl: string, authToken: string) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
    this.authToken = authToken;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Connect to the Nexus server: create a session and open a WebSocket */
  async connect(): Promise<void> {
    // Create a session via REST
    const res = await fetch(`${this.serverUrl}/api/sessions`, {
      method: "POST",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create session: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id: string };
    this.sessionId = data.id;
    this.emit("log", `Session created: ${this.sessionId}`);

    // Open WebSocket connection
    const wsUrl = this.serverUrl.replace(/^http/, "ws");
    this.ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      this.ws!.on("open", () => {
        this.emit("log", "WebSocket connected");
        resolve();
      });

      this.ws!.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          this.emit("event", event);
        } catch {
          this.emit("log", `Received non-JSON message: ${raw.toString()}`);
        }
      });

      this.ws!.on("close", () => {
        this.emit("log", "WebSocket disconnected");
        this.emit("disconnected", undefined);
        this.ws = undefined;
      });

      this.ws!.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  /** Disconnect from the server */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    this.sessionId = undefined;
    this.emit("log", "Disconnected");
  }

  // --------------------------------------------------------------------------
  // API Methods
  // --------------------------------------------------------------------------

  /** Send a user message to the current session */
  async sendMessage(content: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active session — call connect() first");
    }

    const res = await fetch(
      `${this.serverUrl}/api/sessions/${this.sessionId}/messages`,
      {
        method: "POST",
        headers: {
          ...this.getHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to send message: ${res.status} ${text}`);
    }
  }

  /** Check server health */
  async getHealth(): Promise<{ status: string; version: string }> {
    const res = await fetch(`${this.serverUrl}/api/health`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }

    return res.json() as Promise<{ status: string; version: string }>;
  }

  // --------------------------------------------------------------------------
  // Event System
  // --------------------------------------------------------------------------

  on(event: string, handler: (data: unknown) => void): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: string, handler: (data: unknown) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(data);
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }
}
