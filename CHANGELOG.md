# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-04-02

### Added
- **OAuth 2.0 for MCP Servers** — Full OAuth 2.0 authentication for remote MCP server connections. `OAuthTokenManager` handles client_credentials and refresh_token grants, automatic token caching, proactive refresh scheduling before expiry, and graceful fallback when refresh fails. `MCPServerConfig` now accepts an `auth` field with `authorizationUrl`, `tokenUrl`, `clientId`, `clientSecret`, `scopes`, custom token request headers, and configurable refresh buffer. Authorization headers are automatically injected into SSE/HTTP transports. Tokens are revoked on disconnect and cleaned up on shutdown
- **Sandboxed Execution** — Bash commands can optionally execute inside Docker containers for full isolation. `DockerSandbox` builds `docker run` commands with configurable memory limits, CPU limits, network mode (`none`/`bridge`/`host`), read-only and read-write volume mounts, and environment variables. Working directory is always mounted at `/workspace`. Supports timeout (via `docker kill`), abort signals, and progress streaming. Active containers are tracked and cleaned up on shutdown. Falls back to direct execution when sandbox is disabled or Docker is unavailable
- **51 new tests** — OAuth token manager (26), Docker sandbox (25). Total: 620 tests

### Changed
- `MCPServerConfig` type extended with optional `auth` field
- `MCPClientManager.connectServer()` now handles OAuth token injection for remote transports
- `NexusConfig` type extended with optional `sandbox` field
- Bash tool routes through `DockerSandbox` when `config.sandbox.enabled` is true

## [0.9.0] - 2026-04-01

### Added
- **Agent Definitions** — Custom agent types loaded from `.nexus/agents/*.md` files. Each definition specifies a name, description, system prompt, allowed tools, model override, max turns, and temperature. Project-level definitions override global ones. Integrated into AgentCoordinator (`spawnAgent` accepts `definitionName`) and the Agent tool (`definition` field)
- **Worktree Isolation** — Sub-agents can run in isolated git worktrees via `WorktreeManager`. Creates temp worktrees with unique branches (`nexus-agent-<uuid>`), auto-cleans worktrees with no changes on completion, preserves worktrees with changes and returns path + branch. Integrated into AgentCoordinator (`isolation: "worktree"` spawn option) and Agent tool
- **Background Agents** — Long-running agents that execute in the background with completion notifications via `BackgroundAgentManager`. Emits `notification` events on completion/error/stop. REPL integration with `/bg` commands (list, show, stop, prune). Agent tool supports `background: true` for fire-and-forget launches
- **71 new tests** — Agent definitions (25), worktree isolation (25), background agents (21). Total: 569 tests

### Changed
- AgentCoordinator constructor now accepts optional `worktreeManager` parameter
- `spawnAgent()` is now async (worktree creation requires it)
- Agent tool input schema extended with `definition`, `isolation`, and `background` fields
- REPL help updated with `/bg` commands
- `AgentConfig` type extended with `isolation` field

## [0.8.0] - 2026-04-01

### Added
- **Plan Mode: Global `--plan` flag** — `--plan` now works on all commands (default REPL, `run`, `develop`), not just `develop`. Enables plan mode from the CLI for any workflow
- **Plan Mode: LLM awareness** — When plan mode is active, the system prompt instructs the LLM to explain proposed changes, read first, group related changes, and summarize the plan. Results in much more informative plan proposals
- **Plan Mode: Diff previews** — `/plan show` now displays inline diff previews for EditFile (red/green old→new), WriteFile (content snippet), and Bash (command preview) actions. Makes plans reviewable at a glance
- **Plan Mode: `/plan yes` shortcut** — Approve and execute the latest plan in one step, streamlining the most common approval workflow
- **6 new tests** — System prompt plan mode injection (2), shouldIntercept (2), approve/reject idempotency (2). Total: 498 tests

### Changed
- `--plan` flag moved from `develop`-only to global options (available on all commands)
- Plan help text updated with new commands and descriptions

## [0.7.0] - 2026-04-01

### Added
- **Self-Hosting / Dogfooding** — `nexus develop [prompt]` CLI command for Nexus to develop its own codebase. Architecture-aware system prompt gives the LLM deep knowledge of Nexus internals (engine loop, providers, tools, agents, permissions, memory, skills, MCP). Dev-safe permission rules auto-allow reads, writes, git, tests, and npm scripts while denying destructive ops (`rm -rf`, `git push --force`, `npm publish`). Supports interactive REPL and single-shot modes. Optional `--plan` flag for safer self-modification
- **Self-Host Config Builder** — `buildSelfHostConfig()` merges base config with self-hosting overrides: auto-detected project root, dev permissions, optional plan mode
- **33 new tests** — findNexusRoot (2), buildSelfHostSystemPrompt (9), getSelfHostPermissionRules (11), buildSelfHostConfig (9), REPL systemPrompt (2). Total: 492 tests

### Changed
- REPL now accepts optional `systemPrompt` parameter for custom system prompts
- Phase 2 of the roadmap is now complete

## [0.6.0] - 2026-04-01

### Added
- **AWS Bedrock Provider** — Full Amazon Bedrock support via the Converse API. Streaming with `ConverseStream`, tool use (parallel calls), system prompts, and `listModels()` with on-demand model filtering. Supports all Bedrock-hosted models (Claude, Llama, Mistral, Titan, etc.). Authentication via AWS credentials (env vars, config files, IAM roles, SSO)
- **24 new tests** — Bedrock provider (18), convertMessages (6), convertTools (1). Total: 459 tests

### Changed
- CLI now supports `--provider bedrock` in addition to `anthropic`, `openai`, `ollama`, and `gemini`
- Exported `BedrockProvider` from main index

## [0.5.0] - 2026-04-01

### Added
- **Google Gemini Provider** — Full Gemini API support (Gemini 2.0 Flash, 2.5 Pro, etc.) via native fetch (no SDK dependency). SSE streaming, function calling, system instructions, `listModels()` with generation method filtering. Supports `GOOGLE_API_KEY` and `GEMINI_API_KEY` env vars, custom base URLs for Vertex AI
- **25 new tests** — Gemini provider (18), convertMessages (6), convertTools (1). Total: 435 tests

### Changed
- CLI now supports `--provider gemini` in addition to `anthropic`, `openai`, and `ollama`
- Exported `GeminiProvider` from main index

## [0.4.0] - 2026-04-01

### Added
- **Plan Mode** — Agent proposes write operations as a plan before executing. Plans can be approved/rejected in bulk or per-action. Read-only tools execute normally
- **Webhook Platform Adapter** — Generic HTTP webhook platform for any service. Receives POST requests, sends via callback URL. Supports shared secret auth
- **19 new tests** — Plan mode (19). Total: 403 tests

### Changed
- Platform factory now supports "webhook" adapter type
- Exported PlanExecutor, Plan, PlannedAction from main index

## [0.3.0] - 2026-04-01

### Added
- **Context Compression** — Automatic conversation summarization when context exceeds 80% of token limit. Keeps first + last 10 messages intact, summarizes the middle
- **Skill System** — Reusable workflow definitions loaded from `.nexus/skills/*.md`. YAML frontmatter for metadata, markdown body for prompt template, `{{arg0}}` substitution
- **Audit Logger** — JSONL-based logging of every tool execution: timestamp, tool name, input (sensitive fields redacted), output (truncated), permission decision, duration
- **42 new tests** — Context compressor (13), Skills (17), Audit logger (12). Total: 384 tests

### Changed
- Engine now auto-compresses context when approaching token limits
- Updated exports with new modules (ContextCompressor, SkillLoader, AuditLogger)

## [0.2.0] - 2026-04-01

### Added
- **OpenAI Provider** — GPT-4o, o1, o3 support via native fetch (no SDK dependency). Full streaming with function calling
- **Ollama Provider** — Local model support (Llama, Mistral, etc.) via OpenAI-compatible API. Includes `listModels()` support
- **Fallback Provider** — Automatic failover between providers on errors. Chain any number of providers
- **Docker Support** — Multi-stage Dockerfile, docker-compose for REPL and MCP server modes
- **Project Instructions** — Load `.nexus/instructions.md` or `.nexus.md` for project-specific system prompts
- **44 new tests** — OpenAI provider (18), Ollama provider (17), Fallback provider (9). Total: 342 tests

### Changed
- CLI now supports `--provider ollama` and `--provider openai` in addition to `anthropic`
- Engine system prompt now includes working directory and project instructions
- Improved error messages when provider fails to load

## [0.1.0] - 2026-04-01

### Added
- **Core Engine** — Streaming LLM + tool execution loop with async generator events
- **Anthropic Provider** — Full streaming support with extended thinking
- **Permission System** — Fine-grained per-tool permissions with pattern matching (allow/deny/ask), 4 priority sources
- **7 Built-in Tools** — Bash, ReadFile, WriteFile, EditFile, Glob, Grep, WebFetch
- **MCP Integration** — MCP client (consume external tools) and server (expose Nexus tools)
- **Multi-Agent Orchestration** — Coordinator with sub-agent spawning, messaging, and parallel execution
- **Memory System** — SQLite-backed persistent memory with FTS5 full-text search
- **Platform Adapters** — Telegram, Discord, Slack connectors
- **Plugin System** — Dynamic plugin loading from npm packages or local files
- **CLI** — Interactive REPL, single-shot mode (`nexus run`), MCP server mode (`nexus serve`), config viewer
- **Configuration** — Multi-source config loading (defaults, user, project, env vars, CLI args)
- **Token Budget Tracking** — Automatic cost estimation and budget enforcement
- **Test Suite** — 298 tests covering all core modules
- **Zod Validation** — Type-safe input validation at every tool boundary
- **Concurrent Tool Execution** — Safe tools run in parallel, unsafe tools serialized automatically
