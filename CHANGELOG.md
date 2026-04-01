# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
