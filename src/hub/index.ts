import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  HubServerEntry,
  HubRegistry,
  MCPServerConfig,
} from "../types/index.js";

// ============================================================================
// Seed data — built-in verified servers
// ============================================================================

const SEED_SERVERS: HubServerEntry[] = [
  {
    id: "nexus/filesystem",
    name: "Filesystem Tools",
    description: "Read, write, and manage files and directories",
    author: "nexus",
    source: "nexus-mcp-filesystem",
    transport: "stdio",
    command: "npx",
    args: ["nexus-mcp-filesystem"],
    tags: ["filesystem", "files", "core"],
    securityStatus: "verified",
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    downloads: 0,
  },
  {
    id: "nexus/git",
    name: "Git Operations",
    description: "Clone, commit, push, pull, and manage Git repositories",
    author: "nexus",
    source: "nexus-mcp-git",
    transport: "stdio",
    command: "npx",
    args: ["nexus-mcp-git"],
    tags: ["git", "vcs", "core"],
    securityStatus: "verified",
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    downloads: 0,
  },
  {
    id: "nexus/web-search",
    name: "Web Search",
    description: "Search the web using configurable search APIs",
    author: "nexus",
    source: "nexus-mcp-web-search",
    transport: "stdio",
    command: "npx",
    args: ["nexus-mcp-web-search"],
    requiredEnv: ["SEARCH_API_KEY"],
    tags: ["search", "web", "api"],
    securityStatus: "verified",
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    downloads: 0,
  },
  {
    id: "nexus/database",
    name: "Database Query",
    description: "Execute SQL queries against PostgreSQL, MySQL, and SQLite databases",
    author: "nexus",
    source: "nexus-mcp-database",
    transport: "stdio",
    command: "npx",
    args: ["nexus-mcp-database"],
    requiredEnv: ["DATABASE_URL"],
    tags: ["database", "sql", "data"],
    securityStatus: "verified",
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    downloads: 0,
  },
  {
    id: "nexus/slack-tools",
    name: "Slack Integration",
    description: "Send messages, manage channels, and interact with Slack workspaces",
    author: "nexus",
    source: "nexus-mcp-slack",
    transport: "stdio",
    command: "npx",
    args: ["nexus-mcp-slack"],
    requiredEnv: ["SLACK_TOKEN"],
    tags: ["slack", "messaging", "integration"],
    securityStatus: "verified",
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    downloads: 0,
  },
];

// ============================================================================
// NexusHub — Community MCP Server Directory
// ============================================================================

export class NexusHub {
  private registryPath: string;
  private registry: HubRegistry;

  constructor(dataDir?: string) {
    this.registryPath = join(
      dataDir ?? join(homedir(), ".nexus"),
      "hub-registry.json",
    );
    this.registry = this.loadRegistry();
  }

  /** Search servers by name, description, or tags */
  search(
    query: string,
    options?: { tag?: string; status?: string },
  ): HubServerEntry[] {
    let results = this.registry.servers.filter((entry) =>
      this.matchesQuery(entry, query),
    );

    if (options?.tag) {
      results = results.filter((e) => e.tags?.includes(options.tag!));
    }
    if (options?.status) {
      results = results.filter((e) => e.securityStatus === options.status);
    }

    return results;
  }

  /** Get a server entry by ID */
  get(id: string): HubServerEntry | undefined {
    return this.registry.servers.find((e) => e.id === id);
  }

  /** List all servers, optionally filtered */
  list(options?: {
    tag?: string;
    status?: string;
    limit?: number;
  }): HubServerEntry[] {
    let results = [...this.registry.servers];

    if (options?.tag) {
      results = results.filter((e) => e.tags?.includes(options.tag!));
    }
    if (options?.status) {
      results = results.filter((e) => e.securityStatus === options.status);
    }
    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /** Install a server (add to local config) — returns MCPServerConfig */
  install(id: string, env?: Record<string, string>): MCPServerConfig {
    const entry = this.get(id);
    if (!entry) {
      throw new Error(`Server not found: ${id}`);
    }

    // Check required env vars
    if (entry.requiredEnv) {
      for (const envVar of entry.requiredEnv) {
        if (!env?.[envVar] && !process.env[envVar]) {
          throw new Error(
            `Missing required environment variable: ${envVar}. ` +
              `Provide it via env parameter or set it in your environment.`,
          );
        }
      }
    }

    // Track download
    entry.downloads = (entry.downloads ?? 0) + 1;
    this.saveRegistry();

    return this.entryToMCPConfig(entry, env);
  }

  /** Uninstall a server (remove from local config) */
  uninstall(id: string): void {
    const entry = this.get(id);
    if (!entry) {
      throw new Error(`Server not found: ${id}`);
    }
    // Decrement download count if tracked
    if (entry.downloads && entry.downloads > 0) {
      entry.downloads -= 1;
      this.saveRegistry();
    }
  }

  /** Add or update a server entry in the local registry */
  publish(entry: HubServerEntry): void {
    const existingIndex = this.registry.servers.findIndex(
      (e) => e.id === entry.id,
    );
    if (existingIndex >= 0) {
      this.registry.servers[existingIndex] = entry;
    } else {
      this.registry.servers.push(entry);
    }
    this.saveRegistry();
  }

  /** Remove a server entry from the local registry */
  remove(id: string): void {
    const index = this.registry.servers.findIndex((e) => e.id === id);
    if (index < 0) {
      throw new Error(`Server not found: ${id}`);
    }
    this.registry.servers.splice(index, 1);
    this.saveRegistry();
  }

  /** Sync from remote registry URL */
  async sync(
    remoteUrl?: string,
  ): Promise<{ added: number; updated: number; removed: number }> {
    const url = remoteUrl ?? this.registry.remoteUrl;
    if (!url) {
      throw new Error(
        "No remote URL configured. Provide a URL or set remoteUrl in the registry.",
      );
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch remote registry: ${response.status} ${response.statusText}`,
      );
    }

    const remote = (await response.json()) as HubRegistry;
    const existingIds = new Set(this.registry.servers.map((e) => e.id));
    const remoteIds = new Set(remote.servers.map((e) => e.id));

    let added = 0;
    let updated = 0;
    let removed = 0;

    // Add or update remote entries
    for (const entry of remote.servers) {
      if (existingIds.has(entry.id)) {
        const idx = this.registry.servers.findIndex((e) => e.id === entry.id);
        this.registry.servers[idx] = entry;
        updated++;
      } else {
        this.registry.servers.push(entry);
        added++;
      }
    }

    // Remove entries not in remote
    this.registry.servers = this.registry.servers.filter((e) => {
      if (!remoteIds.has(e.id)) {
        removed++;
        return false;
      }
      return true;
    });

    this.registry.lastSynced = new Date().toISOString();
    this.registry.remoteUrl = url;
    this.saveRegistry();

    return { added, updated, removed };
  }

  /** Verify a server entry (check source exists, validate config) */
  async verify(
    id: string,
  ): Promise<{ valid: boolean; issues: string[] }> {
    const entry = this.get(id);
    const issues: string[] = [];

    if (!entry) {
      return { valid: false, issues: [`Server not found: ${id}`] };
    }

    // Check required fields
    if (!entry.name) issues.push("Missing name");
    if (!entry.description) issues.push("Missing description");
    if (!entry.author) issues.push("Missing author");
    if (!entry.source) issues.push("Missing source");
    if (!entry.version) issues.push("Missing version");

    // Check transport-specific fields
    if (entry.transport === "stdio") {
      if (!entry.command) issues.push("stdio transport requires command field");
    } else if (entry.transport === "http" || entry.transport === "sse") {
      if (!entry.url) issues.push(`${entry.transport} transport requires url field`);
    }

    // Check source is reachable (only for URL sources)
    if (entry.source.startsWith("http")) {
      try {
        const response = await fetch(entry.source, { method: "HEAD" });
        if (!response.ok) {
          issues.push(
            `Source URL returned ${response.status}: ${entry.source}`,
          );
        }
      } catch (err) {
        issues.push(
          `Source URL unreachable: ${entry.source} (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /** Get registry stats */
  stats(): {
    total: number;
    verified: number;
    community: number;
    tags: string[];
  } {
    const tagSet = new Set<string>();
    let verified = 0;
    let community = 0;

    for (const entry of this.registry.servers) {
      if (entry.securityStatus === "verified") verified++;
      if (entry.securityStatus === "community") community++;
      if (entry.tags) {
        for (const tag of entry.tags) {
          tagSet.add(tag);
        }
      }
    }

    return {
      total: this.registry.servers.length,
      verified,
      community,
      tags: [...tagSet].sort(),
    };
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private loadRegistry(): HubRegistry {
    if (existsSync(this.registryPath)) {
      try {
        const raw = readFileSync(this.registryPath, "utf-8");
        return JSON.parse(raw) as HubRegistry;
      } catch {
        // Corrupted file — reset
      }
    }

    // Seed with built-in servers (deep clone to avoid shared references)
    const registry: HubRegistry = {
      version: "1.0.0",
      servers: SEED_SERVERS.map((s) => ({ ...s, args: s.args ? [...s.args] : undefined, tags: s.tags ? [...s.tags] : undefined, requiredEnv: s.requiredEnv ? [...s.requiredEnv] : undefined })),
    };

    // Ensure directory exists and save
    const dir = dirname(this.registryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));

    return registry;
  }

  private saveRegistry(): void {
    const dir = dirname(this.registryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      this.registryPath,
      JSON.stringify(this.registry, null, 2),
    );
  }

  private matchesQuery(entry: HubServerEntry, query: string): boolean {
    const q = query.toLowerCase();
    return (
      entry.name.toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q) ||
      entry.author.toLowerCase().includes(q) ||
      entry.id.toLowerCase().includes(q) ||
      (entry.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
    );
  }

  private entryToMCPConfig(
    entry: HubServerEntry,
    env?: Record<string, string>,
  ): MCPServerConfig {
    const config: MCPServerConfig = {
      name: entry.id,
      transport: entry.transport,
    };

    if (entry.command) config.command = entry.command;
    if (entry.args) config.args = [...entry.args];
    if (entry.url) config.url = entry.url;

    // Merge env vars: provided env overrides process.env
    if (entry.requiredEnv && entry.requiredEnv.length > 0) {
      const mergedEnv: Record<string, string> = {};
      for (const key of entry.requiredEnv) {
        const value = env?.[key] ?? process.env[key];
        if (value) mergedEnv[key] = value;
      }
      if (Object.keys(mergedEnv).length > 0) {
        config.env = mergedEnv;
      }
    }

    return config;
  }
}
