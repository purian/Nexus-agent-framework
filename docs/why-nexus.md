# Why Nexus? Security-First AI Agents in a Post-Incident World

## The Problem

In early 2026, the AI agent ecosystem hit a wall. Security researchers found **512 vulnerabilities** across popular agent frameworks, and over **30,000 exposed agent instances** were discovered on the public internet — admin panels wide open, API keys leaking, and centralized plugin marketplaces serving as supply chain attack vectors.

The root cause wasn't a single bug. It was a design philosophy: **ship fast, connect everything, permissions are optional.**

That approach doesn't survive contact with production.

## How Nexus Is Different

Nexus was built from scratch as the secure alternative. Not a fork, not a patch — a ground-up rethink of what an AI agent framework should look like when security is a first-class concern.

### Zero Trust by Default

Most agent frameworks default to allowing everything. Nexus defaults to **asking the user**.

Every tool execution — file reads, shell commands, web requests — goes through a permission check. You explicitly allow what should be allowed, deny what shouldn't, and get prompted for everything else.

```
# Allow read-only tools globally
ReadFile  -> allow
Glob      -> allow
Grep      -> allow

# Allow specific shell commands
Bash(git *)       -> allow
Bash(npm test)    -> allow

# Block dangerous patterns
Bash(rm -rf *)    -> deny
Bash(sudo *)      -> deny

# Everything else -> ask the user
```

This isn't a single on/off switch. It's a **4-layer permission stack** (user, project, session, CLI) with glob pattern matching per tool. You can allow `git status` while blocking `git push --force`. You can permit `npm test` but deny `npm publish`.

### No Centralized Marketplace

The 2026 supply chain attacks exploited centralized plugin repositories — one compromised package, thousands of affected users. Nexus eliminates this vector entirely:

- **No marketplace.** Plugins are loaded locally from sources you trust.
- **MCP-native composability.** Instead of a proprietary plugin format, Nexus uses the open [Model Context Protocol](https://modelcontextprotocol.io). Any MCP server becomes a tool source — no vendor lock-in, no central point of compromise.
- **Hub with security review status.** The optional Nexus Hub directory tags servers as `verified`, `community`, or `unreviewed`, so you always know what's been audited.

### No Network Exposure by Default

Many agent frameworks spin up HTTP servers on startup — admin panels, API endpoints, WebSocket listeners. This is how 30,000 instances ended up publicly accessible.

Nexus runs as a **CLI/stdio process by default**. No ports, no listeners, no attack surface. If you want a web UI or MCP server, you opt in explicitly:

```bash
# Opt-in web UI with authentication
nexus web --port 3000 --auth-token my-secret

# Opt-in MCP server
nexus serve
```

### Multi-Agent Isolation

When Nexus spawns sub-agents for parallel tasks, each one gets:

- **Isolated conversation history** — agents can't read each other's context
- **Inherited permission rules** — no privilege escalation
- **Optional worktree isolation** — agents work in separate git worktrees
- **Structured messaging** — typed request/response patterns with audit trail, not raw string passing

A sub-agent can never do more than its parent is allowed to do.

## Head-to-Head Comparison

| Capability | Nexus | Typical AI Agent Frameworks |
|---|---|---|
| **Default permission mode** | Ask user (zero trust) | Allow all |
| **Permission granularity** | Per-tool with glob patterns | Single global toggle |
| **Permission sources** | 4 layers (user/project/session/CLI) | Single config file |
| **Read-only mode** | Built-in `--plan` flag | Not available |
| **Budget control** | Per-session USD limit + max turns | None |
| **Network exposure** | None by default | HTTP server by default |
| **Plugin model** | Local loading, no marketplace | Centralized marketplace |
| **Extension protocol** | MCP (open standard) | Proprietary plugin format |
| **Sub-agent isolation** | Isolated conversations + inherited permissions | Shared context |
| **Audit logging** | Full JSONL trail with sensitive data scrubbing | Minimal or none |
| **Encryption at rest** | AES-256-GCM for memory/data | None |
| **Role-based access** | RBAC with inheritance | None |
| **Rate limiting** | Per-tool and per-agent sliding window | None |
| **Sandboxed execution** | Docker containers with resource limits | Direct host execution |
| **Compliance** | SOC 2 guide, audit trails | None |
| **LLM providers** | 5 (Anthropic, OpenAI, Gemini, Bedrock, Ollama) | Usually 1-2 |
| **Multi-agent** | Coordinator with background agents, broadcast messaging | Single agent |
| **Platform adapters** | 7 (Telegram, Discord, Slack, WhatsApp, Email, Matrix, Webhook) | Varies |

## What Nexus Does Not Sacrifice

Security doesn't mean less capability. Nexus includes:

- **7 built-in tools** — Bash, ReadFile, WriteFile, EditFile, Glob, Grep, WebFetch
- **Multi-agent orchestration** — parallel sub-agents, background agents, structured messaging
- **5 LLM providers** — Anthropic, OpenAI, Google Gemini, AWS Bedrock, Ollama (local models)
- **7 platform adapters** — Telegram, Discord, Slack, WhatsApp, Email, Matrix, Webhook
- **Persistent memory** — SQLite with full-text search, encrypted at rest
- **MCP client and server** — consume and expose tools via the open standard
- **Web UI and VS Code extension** — browser and IDE interfaces
- **Self-development mode** — Nexus can work on its own codebase
- **Scheduled tasks and proactive agents** — cron-like automation
- **Multi-model routing** — cheap models for simple tasks, powerful models for complex ones
- **Cost optimization** — prompt caching, deduplication, compression

All of this runs through the same permission, audit, and rate-limiting infrastructure. Every tool call is logged. Every action is authorized. Every agent is isolated.

## The Design Principle

> An AI agent should never do more than what it's explicitly allowed to do.

Nexus follows the **principle of least privilege** at every layer — from the permission system, to sub-agent isolation, to network exposure, to plugin loading. Security is not a feature you bolt on later. It's the architecture.

---

## Getting Started

```bash
# Install
npm install nexus-agent

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Launch interactive session
npx nexus
```

Or run from source:

```bash
git clone https://github.com/purian/Nexus-agent-framework.git
cd Nexus-agent-framework
npm install && npm run build
node dist/cli/index.js
```

See the [main README](../README.md) for full documentation, configuration, and API reference.

---

*958 tests. 34 test files. Zero trust. [View on GitHub.](https://github.com/purian/Nexus-agent-framework)*
