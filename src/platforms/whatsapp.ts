import { createServer, type IncomingMessage as HttpIncomingMessage, type ServerResponse } from "node:http";
import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * WhatsApp Business Cloud API adapter.
 *
 * Receives messages via webhook (HTTP server), sends via the WhatsApp Cloud API.
 * Requires a Meta Business app configured with the WhatsApp product.
 */
export class WhatsAppAdapter implements PlatformAdapter {
  name = "whatsapp";
  private phoneNumberId = "";
  private accessToken = "";
  private verifyToken = "";
  private webhookPort = 3002;
  private server?: ReturnType<typeof createServer>;
  private handler?: (message: IncomingMessage) => void;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.phoneNumberId = config.phoneNumberId as string;
    this.accessToken = config.accessToken as string;
    this.verifyToken = config.verifyToken as string;
    this.webhookPort = (config.webhookPort as number) ?? 3002;

    if (!this.phoneNumberId) throw new Error("WhatsApp: phoneNumberId is required");
    if (!this.accessToken) throw new Error("WhatsApp: accessToken is required");
    if (!this.verifyToken) throw new Error("WhatsApp: verifyToken is required");

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleWebhook(req, res));

      this.server.on("error", reject);
      this.server.listen(this.webhookPort, () => {
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: chatId,
          type: "text",
          text: { body: content },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp sendMessage failed: ${res.status}`);
    }
  }

  private handleWebhook(req: HttpIncomingMessage, res: ServerResponse): void {
    if (req.method === "GET") {
      this.handleVerification(req, res);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as {
          entry?: Array<{
            changes?: Array<{
              value?: {
                messages?: Array<{
                  from: string;
                  id: string;
                  text?: { body: string };
                  type: string;
                }>;
              };
            }>;
          }>;
        };

        const messages = data.entry?.[0]?.changes?.[0]?.value?.messages;
        if (messages && this.handler) {
          for (const msg of messages) {
            if (msg.text?.body) {
              this.handler({
                platform: "whatsapp",
                chatId: msg.from,
                userId: msg.from,
                text: msg.text.body,
                metadata: { messageId: msg.id },
              });
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  private handleVerification(req: HttpIncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "", `http://localhost:${this.webhookPort}`);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === this.verifyToken) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge ?? "");
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Verification failed" }));
    }
  }
}
