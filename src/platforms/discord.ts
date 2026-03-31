import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * Discord Bot adapter using Gateway WebSocket + REST API.
 */
export class DiscordAdapter implements PlatformAdapter {
  name = "discord";
  private token = "";
  private ws?: WebSocket;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private sequenceNumber: number | null = null;
  private handler?: (message: IncomingMessage) => void;
  private reconnecting = false;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) throw new Error("Discord: token is required");

    const intents = (config.intents as number) ?? (1 << 9) | (1 << 15); // GUILD_MESSAGES | MESSAGE_CONTENT
    await this.connectGateway(intents);
  }

  async disconnect(): Promise<void> {
    this.reconnecting = false;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.ws?.close(1000);
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${chatId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
    );
    if (!res.ok) {
      throw new Error(`Discord sendMessage failed: ${res.status}`);
    }
  }

  private async connectGateway(intents: number): Promise<void> {
    // Get gateway URL
    const res = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.token}` },
    });
    if (!res.ok) throw new Error(`Discord: failed to get gateway (${res.status})`);

    const { url } = (await res.json()) as { url: string };
    this.reconnecting = true;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(`${url}?v=10&encoding=json`);

      this.ws.onmessage = (event: MessageEvent) => {
        const data = JSON.parse(String(event.data)) as {
          op: number;
          d: Record<string, unknown> | null;
          s: number | null;
          t: string | null;
        };

        if (data.s) this.sequenceNumber = data.s;

        switch (data.op) {
          case 10: {
            // Hello — start heartbeat
            const interval = (data.d as Record<string, number>)
              .heartbeat_interval;
            this.heartbeatInterval = setInterval(() => {
              this.ws?.send(JSON.stringify({ op: 1, d: this.sequenceNumber }));
            }, interval);

            // Identify
            this.ws!.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: this.token,
                  intents,
                  properties: {
                    os: "linux",
                    browser: "nexus",
                    device: "nexus",
                  },
                },
              }),
            );
            break;
          }
          case 11:
            // Heartbeat ACK
            break;
          case 0: {
            // Dispatch
            if (data.t === "READY") {
              resolve();
            }
            if (data.t === "MESSAGE_CREATE" && this.handler && data.d) {
              const d = data.d as {
                content: string;
                channel_id: string;
                author: { id: string; bot?: boolean };
              };
              if (d.author.bot) break; // Ignore bot messages
              this.handler({
                platform: "discord",
                chatId: d.channel_id,
                userId: d.author.id,
                text: d.content,
              });
            }
            break;
          }
        }
      };

      this.ws.onerror = () => reject(new Error("Discord: WebSocket error"));
      this.ws.onclose = () => {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.reconnecting) {
          setTimeout(() => this.connectGateway(intents), 5000);
        }
      };
    });
  }
}
