import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * Slack adapter using Socket Mode (WebSocket) for receiving, Web API for sending.
 */
export class SlackAdapter implements PlatformAdapter {
  name = "slack";
  private appToken = "";
  private botToken = "";
  private ws?: WebSocket;
  private handler?: (message: IncomingMessage) => void;
  private running = false;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.appToken = config.appToken as string;
    this.botToken = config.botToken as string;
    if (!this.appToken) throw new Error("Slack: appToken is required");
    if (!this.botToken) throw new Error("Slack: botToken is required");

    this.running = true;
    await this.connectSocketMode();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.ws?.close(1000);
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: chatId, text: content }),
    });
    if (!res.ok) {
      throw new Error(`Slack sendMessage failed: ${res.status}`);
    }
  }

  private async connectSocketMode(): Promise<void> {
    // Get WebSocket URL via apps.connections.open
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    if (!res.ok) throw new Error(`Slack: failed to open connection (${res.status})`);

    const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      throw new Error(`Slack: ${data.error ?? "failed to get WebSocket URL"}`);
    }

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(data.url!);

      this.ws.onopen = () => resolve();

      this.ws.onmessage = (event: MessageEvent) => {
        const payload = JSON.parse(String(event.data)) as {
          type: string;
          envelope_id?: string;
          payload?: {
            event?: {
              type: string;
              text?: string;
              channel?: string;
              user?: string;
              bot_id?: string;
            };
          };
        };

        // Acknowledge all envelopes
        if (payload.envelope_id) {
          this.ws!.send(JSON.stringify({ envelope_id: payload.envelope_id }));
        }

        // Handle message events
        if (
          payload.type === "events_api" &&
          payload.payload?.event?.type === "message" &&
          !payload.payload.event.bot_id &&
          payload.payload.event.text &&
          this.handler
        ) {
          const evt = payload.payload.event;
          this.handler({
            platform: "slack",
            chatId: evt.channel ?? "",
            userId: evt.user ?? "unknown",
            text: evt.text ?? "",
          });
        }
      };

      this.ws.onerror = () => reject(new Error("Slack: WebSocket error"));
      this.ws.onclose = () => {
        if (this.running) {
          setTimeout(() => this.connectSocketMode(), 5000);
        }
      };
    });
  }
}
