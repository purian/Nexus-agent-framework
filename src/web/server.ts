import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { EventEmitter } from "eventemitter3";
import type { EngineEvent } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface WebUIConfig {
  port: number;
  host?: string;
  /** Enable CORS for development (default: false) */
  cors?: boolean;
  /** Static files directory for serving a frontend (optional) */
  staticDir?: string;
  /** Authentication token required for all requests */
  authToken?: string;
}

export interface WebUISession {
  id: string;
  createdAt: Date;
  messages: Array<{ role: string; content: string; timestamp: Date }>;
}

// ============================================================================
// NexusWebServer
// ============================================================================

export class NexusWebServer extends EventEmitter<{
  connection: [WebSocket];
  message: [string, WebSocket];
  error: [Error];
}> {
  private config: WebUIConfig;
  private server?: ReturnType<typeof createServer>;
  private wss?: WebSocketServer;
  private sessions = new Map<string, WebUISession>();
  private clients = new Set<WebSocket>();

  constructor(config: WebUIConfig) {
    super();
    this.config = {
      host: "127.0.0.1",
      cors: false,
      ...config,
    };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on("connection", (ws) => this.handleWebSocket(ws));

      this.server.on("error", (err) => reject(err));
      this.server.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Broadcasting
  // --------------------------------------------------------------------------

  /** Broadcast an engine event to all connected WebSocket clients */
  broadcastEvent(event: EngineEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  /** Send data to a specific client */
  sendToClient(ws: WebSocket, data: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // --------------------------------------------------------------------------
  // HTTP Request Handling
  // --------------------------------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers
    if (this.config.cors) {
      this.setCorsHeaders(res);
    }

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authentication
    if (!this.authenticateRequest(req)) {
      this.sendJSON(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Route matching
    if (method === "GET" && url === "/api/health") {
      return this.handleHealthCheck(res);
    }

    if (method === "GET" && url === "/api/sessions") {
      return this.handleGetSessions(res);
    }

    if (method === "POST" && url === "/api/sessions") {
      return this.handleCreateSession(req, res);
    }

    // Match /api/sessions/:id and /api/sessions/:id/messages
    const sessionMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const id = sessionMatch[1];
      if (method === "GET") return this.handleGetSession(res, id);
      if (method === "DELETE") return this.handleDeleteSession(res, id);
    }

    const messageMatch = url.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messageMatch && method === "POST") {
      return this.handleSendMessage(req, res, messageMatch[1]);
    }

    // 404 fallback
    this.sendJSON(res, 404, { error: "Not found" });
  }

  // --------------------------------------------------------------------------
  // WebSocket Handling
  // --------------------------------------------------------------------------

  private handleWebSocket(ws: WebSocket): void {
    this.clients.add(ws);
    this.emit("connection", ws);

    ws.on("message", (raw) => {
      try {
        const data = raw.toString();
        this.emit("message", data, ws);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  // --------------------------------------------------------------------------
  // Auth & CORS
  // --------------------------------------------------------------------------

  private authenticateRequest(req: IncomingMessage): boolean {
    if (!this.config.authToken) return true;

    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    return match[1] === this.config.authToken;
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }

  // --------------------------------------------------------------------------
  // Response Helpers
  // --------------------------------------------------------------------------

  private sendJSON(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  // --------------------------------------------------------------------------
  // Route Handlers
  // --------------------------------------------------------------------------

  private handleHealthCheck(res: ServerResponse): void {
    this.sendJSON(res, 200, {
      status: "ok",
      version: "0.12.0",
      uptime: process.uptime(),
    });
  }

  private handleGetSessions(res: ServerResponse): void {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      messageCount: s.messages.length,
    }));
    this.sendJSON(res, 200, { sessions });
  }

  private handleCreateSession(
    _req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const session: WebUISession = {
      id: randomUUID(),
      createdAt: new Date(),
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.sendJSON(res, 201, {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
    });
  }

  private handleGetSession(res: ServerResponse, id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return this.sendJSON(res, 404, { error: "Session not found" });
    }
    this.sendJSON(res, 200, {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      messages: session.messages.map((m) => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
    });
  }

  private handleDeleteSession(res: ServerResponse, id: string): void {
    if (!this.sessions.has(id)) {
      return this.sendJSON(res, 404, { error: "Session not found" });
    }
    this.sessions.delete(id);
    this.sendJSON(res, 200, { ok: true });
  }

  private handleSendMessage(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return this.sendJSON(res, 404, { error: "Session not found" });
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.content || typeof parsed.content !== "string") {
          return this.sendJSON(res, 400, {
            error: "Missing or invalid 'content' field",
          });
        }

        const message = {
          role: "user",
          content: parsed.content,
          timestamp: new Date(),
        };
        session.messages.push(message);

        const messageId = randomUUID();
        this.sendJSON(res, 200, { ok: true, messageId });
      } catch {
        this.sendJSON(res, 400, { error: "Invalid JSON body" });
      }
    });
  }
}
