import { createServer, type IncomingMessage as HttpIncomingMessage, type ServerResponse } from "node:http";
import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * WebhookAdapter — generic HTTP webhook platform.
 *
 * Starts an HTTP server that receives POST requests with JSON payloads.
 * Works with any service that can send webhooks (GitHub, Stripe, custom apps, etc).
 *
 * Incoming format:
 * POST /webhook
 * {
 *   "chatId": "channel-123",
 *   "userId": "user-456",
 *   "text": "hello agent",
 *   "metadata": { ... }
 * }
 *
 * Outgoing (sendMessage): POST to a configured callback URL with JSON body.
 */
export class WebhookAdapter implements PlatformAdapter {
  name = "webhook";
  private port = 3001;
  private callbackUrl?: string;
  private secret?: string;
  private server?: ReturnType<typeof createServer>;
  private handler?: (message: IncomingMessage) => void;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.port = (config.port as number) ?? 3001;
    this.callbackUrl = config.callbackUrl as string | undefined;
    this.secret = config.secret as string | undefined;

    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", reject);
      this.server.listen(this.port, () => {
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
    if (!this.callbackUrl) {
      throw new Error("WebhookAdapter: no callbackUrl configured for sending messages");
    }

    const res = await fetch(this.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, content }),
    });

    if (!res.ok) {
      throw new Error(`Webhook sendMessage failed: ${res.status}`);
    }
  }

  private handleRequest(req: HttpIncomingMessage, res: ServerResponse): void {
    // Only accept POST to /webhook
    if (req.method !== "POST" || !req.url?.startsWith("/webhook")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use POST /webhook" }));
      return;
    }

    // Verify secret if configured
    if (this.secret) {
      const provided = req.headers["x-webhook-secret"] as string | undefined;
      if (provided !== this.secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid secret" }));
        return;
      }
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body) as {
          chatId?: string;
          userId?: string;
          text?: string;
          metadata?: Record<string, unknown>;
        };

        if (!data.text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'text' field" }));
          return;
        }

        if (this.handler) {
          this.handler({
            platform: "webhook",
            chatId: data.chatId ?? "default",
            userId: data.userId ?? "unknown",
            text: data.text,
            metadata: data.metadata,
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }
}
