# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
