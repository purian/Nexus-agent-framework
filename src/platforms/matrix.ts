import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * Matrix protocol adapter using the Client-Server API.
 *
 * Uses long-polling /sync for receiving messages and the
 * send event endpoint for sending. Requires a pre-obtained
 * access token (e.g., from password login or SSO).
 */
export class MatrixAdapter implements PlatformAdapter {
  name = "matrix";
  private homeserver = "";
  private accessToken = "";
  private userId = "";
  private syncToken?: string;
  private running = false;
  private handler?: (message: IncomingMessage) => void;
  private abortController?: AbortController;
  private txnCounter = 0;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.homeserver = (config.homeserver as string)?.replace(/\/+$/, "");
    this.accessToken = config.accessToken as string;
    this.userId = config.userId as string;

    if (!this.homeserver) throw new Error("Matrix: homeserver is required");
    if (!this.accessToken) throw new Error("Matrix: accessToken is required");
    if (!this.userId) throw new Error("Matrix: userId is required");

    // Verify credentials with whoami
    const res = await fetch(this.buildUrl("/_matrix/client/v3/account/whoami"), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Matrix: authentication failed (${res.status})`);
    }

    this.running = true;
    this.abortController = new AbortController();
    this.syncLoop();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const txnId = `nexus_${Date.now()}_${this.txnCounter++}`;
    const res = await fetch(
      this.buildUrl(`/_matrix/client/v3/rooms/${encodeURIComponent(chatId)}/send/m.room.message/${txnId}`),
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          msgtype: "m.text",
          body: content,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Matrix sendMessage failed: ${res.status}`);
    }
  }

  private async syncLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.sync();
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        // Brief pause before retrying on error
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async sync(): Promise<void> {
    const params: Record<string, string> = { timeout: "30000" };
    if (this.syncToken) {
      params.since = this.syncToken;
    }

    const res = await fetch(
      this.buildUrl("/_matrix/client/v3/sync", params),
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: this.abortController?.signal,
      },
    );

    if (!res.ok) {
      throw new Error(`Matrix sync failed: ${res.status}`);
    }

    const data = (await res.json()) as {
      next_batch: string;
      rooms?: {
        join?: Record<string, {
          timeline?: {
            events?: Array<{
              type: string;
              sender: string;
              content: {
                msgtype?: string;
                body?: string;
              };
              event_id: string;
            }>;
          };
        }>;
      };
    };

    // Only process events after we have a sync token (skip initial sync backlog)
    if (this.syncToken && data.rooms?.join) {
      for (const [roomId, room] of Object.entries(data.rooms.join)) {
        const events = room.timeline?.events ?? [];
        for (const event of events) {
          if (
            event.type === "m.room.message" &&
            event.content.msgtype === "m.text" &&
            event.content.body &&
            event.sender !== this.userId &&
            this.handler
          ) {
            this.handler({
              platform: "matrix",
              chatId: roomId,
              userId: event.sender,
              text: event.content.body,
              metadata: { eventId: event.event_id },
            });
          }
        }
      }
    }

    this.syncToken = data.next_batch;
  }

  buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.homeserver);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }
}
