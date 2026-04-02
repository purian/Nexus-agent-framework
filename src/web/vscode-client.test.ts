import { describe, it, expect, afterEach } from "vitest";
import { NexusWebServer } from "./server.js";
import WebSocket from "ws";

// ============================================================================
// VS Code Client Flow Tests
//
// These tests verify the NexusWebServer works correctly from the perspective
// of the VS Code extension client — REST session management, messaging,
// WebSocket events, authentication, and disconnect handling.
// ============================================================================

const host = "127.0.0.1";

describe("vscode-client flow", () => {
  let server: NexusWebServer;
  let port: number;

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async function startServer(
    opts?: { authToken?: string },
  ): Promise<void> {
    server = new NexusWebServer({
      port: 0,
      host,
      cors: true,
      authToken: opts?.authToken,
    });
    await server.start();
    // Read the OS-assigned port
    const addr = (server as any).server?.address();
    port = typeof addr === "object" ? addr.port : 0;
  }

  function url(path: string): string {
    return `http://${host}:${port}${path}`;
  }

  function wsUrl(): string {
    return `ws://${host}:${port}`;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  // --------------------------------------------------------------------------
  // Tests
  // --------------------------------------------------------------------------

  it("client flow - create session via REST", async () => {
    await startServer();

    // Health check
    const healthRes = await fetch(url("/api/health"));
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { status: string; version: string };
    expect(health.status).toBe("ok");
    expect(health.version).toBeDefined();

    // Create session
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
    });
    expect(createRes.status).toBe(201);
    const session = (await createRes.json()) as { id: string; createdAt: string };
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.createdAt).toBeDefined();

    // Verify session exists
    const getRes = await fetch(url(`/api/sessions/${session.id}`));
    expect(getRes.status).toBe(200);
    const retrieved = (await getRes.json()) as { id: string; messages: unknown[] };
    expect(retrieved.id).toBe(session.id);
    expect(retrieved.messages).toEqual([]);

    // List sessions
    const listRes = await fetch(url("/api/sessions"));
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sessions: Array<{ id: string }> };
    expect(list.sessions.length).toBe(1);
    expect(list.sessions[0].id).toBe(session.id);
  });

  it("client flow - send message to session", async () => {
    await startServer();

    // Create session
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
    });
    const session = (await createRes.json()) as { id: string };

    // Send a message
    const msgRes = await fetch(
      url(`/api/sessions/${session.id}/messages`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello from VS Code" }),
      },
    );
    expect(msgRes.status).toBe(200);
    const msgData = (await msgRes.json()) as { ok: boolean; messageId: string };
    expect(msgData.ok).toBe(true);
    expect(msgData.messageId).toBeDefined();

    // Verify message was stored
    const getRes = await fetch(url(`/api/sessions/${session.id}`));
    const retrieved = (await getRes.json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(retrieved.messages.length).toBe(1);
    expect(retrieved.messages[0].role).toBe("user");
    expect(retrieved.messages[0].content).toBe("Hello from VS Code");

    // Error case: send to non-existent session
    const errRes = await fetch(
      url("/api/sessions/nonexistent/messages"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "should fail" }),
      },
    );
    expect(errRes.status).toBe(404);

    // Error case: missing content field
    const badRes = await fetch(
      url(`/api/sessions/${session.id}/messages`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "wrong field" }),
      },
    );
    expect(badRes.status).toBe(400);
  });

  it("client flow - receive events via WebSocket", async () => {
    await startServer();

    // Connect WebSocket (simulating what the VS Code extension does)
    const ws = new WebSocket(wsUrl());

    const connected = new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });
    await connected;

    // Collect received events
    const receivedEvents: unknown[] = [];
    ws.on("message", (raw) => {
      receivedEvents.push(JSON.parse(raw.toString()));
    });

    // Broadcast events from the server (simulating the engine emitting events)
    server.broadcastEvent({ type: "text", text: "Hello from Nexus" });
    server.broadcastEvent({
      type: "tool_start",
      toolName: "ReadFile",
      toolUseId: "tu-1",
      input: { path: "/test.ts" },
    });
    server.broadcastEvent({
      type: "tool_end",
      toolUseId: "tu-1",
      result: "file contents here",
      isError: false,
    });
    server.broadcastEvent({
      type: "done",
      totalUsage: { inputTokens: 100, outputTokens: 50 },
    });

    // Give WebSocket time to deliver messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedEvents.length).toBe(4);
    expect(receivedEvents[0]).toEqual({ type: "text", text: "Hello from Nexus" });
    expect((receivedEvents[1] as { type: string }).type).toBe("tool_start");
    expect((receivedEvents[2] as { type: string }).type).toBe("tool_end");
    expect((receivedEvents[3] as { type: string }).type).toBe("done");

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("client flow - authenticate with token", async () => {
    const token = "test-secret-token-12345";
    await startServer({ authToken: token });

    // Request without token should be rejected
    const noAuthRes = await fetch(url("/api/health"));
    expect(noAuthRes.status).toBe(401);

    // Request with wrong token should be rejected
    const wrongRes = await fetch(url("/api/health"), {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongRes.status).toBe(401);

    // Request with correct token should succeed
    const goodRes = await fetch(url("/api/health"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(goodRes.status).toBe(200);

    // Create session with correct token
    const createRes = await fetch(url("/api/sessions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(createRes.status).toBe(201);

    // Verify session operations require auth
    const session = (await createRes.json()) as { id: string };
    const noAuthSession = await fetch(
      url(`/api/sessions/${session.id}`),
    );
    expect(noAuthSession.status).toBe(401);
  });

  it("client flow - handle server disconnect", async () => {
    await startServer();

    // Connect WebSocket
    const ws = new WebSocket(wsUrl());
    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Track close events
    let didClose = false;
    ws.on("close", () => {
      didClose = true;
    });

    // Stop the server while the client is connected
    await server.stop();

    // Give time for close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(didClose).toBe(true);

    // Mark as already stopped so afterEach doesn't double-stop
    server = undefined as unknown as NexusWebServer;
  });
});
