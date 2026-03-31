# Nexus Agent Framework

**An open-source, MCP-native personal AI agent framework.**

Secure. Composable. Multi-agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-403%20passing-brightgreen.svg)]()

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Security First](#security-first)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Built-in Tools](#built-in-tools)
- [Permission System](#permission-system)
- [MCP Integration](#mcp-integration)
- [Multi-Agent Orchestration](#multi-agent-orchestration)
- [Memory System](#memory-system)
- [Platform Adapters](#platform-adapters)
- [Plugin System](#plugin-system)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Nexus is a personal AI agent framework built from the ground up with security, composability, and multi-agent orchestration at its core. Unlike monolithic alternatives that hardcode dozens of platform integrations, Nexus uses the **Model Context Protocol (MCP)** as its native extension mechanism — any MCP server instantly becomes a tool source.

Nexus gives you:
- A powerful **CLI with interactive REPL** for terminal-based AI assistance
- A **programmatic SDK** for embedding AI agents in your applications
- **Multi-agent orchestration** for breaking complex tasks into parallel sub-agents
- **Fine-grained security** with per-tool permission rules
- **Persistent memory** across sessions with full-text search
- **Platform connectivity** to Telegram, Discord, Slack, and any MCP-compatible service

## Key Features

| Feature | Description |
|---|---|
| **MCP-Native** | First-class MCP client and server — consume external tools or expose Nexus as a tool provider |
| **Fine-Grained Permissions** | Per-tool allow/deny/ask rules with pattern matching, multi-source priority |
| **Multi-Agent** | Coordinator spawns parallel sub-agents, each with isolated conversation and tools |
| **Streaming Engine** | Async generator-based core with real-time streaming of LLM responses and tool progress |
| **Concurrent Tool Execution** | Safe tools run in parallel; unsafe tools are automatically serialized |
| **Persistent Memory** | SQLite-backed memory with FTS5 full-text search, categorized by type |
| **Plugin System** | Load tools and platforms from npm packages or local files |
| **Platform Adapters** | Built-in connectors for Telegram, Discord, and Slack |
| **Token Budget Tracking** | Automatic cost estimation and budget enforcement |
| **Type-Safe** | Full TypeScript with Zod validation at every boundary |

---

## Security First

AI agents that execute code, access files, and connect to external services must be **secure by default**. The 2026 wave of AI agent security incidents — exposed instances, leaked API keys, malicious plugin marketplaces — demonstrated that security cannot be an afterthought.

Nexus was designed from day one with a **zero-trust architecture** for tool execution:

### How Nexus Keeps You Safe

| Threat | How Nexus Mitigates |
|---|---|
| **Unauthorized tool execution** | Every tool requires explicit permission. Default mode = `ask` the user |
| **Overly broad access** | Per-tool rules with pattern matching. Allow `git status` but deny `rm -rf /` |
| **Malicious plugins** | No centralized marketplace. Plugins are loaded locally from trusted sources |
| **Exposed instances** | No HTTP server by default. CLI and stdio-only unless explicitly configured |
| **API key leakage** | Keys read from env vars, never stored in config files or transmitted to plugins |
| **Runaway agents** | Token budget limits, max turn limits, abort signals propagated through the entire chain |
| **Sub-agent escalation** | Sub-agents inherit parent's permission rules. No privilege escalation by default |

### Permission Model in Practice

```
# Allow read-only tools globally
ReadFile  -> allow
Glob      -> allow
Grep      -> allow

# Allow specific shell commands
Bash(git *)       -> allow
Bash(npm test)    -> allow
Bash(npm run *)   -> allow

# Block dangerous patterns
Bash(rm -rf *)    -> deny
Bash(curl * | sh) -> deny
Bash(sudo *)      -> deny

# Everything else -> ask the user
```

### Comparison with Alternatives

| Security Feature | Nexus | Typical AI Agents |
|---|---|---|
| Default permission mode | Ask user | Allow all |
| Per-tool granularity | Yes, with patterns | No |
| Rule sources | 4 layers (user/project/session/cli) | Single config |
| Read-only mode | Built-in `plan` mode | Not available |
| Budget enforcement | Per-session USD limit | None |
| Sub-agent isolation | Isolated conversations + inherited rules | Shared context |
| Auth required | Always (API key) | Often optional |
| Network exposure | None by default | HTTP often default |

> **Philosophy:** An AI agent should never do more than what it's explicitly allowed to do. Nexus follows the principle of least privilege at every layer.

---

## Quick Start

### 1. Install

```bash
npm install nexus-agent
```

### 2. Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 3. Run the interactive REPL

```bash
npx nexus
```

That's it! You're now in an interactive AI agent session with access to file operations, shell commands, web fetching, and more.

### Other modes

```bash
# Single-shot: run a prompt and exit
npx nexus run "find all TODO comments in this project and summarize them"

# Expose Nexus as an MCP server for other tools to consume
npx nexus serve

# View current configuration
npx nexus config
```

---

## Installation

### From npm

```bash
npm install nexus-agent
```

### From source

```bash
git clone https://github.com/purian/Nexus-agent-framework.git
cd Nexus-agent-framework
npm install
npm run build
```

### Requirements

- **Node.js** >= 20.0.0
- An **Anthropic API key** (or other supported LLM provider)

---

## Usage

### CLI Mode

```bash
# Interactive REPL with streaming responses
nexus

# Single-shot execution
nexus run "refactor the auth module to use JWT tokens"

# Start as MCP server (other tools can consume Nexus)
nexus serve

# Show/edit configuration
nexus config
nexus config --json

# CLI options
nexus --model claude-sonnet-4-6 --permission-mode allowAll --max-budget 5.00
```

#### REPL Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/tools` | List registered tools |
| `/usage` | Show token usage stats |
| `/reset` | Clear conversation history |
| `/quit` | Exit the REPL |

### Programmatic SDK

```typescript
import {
  NexusEngine,
  AnthropicProvider,
  PermissionManager,
  createDefaultTools,
  loadConfig,
} from "nexus-agent";

// Load configuration (merges defaults, config files, env vars)
const config = loadConfig();

// Create LLM provider
const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Create permission manager
const permissions = PermissionManager.createFromConfig(config);

// Create the engine
const engine = new NexusEngine(provider, config, permissions);

// Register built-in tools
for (const tool of createDefaultTools()) {
  engine.registerTool(tool);
}

// Run the agent — events stream in real-time
for await (const event of engine.run("What files are in this directory?")) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.text);
      break;
    case "thinking":
      // Extended thinking (if enabled)
      break;
    case "tool_start":
      console.log(`\n[Using ${event.toolName}]`);
      break;
    case "tool_end":
      if (event.isError) console.error(`[Error: ${event.result}]`);
      break;
    case "permission_request":
      // Auto-allow or prompt user
      event.resolve({ behavior: "allow" });
      break;
    case "done":
      console.log(`\nTotal tokens: ${event.totalUsage.inputTokens + event.totalUsage.outputTokens}`);
      break;
  }
}
```

### Multi-Turn Conversations

```typescript
// First turn
for await (const event of engine.run("Read the package.json file")) {
  // handle events...
}

// Second turn — engine remembers context
for await (const event of engine.run("Now add a 'lint' script to it")) {
  // handle events...
}

// Reset when needed
engine.reset();
```

---

## Architecture

```
User Input (CLI / SDK / Platform Message)
    |
    v
+-------------------------------------------+
|              NexusEngine                   |
|                                           |
|  +------------+    +------------------+   |
|  |    LLM     |<-->|  Tool Executor   |   |
|  |  Provider   |    | (concurrent)    |   |
|  +------------+    +------------------+   |
|       ^                  ^                |
|       |                  |                |
|  +----+------+    +------+----------+     |
|  |  Context   |    |  Permission    |     |
|  |  Manager   |    |  Manager      |     |
|  +-----------+    +---------------+     |
+-------------------------------------------+
    ^           ^           ^
    |           |           |
+---+---+  +---+----+  +---+-----+
|  MCP  |  | Built- |  | Plugin  |
| Client|  |  in    |  | Tools   |
|       |  | Tools  |  |         |
+-------+  +--------+  +---------+
```

### Core Pipeline

```
User Message → LLM API (streaming) → Tool Calls → Execute Tools → Feed Results Back → Repeat
```

1. **User submits a message** via CLI, SDK, or platform adapter
2. **NexusEngine** sends the conversation to the LLM provider (streaming)
3. If the LLM requests **tool use**, the engine:
   - Validates input against Zod schemas
   - Checks permissions (allow/deny/ask)
   - Executes tools (safe tools in parallel, unsafe serialized)
   - Feeds results back to the LLM
4. The loop continues until the LLM returns a final text response
5. **Events stream in real-time** throughout the process

### Core Components

| Component | Description |
|---|---|
| **NexusEngine** | The main agent loop. Streams LLM responses, executes tools, tracks usage |
| **LLM Provider** | Pluggable interface for any LLM backend (Anthropic included) |
| **Tool System** | Zod-validated tools with concurrency safety model |
| **Permission Manager** | Fine-grained per-tool permissions with pattern matching |
| **MCP Client/Server** | Consume external MCP tools or expose Nexus as an MCP server |
| **Agent Coordinator** | Spawn and manage parallel sub-agents |
| **Memory Manager** | SQLite-backed persistent memory with FTS5 search |
| **Plugin Loader** | Dynamic plugin loading from npm or filesystem |
| **Platform Adapters** | Telegram, Discord, Slack connectivity |

---

## LLM Providers

Nexus supports multiple LLM providers out of the box, with zero-dependency HTTP implementations (no SDK lock-in).

| Provider | Models | Config |
|---|---|---|
| **Anthropic** | Claude Sonnet, Opus, Haiku | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-4o, o1, o3 | `OPENAI_API_KEY` |
| **Ollama** | Llama, Mistral, Gemma, any local model | Local (no key needed) |
| **Fallback** | Chain any providers with auto-failover | Programmatic |

### Switching Providers

```bash
# Use OpenAI
nexus --provider openai --model gpt-4o

# Use local Ollama
nexus --provider ollama --model llama3

# Via environment
NEXUS_PROVIDER=openai NEXUS_MODEL=gpt-4o nexus
```

### Provider Fallback

Chain providers so if one fails, the next is tried automatically:

```typescript
import { AnthropicProvider, OpenAIProvider, FallbackProvider } from "nexus-agent";

const provider = new FallbackProvider([
  new AnthropicProvider(),  // Try Anthropic first
  new OpenAIProvider(),      // Fall back to OpenAI
]);
```

### Custom Base URLs

Both OpenAI and Ollama providers support custom base URLs for proxies or self-hosted instances:

```typescript
import { OpenAIProvider } from "nexus-agent";

// Use with any OpenAI-compatible API
const provider = new OpenAIProvider({
  baseUrl: "https://my-proxy.example.com/v1",
  apiKey: "my-key",
});
```

---

## Docker

### Quick Start with Docker

```bash
# Build
docker build -t nexus .

# Run interactive REPL
docker run -it -e ANTHROPIC_API_KEY=sk-ant-... nexus

# Run single command
docker run -e ANTHROPIC_API_KEY=sk-ant-... nexus node dist/cli/index.js run "hello"
```

### Docker Compose

```bash
# Copy env file and set your keys
cp .env.example .env

# Run REPL mode
docker compose run nexus

# Run MCP server mode (port 3000)
docker compose up nexus-server
```

---

## Configuration

Nexus loads configuration from multiple sources (in precedence order):

1. **Defaults** — sensible out-of-the-box values
2. **User config** — `~/.nexus/config.json`
3. **Project config** — `.nexus.json` in the current directory
4. **Environment variables** — `NEXUS_*` vars
5. **CLI arguments** — `--model`, `--provider`, etc.
6. **Programmatic overrides** — `loadConfig({ ... })`

### Example Config

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "defaultProvider": "anthropic",
  "permissionMode": "default",
  "permissionRules": [
    { "toolName": "ReadFile", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "git *", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "rm *", "behavior": "deny", "source": "user" }
  ],
  "mcpServers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  ],
  "plugins": [],
  "maxConcurrentTools": 5,
  "maxBudgetUsd": 10.00,
  "thinking": { "enabled": true, "budgetTokens": 10000 }
}
```

---

## Built-in Tools

Nexus ships with 7 production-ready tools:

| Tool | Description | Concurrent | Read-Only |
|---|---|---|---|
| **Bash** | Execute shell commands with timeout support | No | No |
| **ReadFile** | Read file content with optional line range | Yes | Yes |
| **WriteFile** | Write content to files, auto-creates directories | No | No |
| **EditFile** | Search-and-replace editing with uniqueness validation | No | No |
| **Glob** | Find files matching glob patterns | Yes | Yes |
| **Grep** | Search file contents using regex (ripgrep with fallback) | Yes | Yes |
| **WebFetch** | Fetch URL content via HTTP | Yes | Yes |

### Custom Tools

```typescript
import { z } from "zod";
import type { Tool } from "nexus-agent";

const myTool: Tool<{ query: string }, string> = {
  name: "SearchDocs",
  description: "Search the project documentation for a given query",
  inputSchema: z.object({ query: z.string().describe("Search query") }),

  async execute(input, context) {
    // Your implementation
    const results = await searchDocumentation(input.query);
    return { data: results };
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,
};

engine.registerTool(myTool);
```

---

## Permission System

Nexus provides fine-grained, per-tool permissions — one of its key differentiators.

### Permission Modes

| Mode | Behavior |
|---|---|
| `default` | Evaluate rules; fall back to prompting the user |
| `allowAll` | Auto-allow all tool executions |
| `denyAll` | Auto-deny all tool executions |
| `plan` | Allow read-only tools, deny everything else |

### Permission Rules

Rules match tools by name and optional input pattern:

```json
{
  "permissionRules": [
    { "toolName": "ReadFile", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "git *", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "rm -rf *", "behavior": "deny", "source": "user" },
    { "toolName": "WriteFile", "behavior": "ask", "source": "project" }
  ]
}
```

### Priority Order

Rules from higher-priority sources override lower ones:

```
CLI args > Session > Project > User settings
```

### Pattern Matching

- `*` — matches any characters (e.g., `git *` matches `git status`, `git commit -m "fix"`)
- `?` — matches exactly one character
- `**` — matches anything including empty string
- No pattern — matches all invocations of the tool

---

## MCP Integration

Nexus is both an **MCP client** (consume tools from external servers) and an **MCP server** (expose Nexus tools to other applications).

### Consuming MCP Tools

Add MCP servers to your config, and their tools are auto-discovered:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    {
      "name": "postgres",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    },
    {
      "name": "remote-api",
      "transport": "sse",
      "url": "https://my-mcp-server.example.com/sse"
    }
  ]
}
```

Discovered tools are available as `mcp__<serverName>__<toolName>` and work seamlessly with the permission system and agent orchestration.

### Exposing Nexus as MCP Server

```bash
nexus serve
```

This starts Nexus as a stdio MCP server, allowing other MCP clients (IDEs, other agents) to use Nexus tools.

### Programmatic MCP Usage

```typescript
import { MCPClientManager } from "nexus-agent";

const mcp = new MCPClientManager();
await mcp.connectServer({
  name: "my-server",
  transport: "stdio",
  command: "node",
  args: ["my-mcp-server.js"],
});

// Get all tools and register with engine
for (const tool of mcp.getTools()) {
  engine.registerTool(tool);
}
```

---

## Multi-Agent Orchestration

Nexus supports spawning sub-agents for parallel task execution. Each sub-agent gets its own engine, conversation, and tools.

### Using the Agent Coordinator

```typescript
import { AgentCoordinator, AnthropicProvider } from "nexus-agent";

const coordinator = new AgentCoordinator(config);

// Spawn agents
const researcherId = coordinator.spawnAgent(
  { id: "r1", name: "researcher", model: "claude-sonnet-4-6" },
  provider,
);

const writerId = coordinator.spawnAgent(
  { id: "w1", name: "writer", model: "claude-sonnet-4-6", parentId: researcherId },
  provider,
);

// Run agents in parallel
const researchPromise = async () => {
  for await (const event of coordinator.runAgent(researcherId, "Research the auth module")) {
    // handle events
  }
};

const writePromise = async () => {
  for await (const event of coordinator.runAgent(writerId, "Write unit tests for auth")) {
    // handle events
  }
};

await Promise.all([researchPromise(), writePromise()]);

// Collect results
const results = coordinator.collectResults();
console.log(results.get(researcherId)); // Research findings
console.log(results.get(writerId));     // Written tests
```

### Agent Tool (LLM-Driven Spawning)

The LLM can spawn sub-agents autonomously using the built-in Agent tool:

```typescript
import { createAgentTool, AgentCoordinator } from "nexus-agent";

const coordinator = new AgentCoordinator(config);
const agentTool = createAgentTool(coordinator, provider);
engine.registerTool(agentTool);

// Now the LLM can spawn agents via tool use:
// Agent({ prompt: "Research all API endpoints", name: "researcher" })
```

---

## Memory System

Nexus provides persistent memory across sessions, backed by SQLite with FTS5 full-text search.

### Memory Types

| Type | Description |
|---|---|
| `user` | User preferences, role, knowledge level |
| `feedback` | Guidance on how to approach work |
| `project` | Non-obvious project context, deadlines, decisions |
| `reference` | Pointers to external resources |

### Using Memory

```typescript
import { MemoryManager } from "nexus-agent";

const memory = MemoryManager.create("~/.nexus");

// Save a memory
await memory.save({
  type: "project",
  name: "Auth Rewrite",
  description: "Authentication module is being rewritten for compliance",
  content: "Legal flagged session token storage. Deadline: March 15. Use JWT.",
  tags: ["auth", "compliance"],
});

// Search memories
const results = await memory.search("authentication");

// List by type
const projectMemories = await memory.list("project");
```

### Memory Tool

The built-in Memory tool lets the LLM manage memories autonomously:

```typescript
import { createMemoryTool, MemoryManager } from "nexus-agent";

const memory = MemoryManager.create(config.dataDirectory);
const memoryTool = createMemoryTool(memory);
engine.registerTool(memoryTool);

// The LLM can now save/search/list/delete memories via tool use
```

---

## Platform Adapters

Connect Nexus to messaging platforms so users can interact via their preferred chat app.

### Telegram

```typescript
import { TelegramAdapter } from "nexus-agent";

const telegram = new TelegramAdapter();
await telegram.connect({ token: process.env.TELEGRAM_BOT_TOKEN });

telegram.onMessage(async (msg) => {
  for await (const event of engine.run(msg.text)) {
    if (event.type === "done") {
      await telegram.sendMessage(msg.chatId, collectedResponse);
    }
  }
});
```

### Discord

```typescript
import { DiscordAdapter } from "nexus-agent";

const discord = new DiscordAdapter();
await discord.connect({
  token: process.env.DISCORD_BOT_TOKEN,
  intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
});

discord.onMessage(async (msg) => {
  // Process with engine and reply
  await discord.sendMessage(msg.chatId, response);
});
```

### Slack

```typescript
import { SlackAdapter } from "nexus-agent";

const slack = new SlackAdapter();
await slack.connect({
  appToken: process.env.SLACK_APP_TOKEN,
  botToken: process.env.SLACK_BOT_TOKEN,
});

slack.onMessage(async (msg) => {
  await slack.sendMessage(msg.chatId, response);
});
```

### Factory Function

```typescript
import { createPlatform } from "nexus-agent";

const adapter = createPlatform("telegram");
await adapter.connect({ token: "..." });
```

---

## Plugin System

Extend Nexus with custom tools and platform adapters via plugins.

### Writing a Plugin

```typescript
import type { Plugin } from "nexus-agent";

const myPlugin: Plugin = {
  name: "my-plugin",
  version: "1.0.0",
  description: "Adds custom tools for my workflow",
  tools: [
    // ... your Tool implementations
  ],
  platforms: [
    // ... your PlatformAdapter implementations
  ],
  async setup(nexus) {
    console.log("Plugin loaded with config:", nexus.config);
  },
  async teardown() {
    console.log("Plugin unloaded");
  },
};

export default myPlugin;
```

### Loading Plugins

```typescript
import { PluginLoader } from "nexus-agent";

const loader = new PluginLoader();

// Load from npm package
await loader.load("nexus-plugin-jira");

// Load from local file
await loader.load("./my-plugins/custom-tools.js");

// Load all and initialize
const plugins = await loader.loadAll(
  ["nexus-plugin-jira", "./my-plugins/custom-tools.js"],
  nexusRuntime,
);
```

### Via Configuration

```json
{
  "plugins": [
    "nexus-plugin-jira",
    "./custom/my-plugin.js"
  ]
}
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OPENAI_API_KEY` | OpenAI API key (for future providers) | — |
| `NEXUS_MODEL` | Default LLM model | `claude-sonnet-4-6` |
| `NEXUS_PROVIDER` | Default LLM provider | `anthropic` |
| `NEXUS_DATA_DIR` | Data directory for memory, config | `~/.nexus` |
| `NEXUS_PERMISSION_MODE` | Permission mode (`default`, `allowAll`, `denyAll`, `plan`) | `default` |
| `NEXUS_MAX_BUDGET` | Max budget per session in USD | — |
| `NEXUS_MAX_CONCURRENT` | Max concurrent tool executions | `4` |
| `NEXUS_THINKING` | Enable extended thinking (`true`/`false`) | `false` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | — |
| `DISCORD_BOT_TOKEN` | Discord bot token | — |
| `SLACK_APP_TOKEN` | Slack app-level token | — |
| `SLACK_BOT_TOKEN` | Slack bot token | — |

---

## Testing

Nexus has a comprehensive test suite with 384 tests covering all core modules.

```bash
# Run all tests
npm test

# Run in watch mode
npm run test:watch

# Run specific test file
npx vitest run src/permissions/index.test.ts
```

### Test Coverage

| Module | Tests | Description |
|---|---|---|
| Permission System | 51 | Modes, rules, priority, pattern matching |
| Core Engine | 45 | Tool loop, streaming, concurrency, budget, abort |
| Built-in Tools | 22 | Real filesystem operations in temp directories |
| Memory System | 57 | SQLite CRUD, FTS5 search, memory tool |
| Agent Coordinator | 55 | Spawning, messaging, lifecycle management |
| Config System | 68 | Defaults, env vars, full precedence chain |
| OpenAI Provider | 18 | SSE parsing, tool calling, error handling |
| Ollama Provider | 17 | Streaming, local connection, model listing |
| Fallback Provider | 9 | Failover chains, error propagation |
| Context Compressor | 13 | Token estimation, compression logic |
| Skill System | 17 | Frontmatter parsing, arg substitution, tool |
| Audit Logger | 12 | JSONL logging, scrubbing, truncation |
| **Total** | **384** | **All passing** |

---

## Project Structure

```
nexus/
├── src/
│   ├── index.ts                  # Main exports
│   ├── types/
│   │   └── index.ts              # All TypeScript interfaces
│   ├── core/
│   │   ├── engine.ts             # NexusEngine — main agent loop
│   │   ├── tool-executor.ts      # Tool management
│   │   └── providers/
│   │       ├── anthropic.ts      # Anthropic LLM provider
│   │       ├── openai.ts         # OpenAI LLM provider (GPT-4o, o1, o3)
│   │       ├── ollama.ts         # Ollama local model provider
│   │       └── fallback.ts       # Auto-failover provider chain
│   │   ├── context-compressor.ts # Auto-summarization for long sessions
│   │   └── audit-logger.ts       # JSONL tool execution logging
│   ├── tools/
│   │   ├── index.ts              # Tool exports + createDefaultTools()
│   │   ├── bash.ts               # Shell execution
│   │   ├── read-file.ts          # File reading
│   │   ├── write-file.ts         # File writing
│   │   ├── edit-file.ts          # Search & replace
│   │   ├── glob.ts               # File pattern matching
│   │   ├── grep.ts               # Content search
│   │   └── web-fetch.ts          # HTTP fetching
│   ├── permissions/
│   │   └── index.ts              # PermissionManager
│   ├── mcp/
│   │   ├── index.ts              # MCP exports
│   │   ├── client.ts             # MCP client (consume tools)
│   │   └── server.ts             # MCP server (expose tools)
│   ├── agents/
│   │   ├── index.ts              # Agent exports
│   │   ├── coordinator.ts        # AgentCoordinator
│   │   ├── agent-tool.ts         # Agent spawning tool
│   │   └── message-tool.ts       # Inter-agent messaging
│   ├── memory/
│   │   ├── index.ts              # MemoryManager (SQLite)
│   │   └── tool.ts               # Memory tool for LLM
│   ├── skills/
│   │   ├── index.ts              # Skills exports
│   │   ├── loader.ts             # SkillLoader (YAML frontmatter parser)
│   │   └── skill-tool.ts         # Skill execution tool
│   ├── plugins/
│   │   └── index.ts              # PluginLoader
│   ├── platforms/
│   │   ├── index.ts              # Platform factory
│   │   ├── telegram.ts           # Telegram adapter
│   │   ├── discord.ts            # Discord adapter
│   │   └── slack.ts              # Slack adapter
│   ├── config/
│   │   └── index.ts              # Configuration loading
│   └── cli/
│       ├── index.ts              # CLI entry point
│       └── repl.ts               # Interactive REPL
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── README.md
```

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/your-username/Nexus-agent-framework.git`
3. **Install** dependencies: `npm install`
4. **Create** a branch: `git checkout -b feature/my-feature`
5. **Make** your changes
6. **Run** tests: `npm test`
7. **Run** type check: `npm run typecheck`
8. **Submit** a pull request

### Development Commands

```bash
npm run dev          # Start in watch mode
npm run build        # Production build
npm run typecheck    # TypeScript type checking
npm run lint         # Lint with Biome
npm run lint:fix     # Auto-fix lint issues
npm test             # Run tests
npm run test:watch   # Tests in watch mode
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
