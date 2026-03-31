import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * Telegram Bot adapter using long-polling via the Bot API.
 */
export class TelegramAdapter implements PlatformAdapter {
  name = "telegram";
  private token = "";
  private pollingInterval = 1000;
  private offset = 0;
  private running = false;
  private handler?: (message: IncomingMessage) => void;
  private abortController?: AbortController;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) throw new Error("Telegram: token is required");
    this.pollingInterval = (config.pollingInterval as number) ?? 1000;

    // Verify token
    const res = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
    if (!res.ok) throw new Error(`Telegram: invalid token (${res.status})`);

    this.running = true;
    this.abortController = new AbortController();
    this.poll();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: content }),
      },
    );
    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed: ${res.status}`);
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=30`,
          { signal: this.abortController?.signal },
        );
        if (!res.ok) continue;

        const data = (await res.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              chat: { id: number };
              from?: { id: number };
              text?: string;
            };
          }>;
        };

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (update.message?.text && this.handler) {
            this.handler({
              platform: "telegram",
              chatId: String(update.message.chat.id),
              userId: String(update.message.from?.id ?? "unknown"),
              text: update.message.text,
            });
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        await new Promise((r) => setTimeout(r, this.pollingInterval));
      }
    }
  }
}
