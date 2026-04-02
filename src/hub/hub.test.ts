import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NexusHub } from "./index.js";
import type { HubServerEntry } from "../types/index.js";

describe("NexusHub", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nexus-hub-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Constructor / Registry loading
  // ==========================================================================

  it("creates registry file if not exists", () => {
    const hub = new NexusHub(tempDir);
    expect(existsSync(join(tempDir, "hub-registry.json"))).toBe(true);
  });

  it("loads existing registry", () => {
    // Create hub once to seed
    new NexusHub(tempDir);
    // Load again — should read from file
    const hub = new NexusHub(tempDir);
    const stats = hub.stats();
    expect(stats.total).toBe(5);
  });

  it("seeds built-in servers", () => {
    const hub = new NexusHub(tempDir);
    const stats = hub.stats();
    expect(stats.total).toBe(5);
    expect(stats.verified).toBe(5);
    expect(hub.get("nexus/filesystem")).toBeDefined();
    expect(hub.get("nexus/git")).toBeDefined();
    expect(hub.get("nexus/web-search")).toBeDefined();
    expect(hub.get("nexus/database")).toBeDefined();
    expect(hub.get("nexus/slack-tools")).toBeDefined();
  });

  // ==========================================================================
  // Search
  // ==========================================================================

  it("search - finds by name", () => {
    const hub = new NexusHub(tempDir);
    const results = hub.search("Filesystem");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("nexus/filesystem");
  });

  it("search - finds by description", () => {
    const hub = new NexusHub(tempDir);
    const results = hub.search("SQL queries");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("nexus/database");
  });

  it("search - finds by tag", () => {
    const hub = new NexusHub(tempDir);
    const results = hub.search("vcs");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("nexus/git");
  });

  it("search - case insensitive", () => {
    const hub = new NexusHub(tempDir);
    const results = hub.search("FILESYSTEM");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("nexus/filesystem");
  });

  it("search - returns empty for no matches", () => {
    const hub = new NexusHub(tempDir);
    const results = hub.search("nonexistent-foobar-xyz");
    expect(results).toEqual([]);
  });

  it("search - filters by securityStatus", () => {
    const hub = new NexusHub(tempDir);
    // Add a community server
    hub.publish({
      id: "community/test",
      name: "Community Test",
      description: "A community test server",
      author: "test",
      source: "test-pkg",
      transport: "stdio",
      command: "npx",
      args: ["test-pkg"],
      securityStatus: "community",
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    const results = hub.search("test", { status: "community" });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("community/test");
  });

  // ==========================================================================
  // Get
  // ==========================================================================

  it("get - returns entry by ID", () => {
    const hub = new NexusHub(tempDir);
    const entry = hub.get("nexus/git");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Git Operations");
  });

  it("get - returns undefined for unknown ID", () => {
    const hub = new NexusHub(tempDir);
    expect(hub.get("nonexistent/server")).toBeUndefined();
  });

  // ==========================================================================
  // List
  // ==========================================================================

  it("list - returns all servers", () => {
    const hub = new NexusHub(tempDir);
    const list = hub.list();
    expect(list.length).toBe(5);
  });

  it("list - filters by tag", () => {
    const hub = new NexusHub(tempDir);
    const list = hub.list({ tag: "core" });
    expect(list.length).toBe(2); // filesystem + git
  });

  it("list - filters by status", () => {
    const hub = new NexusHub(tempDir);
    hub.publish({
      id: "community/x",
      name: "X",
      description: "desc",
      author: "a",
      source: "pkg",
      transport: "stdio",
      command: "npx",
      args: ["pkg"],
      securityStatus: "community",
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    const verified = hub.list({ status: "verified" });
    expect(verified.length).toBe(5);
    const community = hub.list({ status: "community" });
    expect(community.length).toBe(1);
  });

  it("list - respects limit", () => {
    const hub = new NexusHub(tempDir);
    const list = hub.list({ limit: 2 });
    expect(list.length).toBe(2);
  });

  // ==========================================================================
  // Install
  // ==========================================================================

  it("install - returns valid MCPServerConfig for stdio server", () => {
    const hub = new NexusHub(tempDir);
    const config = hub.install("nexus/filesystem");
    expect(config.name).toBe("nexus/filesystem");
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("npx");
    expect(config.args).toEqual(["nexus-mcp-filesystem"]);
  });

  it("install - returns valid MCPServerConfig for http server", () => {
    const hub = new NexusHub(tempDir);
    hub.publish({
      id: "test/http-server",
      name: "HTTP Server",
      description: "An HTTP MCP server",
      author: "test",
      source: "http-server-pkg",
      transport: "http",
      url: "http://localhost:8080",
      securityStatus: "community",
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    const config = hub.install("test/http-server");
    expect(config.transport).toBe("http");
    expect(config.url).toBe("http://localhost:8080");
  });

  it("install - includes env vars", () => {
    const hub = new NexusHub(tempDir);
    const config = hub.install("nexus/web-search", {
      SEARCH_API_KEY: "test-key-123",
    });
    expect(config.env).toEqual({ SEARCH_API_KEY: "test-key-123" });
  });

  it("install - throws for unknown server", () => {
    const hub = new NexusHub(tempDir);
    expect(() => hub.install("nonexistent/server")).toThrow(
      "Server not found: nonexistent/server",
    );
  });

  // ==========================================================================
  // Uninstall
  // ==========================================================================

  it("uninstall - removes server", () => {
    const hub = new NexusHub(tempDir);
    // Install first to bump downloads
    hub.install("nexus/filesystem");
    const entry = hub.get("nexus/filesystem");
    expect(entry!.downloads).toBe(1);

    hub.uninstall("nexus/filesystem");
    const updated = hub.get("nexus/filesystem");
    expect(updated!.downloads).toBe(0);
  });

  // ==========================================================================
  // Publish
  // ==========================================================================

  it("publish - adds new entry", () => {
    const hub = new NexusHub(tempDir);
    const entry: HubServerEntry = {
      id: "custom/my-server",
      name: "My Server",
      description: "My custom MCP server",
      author: "me",
      source: "my-server-pkg",
      transport: "stdio",
      command: "npx",
      args: ["my-server-pkg"],
      securityStatus: "unreviewed",
      version: "0.1.0",
      updatedAt: new Date().toISOString(),
    };
    hub.publish(entry);
    expect(hub.get("custom/my-server")).toBeDefined();
    expect(hub.stats().total).toBe(6);
  });

  it("publish - updates existing entry", () => {
    const hub = new NexusHub(tempDir);
    const entry = hub.get("nexus/git")!;
    hub.publish({ ...entry, version: "2.0.0" });
    expect(hub.get("nexus/git")!.version).toBe("2.0.0");
    expect(hub.stats().total).toBe(5); // no duplicate
  });

  // ==========================================================================
  // Remove
  // ==========================================================================

  it("remove - removes entry", () => {
    const hub = new NexusHub(tempDir);
    hub.remove("nexus/filesystem");
    expect(hub.get("nexus/filesystem")).toBeUndefined();
    expect(hub.stats().total).toBe(4);
  });

  it("remove - throws for unknown ID", () => {
    const hub = new NexusHub(tempDir);
    expect(() => hub.remove("nonexistent/server")).toThrow(
      "Server not found: nonexistent/server",
    );
  });

  // ==========================================================================
  // Sync
  // ==========================================================================

  it("sync - fetches and merges remote registry", async () => {
    const hub = new NexusHub(tempDir);

    const remoteRegistry = {
      version: "1.0.0",
      servers: [
        {
          id: "nexus/filesystem",
          name: "Filesystem Tools (Updated)",
          description: "Updated filesystem tools",
          author: "nexus",
          source: "nexus-mcp-filesystem",
          transport: "stdio",
          command: "npx",
          args: ["nexus-mcp-filesystem"],
          tags: ["filesystem"],
          securityStatus: "verified",
          version: "2.0.0",
          updatedAt: new Date().toISOString(),
        },
        {
          id: "remote/new-server",
          name: "Remote Server",
          description: "A new remote server",
          author: "remote",
          source: "remote-pkg",
          transport: "stdio",
          command: "npx",
          args: ["remote-pkg"],
          securityStatus: "community",
          version: "1.0.0",
          updatedAt: new Date().toISOString(),
        },
      ],
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => remoteRegistry,
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await hub.sync("https://example.com/registry.json");

    expect(result.added).toBe(1); // remote/new-server
    expect(result.updated).toBe(1); // nexus/filesystem
    expect(result.removed).toBe(4); // the other 4 seed servers not in remote

    expect(hub.get("nexus/filesystem")!.version).toBe("2.0.0");
    expect(hub.get("remote/new-server")).toBeDefined();
    expect(hub.stats().total).toBe(2);
  });

  // ==========================================================================
  // Verify
  // ==========================================================================

  it("verify - valid entry passes", async () => {
    const hub = new NexusHub(tempDir);
    const result = await hub.verify("nexus/filesystem");
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("verify - missing fields fail", async () => {
    const hub = new NexusHub(tempDir);
    hub.publish({
      id: "bad/server",
      name: "Bad",
      description: "desc",
      author: "a",
      source: "pkg",
      transport: "http",
      // Missing url for http transport
      securityStatus: "unreviewed",
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
    });
    const result = await hub.verify("bad/server");
    expect(result.valid).toBe(false);
    expect(result.issues).toContain("http transport requires url field");
  });

  // ==========================================================================
  // Stats
  // ==========================================================================

  it("stats - returns correct counts and tags", () => {
    const hub = new NexusHub(tempDir);
    hub.publish({
      id: "community/x",
      name: "X",
      description: "desc",
      author: "a",
      source: "pkg",
      transport: "stdio",
      command: "npx",
      args: ["pkg"],
      tags: ["custom"],
      securityStatus: "community",
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
    });

    const stats = hub.stats();
    expect(stats.total).toBe(6);
    expect(stats.verified).toBe(5);
    expect(stats.community).toBe(1);
    expect(stats.tags).toContain("core");
    expect(stats.tags).toContain("custom");
    expect(stats.tags).toContain("git");
  });
});
