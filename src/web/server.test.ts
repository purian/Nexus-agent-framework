import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NexusWebServer } from "./server.js";
import WebSocket from "ws";
import type { EngineEvent } from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

let server: NexusWebServer;
let port: number;
const host = "127.0.0.1";

/** Find an open port by binding to 0 and reading the assigned port. */
async function startServer(
  overrides: Partial<ConstructorParameters<typeof NexusWebServer>[0]> = {},
): Promise<number> {
  // Use port 0 to let the OS assign an available port
  server = new NexusWebServer({ port: 0, host, ...overrides });
  await server.start();
  // Access the underlying server to read the actual port
  const addr = (server as any).server?.address();
  return typeof addr === "object" ? addr.port : 0;
}

function url(path: string): string {
  return `http://${host}:${port}${path}`;
}

function wsUrl(): string {
  return `ws://${host}:${port}`;
}

async function json(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url(path), init);
  const body = await res.json();
  return { status: res.status, body };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("NexusWebServer", () => {
  beforeEach(async () => {
    port = await startServer();
  });

  afterEach(async () => {
    if (server) await server.stop();
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  it("start - server starts and listens", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.ok).toBe(true);
  });

  it("start - binds to configured host and port", async () => {
    const addr = (server as any).server?.address();
    expect(addr.address).toBe(host);
    expect(typeof addr.port).toBe("number");
    expect(addr.port).toBeGreaterThan(0);
  });

  it("stop - stops the server", async () => {
    await server.stop();
    await expect(fetch(url("/api/health"))).rejects.toThrow();
    // Prevent afterEach from stopping again
    server = undefined as any;
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  it("GET /api/health - returns ok status", async () => {
    const { status, body } = await json("/api/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("GET /api/health - includes version and uptime", async () => {
    const { body } = await json("/api/health");
    expect(body.version).toBe("0.12.0");
    expect(typeof body.uptime).toBe("number");
  });

  // --------------------------------------------------------------------------
  // Sessions CRUD
  // --------------------------------------------------------------------------

  it("POST /api/sessions - creates a new session", async () => {
    const { status, body } = await json("/api/sessions", { method: "POST" });
    expect(status).toBe(201);
    expect(body.id).toBeDefined();
  });

  it("POST /api/sessions - returns session id and createdAt", async () => {
    const { body } = await json("/api/sessions", { method: "POST" });
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.createdAt).toBeDefined();
    // createdAt should be a valid ISO date
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  });

  it("GET /api/sessions - lists all sessions", async () => {
    await json("/api/sessions", { method: "POST" });
    await json("/api/sessions", { method: "POST" });
    const { status, body } = await json("/api/sessions");
    expect(status).toBe(200);
    expect(body.sessions.length).toBe(2);
  });

  it("GET /api/sessions/:id - returns session with messages", async () => {
    const { body: created } = await json("/api/sessions", { method: "POST" });
    const { status, body } = await json(`/api/sessions/${created.id}`);
    expect(status).toBe(200);
    expect(body.id).toBe(created.id);
    expect(body.messages).toEqual([]);
  });

  it("GET /api/sessions/:id - returns 404 for unknown session", async () => {
    const { status, body } = await json("/api/sessions/nonexistent");
    expect(status).toBe(404);
    expect(body.error).toContain("not found");
  });

  it("DELETE /api/sessions/:id - deletes session", async () => {
    const { body: created } = await json("/api/sessions", { method: "POST" });
    const { status, body } = await json(`/api/sessions/${created.id}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    // Verify it's gone
    const { status: getStatus } = await json(`/api/sessions/${created.id}`);
    expect(getStatus).toBe(404);
  });

  it("DELETE /api/sessions/:id - returns 404 for unknown session", async () => {
    const { status } = await json("/api/sessions/nonexistent", {
      method: "DELETE",
    });
    expect(status).toBe(404);
  });

  // --------------------------------------------------------------------------
  // Messages
  // --------------------------------------------------------------------------

  it("POST /api/sessions/:id/messages - adds message to session", async () => {
    const { body: created } = await json("/api/sessions", { method: "POST" });
    const { status, body } = await json(
      `/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello" }),
      },
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.messageId).toBeDefined();

    // Verify message was stored
    const { body: session } = await json(`/api/sessions/${created.id}`);
    expect(session.messages.length).toBe(1);
    expect(session.messages[0].content).toBe("Hello");
    expect(session.messages[0].role).toBe("user");
  });

  it("POST /api/sessions/:id/messages - returns 404 for unknown session", async () => {
    const { status } = await json("/api/sessions/nonexistent/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(status).toBe(404);
  });

  it("POST /api/sessions/:id/messages - returns 400 for missing content", async () => {
    const { body: created } = await json("/api/sessions", { method: "POST" });
    const { status, body } = await json(
      `/api/sessions/${created.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "wrong field" }),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("content");
  });

  // --------------------------------------------------------------------------
  // 404
  // --------------------------------------------------------------------------

  it("unknown route - returns 404", async () => {
    const { status, body } = await json("/api/unknown");
    expect(status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  describe("authentication", () => {
    let authServer: NexusWebServer;
    let authPort: number;

    beforeEach(async () => {
      authServer = new NexusWebServer({
        port: 0,
        host,
        authToken: "secret-token-123",
      });
      await authServer.start();
      const addr = (authServer as any).server?.address();
      authPort = addr.port;
    });

    afterEach(async () => {
      if (authServer) await authServer.stop();
    });

    it("auth - rejects unauthenticated request when authToken set", async () => {
      const res = await fetch(`http://${host}:${authPort}/api/health`);
      expect(res.status).toBe(401);
    });

    it("auth - accepts valid bearer token", async () => {
      const res = await fetch(`http://${host}:${authPort}/api/health`, {
        headers: { Authorization: "Bearer secret-token-123" },
      });
      expect(res.status).toBe(200);
    });

    it("auth - allows all requests when no authToken configured", async () => {
      // The main server (no auth) should allow requests
      const res = await fetch(url("/api/health"));
      expect(res.status).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // CORS
  // --------------------------------------------------------------------------

  describe("CORS", () => {
    let corsServer: NexusWebServer;
    let corsPort: number;

    beforeEach(async () => {
      corsServer = new NexusWebServer({ port: 0, host, cors: true });
      await corsServer.start();
      const addr = (corsServer as any).server?.address();
      corsPort = addr.port;
    });

    afterEach(async () => {
      if (corsServer) await corsServer.stop();
    });

    it("CORS - sets headers when enabled", async () => {
      const res = await fetch(`http://${host}:${corsPort}/api/health`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("CORS - no headers when disabled", async () => {
      // Main server has cors: false (default)
      const res = await fetch(url("/api/health"));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // WebSocket
  // --------------------------------------------------------------------------

  describe("WebSocket", () => {
    it("WebSocket - connects successfully", async () => {
      const ws = new WebSocket(wsUrl());
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await new Promise<void>((resolve) => ws.on("close", resolve));
    });

    it("WebSocket - handles disconnect", async () => {
      const ws = new WebSocket(wsUrl());
      await new Promise<void>((resolve) => ws.on("open", resolve));

      ws.close();
      await new Promise<void>((resolve) => ws.on("close", resolve));
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it("broadcastEvent - sends to all connected clients", async () => {
      const ws1 = new WebSocket(wsUrl());
      const ws2 = new WebSocket(wsUrl());
      await Promise.all([
        new Promise<void>((resolve) => ws1.on("open", resolve)),
        new Promise<void>((resolve) => ws2.on("open", resolve)),
      ]);

      // Small delay for the server to register both clients
      await new Promise((r) => setTimeout(r, 50));

      const received1: string[] = [];
      const received2: string[] = [];
      ws1.on("message", (data) => received1.push(data.toString()));
      ws2.on("message", (data) => received2.push(data.toString()));

      const event: EngineEvent = {
        type: "text",
        text: "Hello from broadcast",
      };
      server.broadcastEvent(event);

      // Wait for messages to arrive
      await new Promise((r) => setTimeout(r, 100));

      expect(received1.length).toBe(1);
      expect(JSON.parse(received1[0])).toEqual(event);
      expect(received2.length).toBe(1);
      expect(JSON.parse(received2[0])).toEqual(event);

      ws1.close();
      ws2.close();
      await Promise.all([
        new Promise<void>((resolve) => ws1.on("close", resolve)),
        new Promise<void>((resolve) => ws2.on("close", resolve)),
      ]);
    });

    it("sendToClient - sends to specific client", async () => {
      const ws1 = new WebSocket(wsUrl());
      const ws2 = new WebSocket(wsUrl());
      await Promise.all([
        new Promise<void>((resolve) => ws1.on("open", resolve)),
        new Promise<void>((resolve) => ws2.on("open", resolve)),
      ]);

      await new Promise((r) => setTimeout(r, 50));

      const received1: string[] = [];
      const received2: string[] = [];
      ws1.on("message", (data) => received1.push(data.toString()));
      ws2.on("message", (data) => received2.push(data.toString()));

      // Get the first client from the set
      const clients = Array.from((server as any).clients);
      server.sendToClient(clients[0] as WebSocket, { hello: "world" });

      await new Promise((r) => setTimeout(r, 100));

      // Only one client should have received the message
      const totalReceived = received1.length + received2.length;
      expect(totalReceived).toBe(1);

      ws1.close();
      ws2.close();
      await Promise.all([
        new Promise<void>((resolve) => ws1.on("close", resolve)),
        new Promise<void>((resolve) => ws2.on("close", resolve)),
      ]);
    });
  });
});
