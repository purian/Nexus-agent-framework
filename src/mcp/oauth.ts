import type { MCPOAuthConfig } from "../types/index.js";

// ============================================================================
// Types
// ============================================================================

export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number; // Unix timestamp in ms
  refreshToken?: string;
  scope?: string;
}

// ============================================================================
// OAuth Token Manager
// ============================================================================

/**
 * Manages OAuth 2.0 tokens for MCP server connections.
 *
 * Handles fetching, caching, refreshing, and revoking tokens using the
 * client_credentials and refresh_token grant types.
 */
export class OAuthTokenManager {
  private tokens = new Map<string, OAuthToken>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Get a valid access token for a server, fetching/refreshing as needed.
   */
  async getAccessToken(
    serverName: string,
    config: MCPOAuthConfig,
  ): Promise<string> {
    const bufferSeconds = config.refreshBufferSeconds ?? 60;
    const cached = this.tokens.get(serverName);

    if (cached && !this.isTokenExpired(cached, bufferSeconds)) {
      return cached.accessToken;
    }

    // Token is expired or missing — try refresh first if we have a refresh token
    if (cached?.refreshToken) {
      try {
        const refreshed = await this.fetchToken(config, cached.refreshToken);
        this.tokens.set(serverName, refreshed);
        this.scheduleRefresh(serverName, config, refreshed);
        return refreshed.accessToken;
      } catch {
        // Refresh failed — fall through to fetch a new token
      }
    }

    // Fetch a brand new token
    const token = await this.fetchToken(config);
    this.tokens.set(serverName, token);
    this.scheduleRefresh(serverName, config, token);
    return token.accessToken;
  }

  /**
   * Revoke and clear tokens for a server.
   */
  async revokeToken(serverName: string): Promise<void> {
    this.tokens.delete(serverName);
    const timer = this.refreshTimers.get(serverName);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(serverName);
    }
  }

  /**
   * Clear all tokens and timers.
   */
  dispose(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.tokens.clear();
    this.refreshTimers.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Fetch a token from the OAuth token endpoint.
   *
   * Uses client_credentials grant for initial fetch, refresh_token grant
   * when a refresh token is provided.
   */
  async fetchToken(
    config: MCPOAuthConfig,
    refreshToken?: string,
  ): Promise<OAuthToken> {
    const params = new URLSearchParams();

    if (refreshToken) {
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", refreshToken);
    } else {
      params.set("grant_type", "client_credentials");
    }

    params.set("client_id", config.clientId);
    if (config.clientSecret) {
      params.set("client_secret", config.clientSecret);
    }
    if (config.scopes?.length) {
      params.set("scope", config.scopes.join(" "));
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...config.tokenRequestHeaders,
    };

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers,
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OAuth token request failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error("OAuth token response missing access_token");
    }

    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;

    return {
      accessToken: data.access_token as string,
      tokenType: (data.token_type as string) ?? "Bearer",
      expiresAt: Date.now() + expiresIn * 1000,
      refreshToken: (data.refresh_token as string) ?? undefined,
      scope: (data.scope as string) ?? undefined,
    };
  }

  /**
   * Check whether a token is expired, accounting for a buffer.
   */
  isTokenExpired(token: OAuthToken, bufferSeconds: number): boolean {
    return Date.now() >= token.expiresAt - bufferSeconds * 1000;
  }

  /**
   * Schedule a proactive token refresh before it expires.
   */
  scheduleRefresh(
    serverName: string,
    config: MCPOAuthConfig,
    token: OAuthToken,
  ): void {
    // Clear any existing timer
    const existing = this.refreshTimers.get(serverName);
    if (existing) {
      clearTimeout(existing);
    }

    const bufferSeconds = config.refreshBufferSeconds ?? 60;
    const delay = token.expiresAt - bufferSeconds * 1000 - Date.now();

    if (delay > 0) {
      const timer = setTimeout(async () => {
        this.refreshTimers.delete(serverName);
        try {
          await this.getAccessToken(serverName, config);
        } catch {
          // Proactive refresh failed — will be retried on next getAccessToken call
        }
      }, delay);

      // Unref the timer so it doesn't keep the process alive
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.refreshTimers.set(serverName, timer);
    }
  }
}
