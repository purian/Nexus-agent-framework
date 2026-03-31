# Nexus

**An open-source, MCP-native personal AI agent framework.**

Secure. Composable. Multi-agent.

```
npm install nexus-agent
```

## Why Nexus?

| | OpenClaw | Nexus |
|---|---|---|
| **Security** | Broad permissions, criticized | Fine-grained per-tool permission system |
| **Architecture** | Monolithic platform integrations | MCP-native composable tool ecosystem |
| **Multi-agent** | Single agent | Coordinator + sub-agent orchestration |
| **Platform reach** | 30+ hardcoded | MCP servers as plugins — unlimited |
| **LLM support** | Multiple backends | Anthropic, OpenAI, local (pluggable) |
| **Interface** | Chat platforms only | CLI + Chat platforms + MCP server |

## Quick Start

### CLI Mode

```bash
# Interactive REPL
nexus

# Single-shot
nexus run "find all TODO comments in this project"

# As MCP server
nexus serve
```

### Programmatic Usage

```typescript
import { NexusEngine, AnthropicProvider, PermissionManager, createDefaultTools, loadConfig } from "nexus-agent";

const config = loadConfig();
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
const permissions = PermissionManager.createFromConfig(config);
const engine = new NexusEngine(provider, config, permissions);

// Register built-in tools
for (const tool of createDefaultTools()) {
  engine.registerTool(tool);
}

// Run the agent
for await (const event of engine.run("What files are in this directory?")) {
  if (event.type === "text") process.stdout.write(event.text);
  if (event.type === "tool_start") console.log(`\n[Using ${event.toolName}]`);
  if (event.type === "done") console.log(`\nTokens: ${event.totalUsage.inputTokens + event.totalUsage.outputTokens}`);
}
```

## Architecture

```
User Input
    ↓
┌─────────────────────────────────────────┐
│              NexusEngine                 │
│                                         │
│  ┌──────────┐    ┌──────────────────┐   │
│  │   LLM    │◄──►│   Tool Executor  │   │
│  │ Provider  │    │  (concurrent)    │   │
│  └──────────┘    └──────────────────┘   │
│       ▲               ▲                 │
│       │               │                 │
│  ┌────┴────┐    ┌─────┴──────────┐      │
│  │ Context  │    │  Permission    │      │
│  │ Manager  │    │  Manager       │      │
│  └─────────┘    └────────────────┘      │
└─────────────────────────────────────────┘
    ▲           ▲           ▲
    │           │           │
┌───┴──┐  ┌────┴───┐  ┌────┴────┐
│ MCP  │  │ Built- │  │ Plugin  │
│Client│  │  in    │  │ Tools   │
│      │  │ Tools  │  │         │
└──────┘  └────────┘  └─────────┘
```

### Core Components

- **NexusEngine** — The main agent loop. Streams LLM responses, executes tools, manages conversation.
- **Tool System** — Zod-validated tools with concurrency safety model. Safe tools run in parallel.
- **Permission Manager** — Fine-grained, per-tool permissions with allow/deny/ask rules from multiple sources.
- **MCP Integration** — First-class MCP client (consume external tools) and server (expose Nexus as a tool provider).
- **Agent Coordinator** — Spawn sub-agents for parallel work. Each agent gets its own engine and conversation.
- **Memory System** — SQLite-backed persistent memory with search, categorized by type (user, feedback, project, reference).
- **Plugin System** — Load tools and platforms from npm packages or local files.
- **Platform Adapters** — Connect to Telegram, Discord, Slack, and more.

## Configuration

```json
// ~/.nexus/config.json
{
  "defaultModel": "claude-sonnet-4-6",
  "defaultProvider": "anthropic",
  "permissionMode": "default",
  "permissionRules": [
    { "toolName": "ReadFile", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "git *", "behavior": "allow", "source": "user" }
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
  "thinking": { "enabled": true, "budgetTokens": 10000 }
}
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `NEXUS_MODEL` | Default model | `claude-sonnet-4-6` |
| `NEXUS_PROVIDER` | Default provider | `anthropic` |
| `NEXUS_DATA_DIR` | Data directory | `~/.nexus` |
| `NEXUS_PERMISSION_MODE` | Permission mode | `default` |
| `NEXUS_MAX_BUDGET` | Max budget in USD | — |

## Writing Plugins

```typescript
import type { Plugin } from "nexus-agent";

const myPlugin: Plugin = {
  name: "my-plugin",
  version: "1.0.0",
  tools: [
    // ... your Tool implementations
  ],
  async setup(nexus) {
    console.log("Plugin loaded!");
  },
};

export default myPlugin;
```

## Writing MCP Tools

Any MCP server works as a Nexus tool source:

```json
{
  "mcpServers": [
    {
      "name": "my-tools",
      "transport": "stdio",
      "command": "node",
      "args": ["my-mcp-server.js"]
    }
  ]
}
```

Tools are auto-discovered and available to the agent as `mcp__my-tools__toolName`.

## License

MIT
