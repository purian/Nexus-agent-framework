import http from "node:http";
import https from "node:https";
import type { IncomingMessage, PlatformAdapter, SendMessageOptions } from "../types/index.js";

/**
 * Telegram Bot adapter using long-polling via the Bot API.
 *
 * The 30 s `getUpdates` long-poll runs on its OWN socket (`https.request` with `agent: false`),
 * never through `fetch`: a long-lived response parks Node's global fetch pool, and every
 * `sendMessage`/`getFile` in the process would then queue behind it until the poll returned —
 * observed live as ~11 s delays on every asynchronous send (alerts, reminders).
 *
 * Also delivers `callback_query` updates (inline-button taps) through the same `onMessage`
 * handler as an IncomingMessage with `text: ""` and
 * `metadata: { callbackQueryId, callbackData, messageId }`, so consumers gate them with the
 * same per-user allowlist they already apply to text.
 */
export class TelegramAdapter implements PlatformAdapter {
  name = "telegram";
  private token = "";
  private apiBase = "https://api.telegram.org";
  private pollingInterval = 1000;
  private offset = 0;
  private running = false;
  private handler?: (message: IncomingMessage) => void;
  private abortController?: AbortController;
  private pollRequest?: http.ClientRequest;

  private api(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  async connect(config: Record<string, unknown>): Promise<void> {
    this.token = config.token as string;
    if (!this.token) throw new Error("Telegram: token is required");
    this.pollingInterval = (config.pollingInterval as number) ?? 1000;
    // Overridable for tests only (a local mock of the Bot API).
    if (typeof config.apiBase === "string" && config.apiBase) this.apiBase = config.apiBase.replace(/\/$/, "");

    // Verify token
    const res = await fetch(this.api("getMe"));
    if (!res.ok) throw new Error(`Telegram: invalid token (${res.status})`);

    this.running = true;
    this.abortController = new AbortController();
    this.poll();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.pollRequest?.destroy();
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  private async post(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await fetch(this.api(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Telegram ${method} failed: ${res.status}`);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async sendMessage(chatId: string, content: string, options?: SendMessageOptions): Promise<{ messageId?: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, text: content };
    if (options?.parseMode) body.parse_mode = options.parseMode;
    if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
    if (options?.disableLinkPreview) body.link_preview_options = { is_disabled: true };
    const data = await this.post("sendMessage", body);
    const id = (data?.result as { message_id?: number } | undefined)?.message_id;
    return { messageId: id !== undefined ? String(id) : undefined };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.post("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  /** editMessageText — omitting `replyMarkup` removes the inline keyboard, per the Bot API. */
  async editMessage(chatId: string, messageId: string, content: string, options?: SendMessageOptions): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: Number(messageId), text: content };
    if (options?.parseMode) body.parse_mode = options.parseMode;
    if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
    if (options?.disableLinkPreview) body.link_preview_options = { is_disabled: true };
    await this.post("editMessageText", body);
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const infoRes = await fetch(this.api(`getFile?file_id=${fileId}`));
    if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
    const info = (await infoRes.json()) as { ok: boolean; result: { file_path: string } };
    if (!info.ok) throw new Error("getFile returned ok=false");
    const fileUrl = `${this.apiBase}/file/bot${this.token}/${info.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`file download failed: ${fileRes.status}`);
    return Buffer.from(await fileRes.arrayBuffer());
  }

  /** The long-poll, on a dedicated socket (see the class comment). Resolves with the raw body. */
  private getUpdatesRaw(): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.api(`getUpdates?offset=${this.offset}&timeout=30`));
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(url, { method: "GET", agent: false }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (buf += c));
        res.on("end", () => (res.statusCode === 200 ? resolve(buf) : reject(new Error(`getUpdates ${res.statusCode}`))));
        res.on("error", reject);
      });
      req.on("error", reject);
      this.pollRequest = req;
      req.end();
    });
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const raw = await this.getUpdatesRaw();
        const data = JSON.parse(raw) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              chat: { id: number };
              from?: { id: number };
              text?: string;
              voice?: { file_id: string; mime_type?: string; duration: number };
              audio?: { file_id: string; mime_type?: string; duration: number };
              document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
            };
            callback_query?: {
              id: string;
              from: { id: number };
              data?: string;
              message?: { message_id: number; chat: { id: number } };
            };
          }>;
        };
        if (!data.ok) continue;

        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (!this.handler) continue;

          const cq = update.callback_query;
          if (cq) {
            this.handler({
              platform: "telegram",
              chatId: String(cq.message?.chat.id ?? cq.from.id),
              userId: String(cq.from.id),
              text: "",
              metadata: {
                callbackQueryId: cq.id,
                callbackData: cq.data ?? "",
                messageId: cq.message ? String(cq.message.message_id) : undefined,
              },
            });
            continue;
          }

          const msg = update.message;
          if (!msg) continue;

          const chatId = String(msg.chat.id);
          const userId = String(msg.from?.id ?? "unknown");

          // A Telegram update can carry BOTH a voice attachment and a server-side
          // transcription (Telegram Premium auto-transcribes voice notes). Forward
          // both fields when present so the consumer can choose: prefer a local
          // transcription stack (better quality) or fall back to Telegram's text.
          const hasVoice = Boolean(msg.voice || msg.audio);
          const hasDocument = Boolean(msg.document);
          const hasText = Boolean(msg.text);

          if (hasVoice) {
            const fileObj = (msg.voice ?? msg.audio)!;
            const mimeType = fileObj.mime_type ?? "audio/ogg";
            try {
              const audioData = await this.downloadFile(fileObj.file_id);
              const textContent = msg.text ?? "";
              this.handler({
                platform: "telegram",
                chatId,
                userId,
                text: textContent,
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
          } else if (hasDocument) {
            const fileObj = msg.document!;
            const fileName = fileObj.file_name ?? "document";
            const mimeType = fileObj.mime_type ?? "application/octet-stream";
            try {
              const fileData = await this.downloadFile(fileObj.file_id);
              const textContent = msg.text ?? "";
              this.handler({
                platform: "telegram",
                chatId,
                userId,
                text: textContent,
                attachments: [{ type: "document", url: fileObj.file_id, data: fileData }],
                metadata: { mimeType, fileName, fileSize: fileObj.file_size },
              });
            } catch (err) {
              // Document download failed — fall back to text if we have it,
              // otherwise log so the message isn't silently dropped.
              if (hasText) {
                this.handler({ platform: "telegram", chatId, userId, text: msg.text! });
              } else {
                console.error(
                  `[telegram] document download failed for chat ${chatId}: ${(err as Error).message}`,
                );
              }
            }
          } else if (hasText) {
            this.handler({ platform: "telegram", chatId, userId, text: msg.text! });
          }
        }
      } catch {
        if (!this.running) break; // disconnect() destroyed the poll request
        await new Promise((r) => setTimeout(r, this.pollingInterval));
      }
    }
  }
}
