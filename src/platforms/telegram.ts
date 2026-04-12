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

  private async downloadFile(fileId: string): Promise<Buffer> {
    const infoRes = await fetch(
      `https://api.telegram.org/bot${this.token}/getFile?file_id=${fileId}`,
    );
    if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
    const info = (await infoRes.json()) as { ok: boolean; result: { file_path: string } };
    if (!info.ok) throw new Error("getFile returned ok=false");
    const fileUrl = `https://api.telegram.org/file/bot${this.token}/${info.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`file download failed: ${fileRes.status}`);
    return Buffer.from(await fileRes.arrayBuffer());
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
              voice?: { file_id: string; mime_type?: string; duration: number };
              audio?: { file_id: string; mime_type?: string; duration: number };
            };
          }>;
        };

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !this.handler) continue;

          const chatId = String(msg.chat.id);
          const userId = String(msg.from?.id ?? "unknown");

          // A Telegram update can carry BOTH a voice attachment and a server-side
          // transcription (Telegram Premium auto-transcribes voice notes). Forward
          // both fields when present so the consumer can choose: prefer a local
          // transcription stack (better quality) or fall back to Telegram's text.
          const hasVoice = Boolean(msg.voice || msg.audio);
          const hasText = Boolean(msg.text);

          if (hasVoice) {
            const fileObj = (msg.voice ?? msg.audio)!;
            const mimeType = fileObj.mime_type ?? "audio/ogg";
            try {
              const audioData = await this.downloadFile(fileObj.file_id);
              this.handler({
                platform: "telegram",
                chatId,
                userId,
                text: msg.text ?? "",
                attachments: [{ type: "voice", url: fileObj.file_id, data: audioData }],
                metadata: { mimeType, telegramTranscript: msg.text ?? null },
              });
            } catch (err) {
              // Voice download failed — fall back to text if we have it,
              // otherwise log so the message isn't silently dropped.
              if (hasText) {
                this.handler({ platform: "telegram", chatId, userId, text: msg.text! });
              } else {
                console.error(
                  `[telegram] voice download failed for chat ${chatId}: ${(err as Error).message}`,
                );
              }
            }
          } else if (hasText) {
            this.handler({ platform: "telegram", chatId, userId, text: msg.text! });
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        await new Promise((r) => setTimeout(r, this.pollingInterval));
      }
    }
  }
}
