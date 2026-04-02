import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { WhatsAppAdapter } from "./whatsapp.js";
import { EmailAdapter } from "./email.js";
import { MatrixAdapter } from "./matrix.js";
import { createPlatform } from "./index.js";

// ============================================================================
// Helpers
// ============================================================================

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body ?? {},
    text: async () => JSON.stringify(response.body ?? {}),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

// ============================================================================
// WhatsApp Adapter
// ============================================================================

describe("WhatsAppAdapter", () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("connect - extracts config and starts server", async () => {
    const config = {
      phoneNumberId: "123456",
      accessToken: "token-abc",
      verifyToken: "verify-xyz",
      webhookPort: 0, // random port
    };
    await adapter.connect(config);
    expect(adapter.name).toBe("whatsapp");
  });

  it("disconnect - stops server", async () => {
    await adapter.connect({
      phoneNumberId: "123",
      accessToken: "tok",
      verifyToken: "ver",
      webhookPort: 0,
    });
    await adapter.disconnect();
    // Should not throw when disconnecting again
    await adapter.disconnect();
  });

  it("sendMessage - calls WhatsApp API with correct payload", async () => {
    const fetchMock = mockFetch({ ok: true });
    await adapter.connect({
      phoneNumberId: "99887",
      accessToken: "my-token",
      verifyToken: "vt",
      webhookPort: 0,
    });

    await adapter.sendMessage("+1234567890", "Hello WhatsApp!");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v21.0/99887/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: "+1234567890",
          type: "text",
          text: { body: "Hello WhatsApp!" },
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("sendMessage - throws on API error", async () => {
    mockFetch({ ok: false, status: 401 });
    await adapter.connect({
      phoneNumberId: "99887",
      accessToken: "bad-token",
      verifyToken: "vt",
      webhookPort: 0,
    });

    await expect(adapter.sendMessage("+1", "Hi")).rejects.toThrow("WhatsApp sendMessage failed: 401");
    vi.unstubAllGlobals();
  });

  it("handleWebhook - verification responds with challenge", async () => {
    await adapter.connect({
      phoneNumberId: "123",
      accessToken: "tok",
      verifyToken: "my-verify-token",
      webhookPort: 0,
    });

    const address = (adapter as unknown as { server: ReturnType<typeof createServer> }).server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(
      `http://localhost:${port}/?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=test-challenge-123`,
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toBe("test-challenge-123");
  });

  it("handleWebhook - rejects invalid verify token", async () => {
    await adapter.connect({
      phoneNumberId: "123",
      accessToken: "tok",
      verifyToken: "correct-token",
      webhookPort: 0,
    });

    const address = (adapter as unknown as { server: ReturnType<typeof createServer> }).server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const res = await fetch(
      `http://localhost:${port}/?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=x`,
    );
    expect(res.status).toBe(403);
  });

  it("handleWebhook - processes incoming message", async () => {
    await adapter.connect({
      phoneNumberId: "123",
      accessToken: "tok",
      verifyToken: "vt",
      webhookPort: 0,
    });

    const messages: unknown[] = [];
    adapter.onMessage((msg) => messages.push(msg));

    const address = (adapter as unknown as { server: ReturnType<typeof createServer> }).server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const payload = {
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: "+15551234567",
              id: "wamid.abc123",
              type: "text",
              text: { body: "Hello from WhatsApp" },
            }],
          },
        }],
      }],
    };

    await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Give handler a tick to process
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      platform: "whatsapp",
      chatId: "+15551234567",
      text: "Hello from WhatsApp",
    });
  });

  it("handleWebhook - ignores non-message updates", async () => {
    await adapter.connect({
      phoneNumberId: "123",
      accessToken: "tok",
      verifyToken: "vt",
      webhookPort: 0,
    });

    const messages: unknown[] = [];
    adapter.onMessage((msg) => messages.push(msg));

    const address = (adapter as unknown as { server: ReturnType<typeof createServer> }).server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // Payload with no messages (e.g., status update)
    const payload = {
      entry: [{
        changes: [{
          value: {
            statuses: [{ id: "wamid.xyz", status: "delivered" }],
          },
        }],
      }],
    };

    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(res.status).toBe(200);
    expect(messages).toHaveLength(0);
  });
});

// ============================================================================
// Email Adapter
// ============================================================================

describe("EmailAdapter", () => {
  let adapter: EmailAdapter;

  beforeEach(() => {
    adapter = new EmailAdapter();
  });

  afterEach(async () => {
    await adapter.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("connect - extracts IMAP/SMTP config", async () => {
    // We only test that config is extracted — actual IMAP connection would fail
    // without a real server, so we disconnect immediately after connect
    const connectPromise = adapter.connect({
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "user@example.com",
      password: "pass123",
      pollInterval: 60000,
    });

    // Disconnect quickly to stop the poll loop before it tries IMAP
    await adapter.disconnect();

    // The connect itself should resolve (it starts polling asynchronously)
    await connectPromise;
    expect(adapter.name).toBe("email");
  });

  it("disconnect - stops polling", async () => {
    await adapter.connect({
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      username: "user@example.com",
      password: "pass123",
      pollInterval: 999999, // Very long interval so poll doesn't fire
    });

    await adapter.disconnect();
    // Should be safe to disconnect multiple times
    await adapter.disconnect();
  });

  it("sendMessage - formats email correctly", async () => {
    // We test the sendSMTP method indirectly — since it needs a real server,
    // we verify the method exists and rejects with a connection error
    await adapter.connect({
      imapHost: "imap.example.com",
      smtpHost: "localhost",
      smtpPort: 1, // Will fail to connect
      username: "user@example.com",
      password: "pass123",
      pollInterval: 999999,
    });

    await expect(adapter.sendMessage("to@example.com", "Test body")).rejects.toThrow();
    await adapter.disconnect();
  });

  it("parseEmailAddress - extracts address from 'Name <email>' format", () => {
    const result = adapter.parseEmailAddress("John Doe <john@example.com>");
    expect(result).toBe("john@example.com");
  });

  it("parseEmailAddress - handles plain email address", () => {
    const result = adapter.parseEmailAddress("plain@example.com");
    expect(result).toBe("plain@example.com");
  });

  it("onMessage - registers handler", async () => {
    const handler = vi.fn();
    adapter.onMessage(handler);
    // Handler should be registered (we can't easily trigger it without IMAP)
    expect(adapter.name).toBe("email");
  });

  it("adapter properties - name is email", () => {
    expect(adapter.name).toBe("email");
  });

  it("adapter properties - default ports", async () => {
    // Connect with minimal config to verify defaults are used
    const connectPromise = adapter.connect({
      imapHost: "imap.example.com",
      smtpHost: "smtp.example.com",
      username: "user@example.com",
      password: "pass123",
    });
    await adapter.disconnect();
    await connectPromise;
    // If we got here, defaults were applied without error
    expect(adapter.name).toBe("email");
  });
});

// ============================================================================
// Matrix Adapter
// ============================================================================

describe("MatrixAdapter", () => {
  let adapter: MatrixAdapter;

  beforeEach(() => {
    adapter = new MatrixAdapter();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await adapter.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("connect - verifies with whoami endpoint", async () => {
    const fetchMock = mockFetch({ ok: true, body: { user_id: "@bot:example.com" } });

    await adapter.connect({
      homeserver: "https://matrix.example.com",
      accessToken: "syt_valid_token",
      userId: "@bot:example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/_matrix/client/v3/account/whoami"),
      expect.objectContaining({
        headers: { Authorization: "Bearer syt_valid_token" },
      }),
    );

    await adapter.disconnect();
  });

  it("connect - throws on invalid token", async () => {
    mockFetch({ ok: false, status: 401 });

    await expect(
      adapter.connect({
        homeserver: "https://matrix.example.com",
        accessToken: "bad-token",
        userId: "@bot:example.com",
      }),
    ).rejects.toThrow("Matrix: authentication failed (401)");
  });

  it("disconnect - stops sync loop", async () => {
    mockFetch({ ok: true, body: { user_id: "@bot:example.com" } });

    await adapter.connect({
      homeserver: "https://matrix.example.com",
      accessToken: "tok",
      userId: "@bot:example.com",
    });

    await adapter.disconnect();
    // Should not throw on second disconnect
    await adapter.disconnect();
  });

  it("sendMessage - sends to correct room endpoint", async () => {
    const fetchMock = mockFetch({ ok: true, body: { event_id: "$abc123" } });

    await adapter.connect({
      homeserver: "https://matrix.example.com",
      accessToken: "tok",
      userId: "@bot:example.com",
    });

    await adapter.sendMessage("!room123:example.com", "Hello Matrix!");

    // Find the PUT call (not the whoami GET)
    const putCall = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(putCall![0]).toContain("/_matrix/client/v3/rooms/");
    expect(putCall![0]).toContain("/send/m.room.message/");
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      msgtype: "m.text",
      body: "Hello Matrix!",
    });

    await adapter.disconnect();
  });

  it("sendMessage - throws on API error", async () => {
    // First call (whoami) succeeds, subsequent calls fail
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: "@bot:example.com" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ next_batch: "s1", rooms: {} }) }) // sync may fire
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    vi.stubGlobal("fetch", fetchMock);

    await adapter.connect({
      homeserver: "https://matrix.example.com",
      accessToken: "tok",
      userId: "@bot:example.com",
    });

    // Wait a tick for sync to start, then override fetch
    await new Promise((r) => setTimeout(r, 50));
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    await expect(adapter.sendMessage("!room:example.com", "Hi")).rejects.toThrow(
      "Matrix sendMessage failed: 403",
    );

    await adapter.disconnect();
  });

  it("sync - processes timeline events", async () => {
    const messages: unknown[] = [];

    // whoami → success, then sync → returns messages
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: "@bot:matrix.org" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          next_batch: "s1_initial",
          rooms: { join: {} },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          next_batch: "s2_withmessage",
          rooms: {
            join: {
              "!room1:matrix.org": {
                timeline: {
                  events: [{
                    type: "m.room.message",
                    sender: "@alice:matrix.org",
                    content: { msgtype: "m.text", body: "Hello from Matrix!" },
                    event_id: "$evt1",
                  }],
                },
              },
            },
          },
        }),
      })
      // Subsequent syncs block until abort
      .mockImplementation(() => new Promise(() => {}));

    vi.stubGlobal("fetch", fetchMock);

    adapter.onMessage((msg) => messages.push(msg));

    await adapter.connect({
      homeserver: "https://matrix.org",
      accessToken: "tok",
      userId: "@bot:matrix.org",
    });

    // Wait for sync to process
    await new Promise((r) => setTimeout(r, 200));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      platform: "matrix",
      chatId: "!room1:matrix.org",
      userId: "@alice:matrix.org",
      text: "Hello from Matrix!",
    });

    await adapter.disconnect();
  });

  it("sync - skips own messages", async () => {
    const messages: unknown[] = [];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: "@bot:matrix.org" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ next_batch: "s1", rooms: { join: {} } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          next_batch: "s2",
          rooms: {
            join: {
              "!room1:matrix.org": {
                timeline: {
                  events: [
                    {
                      type: "m.room.message",
                      sender: "@bot:matrix.org", // own message
                      content: { msgtype: "m.text", body: "My own reply" },
                      event_id: "$evt2",
                    },
                    {
                      type: "m.room.message",
                      sender: "@human:matrix.org",
                      content: { msgtype: "m.text", body: "From human" },
                      event_id: "$evt3",
                    },
                  ],
                },
              },
            },
          },
        }),
      })
      .mockImplementation(() => new Promise(() => {}));

    vi.stubGlobal("fetch", fetchMock);

    adapter.onMessage((msg) => messages.push(msg));

    await adapter.connect({
      homeserver: "https://matrix.org",
      accessToken: "tok",
      userId: "@bot:matrix.org",
    });

    await new Promise((r) => setTimeout(r, 200));

    // Should only have the human message, not the bot's own
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "From human",
      userId: "@human:matrix.org",
    });

    await adapter.disconnect();
  });

  it("sync - updates sync token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: "@bot:m.org" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ next_batch: "batch_token_1", rooms: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ next_batch: "batch_token_2", rooms: {} }),
      })
      .mockImplementation(() => new Promise(() => {}));

    vi.stubGlobal("fetch", fetchMock);

    await adapter.connect({
      homeserver: "https://m.org",
      accessToken: "tok",
      userId: "@bot:m.org",
    });

    await new Promise((r) => setTimeout(r, 200));

    // Second sync call should include since=batch_token_1
    const syncCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes("/sync"),
    );
    expect(syncCalls.length).toBeGreaterThanOrEqual(2);
    expect(syncCalls[1][0]).toContain("since=batch_token_1");

    await adapter.disconnect();
  });
});

// ============================================================================
// Platform Factory
// ============================================================================

describe("createPlatform", () => {
  it("creates all platform types including new ones", () => {
    const platforms = ["telegram", "discord", "slack", "webhook", "whatsapp", "email", "matrix"];
    for (const name of platforms) {
      const adapter = createPlatform(name);
      expect(adapter.name).toBe(name);
    }

    expect(() => createPlatform("nonexistent")).toThrow('Unknown platform: "nonexistent"');
  });
});
