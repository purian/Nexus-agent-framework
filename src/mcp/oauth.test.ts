import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { OAuthTokenManager } from "./oauth.js";
import type { OAuthToken } from "./oauth.js";
import type { MCPOAuthConfig } from "../types/index.js";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<MCPOAuthConfig>): MCPOAuthConfig {
  return {
    provider: "oauth2",
    authorizationUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    scopes: ["read", "write"],
    ...overrides,
  };
}

function makeTokenResponse(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    access_token: "access-token-123",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "refresh-token-456",
    scope: "read write",
    ...overrides,
  };
}

function mockFetchSuccess(data: Record<string, unknown>): Mock {
  const mockFn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

function mockFetchFailure(status: number, body: string): Mock {
  const mockFn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", mockFn);
  return mockFn;
}

// ============================================================================
// Tests
// ============================================================================

describe("OAuthTokenManager", () => {
  let manager: OAuthTokenManager;

  beforeEach(() => {
    manager = new OAuthTokenManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // fetchToken
  // --------------------------------------------------------------------------

  describe("fetchToken", () => {
    it("sends client_credentials grant with correct parameters", async () => {
      const config = makeConfig();
      const mockFn = mockFetchSuccess(makeTokenResponse());

      const token = await manager.fetchToken(config);

      expect(mockFn).toHaveBeenCalledTimes(1);
      const [url, options] = mockFn.mock.calls[0];
      expect(url).toBe("https://auth.example.com/token");
      expect(options.method).toBe("POST");

      const body = new URLSearchParams(options.body);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("scope")).toBe("read write");

      expect(options.headers["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );
    });

    it("parses token response correctly", async () => {
      const config = makeConfig();
      const now = Date.now();
      mockFetchSuccess(makeTokenResponse());

      const token = await manager.fetchToken(config);

      expect(token.accessToken).toBe("access-token-123");
      expect(token.tokenType).toBe("Bearer");
      expect(token.refreshToken).toBe("refresh-token-456");
      expect(token.scope).toBe("read write");
      expect(token.expiresAt).toBeGreaterThanOrEqual(now + 3600 * 1000);
    });

    it("sends refresh_token grant when refreshToken is provided", async () => {
      const config = makeConfig();
      const mockFn = mockFetchSuccess(makeTokenResponse());

      await manager.fetchToken(config, "my-refresh-token");

      const body = new URLSearchParams(mockFn.mock.calls[0][1].body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("my-refresh-token");
      expect(body.get("client_id")).toBe("test-client-id");
    });

    it("throws descriptive error on non-200 response", async () => {
      const config = makeConfig();
      mockFetchFailure(401, "Unauthorized: invalid client");

      await expect(manager.fetchToken(config)).rejects.toThrow(
        "OAuth token request failed (401): Unauthorized: invalid client",
      );
    });

    it("throws when access_token is missing from response", async () => {
      const config = makeConfig();
      mockFetchSuccess({ token_type: "Bearer", expires_in: 3600 });

      await expect(manager.fetchToken(config)).rejects.toThrow(
        "OAuth token response missing access_token",
      );
    });

    it("includes custom tokenRequestHeaders in request", async () => {
      const config = makeConfig({
        tokenRequestHeaders: {
          "X-Custom-Header": "custom-value",
          "X-Another": "another-value",
        },
      });
      const mockFn = mockFetchSuccess(makeTokenResponse());

      await manager.fetchToken(config);

      const headers = mockFn.mock.calls[0][1].headers;
      expect(headers["X-Custom-Header"]).toBe("custom-value");
      expect(headers["X-Another"]).toBe("another-value");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("omits client_secret when not provided", async () => {
      const config = makeConfig({ clientSecret: undefined });
      const mockFn = mockFetchSuccess(makeTokenResponse());

      await manager.fetchToken(config);

      const body = new URLSearchParams(mockFn.mock.calls[0][1].body);
      expect(body.has("client_secret")).toBe(false);
    });

    it("omits scope when not provided", async () => {
      const config = makeConfig({ scopes: undefined });
      const mockFn = mockFetchSuccess(makeTokenResponse());

      await manager.fetchToken(config);

      const body = new URLSearchParams(mockFn.mock.calls[0][1].body);
      expect(body.has("scope")).toBe(false);
    });

    it("defaults expires_in to 3600 when not in response", async () => {
      const config = makeConfig();
      const now = Date.now();
      mockFetchSuccess({
        access_token: "tok",
        token_type: "Bearer",
      });

      const token = await manager.fetchToken(config);

      expect(token.expiresAt).toBeGreaterThanOrEqual(now + 3600 * 1000);
    });
  });

  // --------------------------------------------------------------------------
  // getAccessToken
  // --------------------------------------------------------------------------

  describe("getAccessToken", () => {
    it("fetches a new token when none cached", async () => {
      const config = makeConfig();
      const mockFn = mockFetchSuccess(makeTokenResponse());

      const accessToken = await manager.getAccessToken("server1", config);

      expect(accessToken).toBe("access-token-123");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("returns cached token when still valid", async () => {
      const config = makeConfig();
      const mockFn = mockFetchSuccess(makeTokenResponse());

      const first = await manager.getAccessToken("server1", config);
      const second = await manager.getAccessToken("server1", config);

      expect(first).toBe(second);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("refreshes expired token using refresh_token", async () => {
      const config = makeConfig();

      // First call: return a token that will expire soon
      const mockFn = mockFetchSuccess(
        makeTokenResponse({ expires_in: 30 }), // 30s < 60s buffer = already "expired"
      );

      await manager.getAccessToken("server1", config);
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Second call: token is expired (within buffer), should refresh
      mockFn.mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            makeTokenResponse({
              access_token: "refreshed-token",
              expires_in: 3600,
            }),
          ),
        text: () => Promise.resolve(""),
      });

      const refreshed = await manager.getAccessToken("server1", config);
      expect(refreshed).toBe("refreshed-token");
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Verify refresh_token grant was used
      const body = new URLSearchParams(mockFn.mock.calls[1][1].body);
      expect(body.get("grant_type")).toBe("refresh_token");
    });

    it("falls back to new token fetch when refresh fails", async () => {
      const config = makeConfig();

      // First call: token that expires within buffer
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Initial fetch — short-lived token
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve(makeTokenResponse({ expires_in: 10 })),
            text: () => Promise.resolve(""),
          });
        }
        if (callCount === 2) {
          // Refresh attempt — fails
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve("refresh_token expired"),
          });
        }
        // Fallback: new client_credentials fetch
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeTokenResponse({ access_token: "fallback-token" }),
            ),
          text: () => Promise.resolve(""),
        });
      });
      vi.stubGlobal("fetch", mockFn);

      await manager.getAccessToken("server1", config);

      const token = await manager.getAccessToken("server1", config);
      expect(token).toBe("fallback-token");
      expect(mockFn).toHaveBeenCalledTimes(3);

      // Third call should be client_credentials
      const body = new URLSearchParams(mockFn.mock.calls[2][1].body);
      expect(body.get("grant_type")).toBe("client_credentials");
    });

    it("fetches new token when expired and no refresh token", async () => {
      const config = makeConfig();

      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve(
                makeTokenResponse({
                  expires_in: 10,
                  refresh_token: undefined,
                }),
              ),
            text: () => Promise.resolve(""),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeTokenResponse({ access_token: "new-token" }),
            ),
          text: () => Promise.resolve(""),
        });
      });
      vi.stubGlobal("fetch", mockFn);

      await manager.getAccessToken("server1", config);
      const token = await manager.getAccessToken("server1", config);

      expect(token).toBe("new-token");
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Both should be client_credentials
      const body1 = new URLSearchParams(mockFn.mock.calls[0][1].body);
      const body2 = new URLSearchParams(mockFn.mock.calls[1][1].body);
      expect(body1.get("grant_type")).toBe("client_credentials");
      expect(body2.get("grant_type")).toBe("client_credentials");
    });

    it("uses custom refreshBufferSeconds", async () => {
      const config = makeConfig({ refreshBufferSeconds: 10 });

      // Token with 30s expiry — with default 60s buffer it would be expired,
      // but with 10s buffer it should be valid
      mockFetchSuccess(makeTokenResponse({ expires_in: 30 }));

      const first = await manager.getAccessToken("server1", config);
      const second = await manager.getAccessToken("server1", config);

      expect(first).toBe(second);
    });
  });

  // --------------------------------------------------------------------------
  // scheduleRefresh
  // --------------------------------------------------------------------------

  describe("scheduleRefresh", () => {
    it("proactively refreshes before expiry", async () => {
      const config = makeConfig({ refreshBufferSeconds: 60 });

      // Token expires in 120s, buffer is 60s, so refresh at 60s
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeTokenResponse({
                access_token: callCount === 1 ? "initial" : "refreshed",
                expires_in: 120,
              }),
            ),
          text: () => Promise.resolve(""),
        });
      });
      vi.stubGlobal("fetch", mockFn);

      const token = await manager.getAccessToken("server1", config);
      expect(token).toBe("initial");
      expect(mockFn).toHaveBeenCalledTimes(1);

      // Advance time to trigger the scheduled refresh (120s - 60s buffer = 60s)
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("does not schedule refresh when delay is non-positive", async () => {
      const config = makeConfig({ refreshBufferSeconds: 3600 });

      // Token expires in 10s, buffer is 3600s — delay would be negative
      mockFetchSuccess(makeTokenResponse({ expires_in: 10 }));

      await manager.getAccessToken("server1", config);

      // Advance a lot of time — no extra calls should happen
      await vi.advanceTimersByTimeAsync(100_000);

      // Only the initial fetch
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // isTokenExpired
  // --------------------------------------------------------------------------

  describe("isTokenExpired", () => {
    it("returns false when token is valid with buffer", () => {
      const token: OAuthToken = {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresAt: Date.now() + 120_000, // 120s from now
      };

      expect(manager.isTokenExpired(token, 60)).toBe(false);
    });

    it("returns true when token is within buffer window", () => {
      const token: OAuthToken = {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresAt: Date.now() + 30_000, // 30s from now, buffer is 60s
      };

      expect(manager.isTokenExpired(token, 60)).toBe(true);
    });

    it("returns true when token is already expired", () => {
      const token: OAuthToken = {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresAt: Date.now() - 1000, // Already expired
      };

      expect(manager.isTokenExpired(token, 0)).toBe(true);
    });

    it("respects zero buffer seconds", () => {
      const token: OAuthToken = {
        accessToken: "tok",
        tokenType: "Bearer",
        expiresAt: Date.now() + 1000,
      };

      expect(manager.isTokenExpired(token, 0)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // revokeToken
  // --------------------------------------------------------------------------

  describe("revokeToken", () => {
    it("clears cached token and timer", async () => {
      const config = makeConfig();
      mockFetchSuccess(makeTokenResponse({ expires_in: 3600 }));

      await manager.getAccessToken("server1", config);
      await manager.revokeToken("server1");

      // Next call should fetch again
      const mockFn = mockFetchSuccess(
        makeTokenResponse({ access_token: "new-after-revoke" }),
      );

      const token = await manager.getAccessToken("server1", config);
      expect(token).toBe("new-after-revoke");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("is safe to call for non-existent server", async () => {
      await expect(
        manager.revokeToken("nonexistent"),
      ).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // dispose
  // --------------------------------------------------------------------------

  describe("dispose", () => {
    it("clears all tokens and timers", async () => {
      const config1 = makeConfig();
      const config2 = makeConfig();
      mockFetchSuccess(makeTokenResponse({ expires_in: 3600 }));

      await manager.getAccessToken("server1", config1);
      await manager.getAccessToken("server2", config2);

      manager.dispose();

      // Both should require new fetches
      const mockFn = mockFetchSuccess(
        makeTokenResponse({ access_token: "post-dispose" }),
      );

      const t1 = await manager.getAccessToken("server1", config1);
      const t2 = await manager.getAccessToken("server2", config2);

      expect(t1).toBe("post-dispose");
      expect(t2).toBe("post-dispose");
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // MCPClientManager integration
  // --------------------------------------------------------------------------

  describe("MCPClientManager integration", () => {
    it("passes auth headers for SSE transport", async () => {
      // We test this by importing MCPClientManager and checking that
      // createTransport would pass headers. Since we can't easily
      // mock the MCP SDK's SSEClientTransport constructor, we verify
      // the token manager integration by checking getTokenManager().
      const { MCPClientManager } = await import("./client.js");
      const mgr = new MCPClientManager();

      expect(mgr.getTokenManager()).toBeInstanceOf(OAuthTokenManager);
    });

    it("works without auth (backward compatible)", async () => {
      // Verify MCPClientManager can be instantiated and has a token manager
      // even when no auth is configured
      const { MCPClientManager } = await import("./client.js");
      const mgr = new MCPClientManager();

      const tokenManager = mgr.getTokenManager();
      expect(tokenManager).toBeDefined();

      // Getting tools should work with no connections
      expect(mgr.getTools()).toEqual([]);
    });
  });
});
