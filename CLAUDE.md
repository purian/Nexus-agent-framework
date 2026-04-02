# Nexus Agent Framework — Development Guide

## Project Overview
Nexus is an open-source, MCP-native personal AI agent framework. Secure, composable, multi-agent.
- **Repo**: https://github.com/purian/Nexus-agent-framework
- **Current version**: 0.11.0
- **Stack**: TypeScript, Node 20+, Zod, SQLite, MCP SDK

## Commands
```bash
npm run dev          # Watch mode
npm run build        # Production build (tsup)
npm run typecheck    # TypeScript check
npm test             # Run all 711 tests (vitest)
npm run test:watch   # Watch mode tests
```

## Architecture
- `src/core/engine.ts` — Main agent loop (LLM → tool execution → feed results → repeat)
- `src/core/providers/` — LLM providers (Anthropic, OpenAI, Gemini, Bedrock, Ollama, Fallback)
- `src/tools/` — 7 built-in tools (Bash, ReadFile, WriteFile, EditFile, Glob, Grep, WebFetch)
- `src/permissions/` — Fine-grained per-tool permission system
- `src/mcp/` — MCP client (consume tools) and server (expose tools)
- `src/agents/` — Multi-agent coordinator, sub-agent spawning, definitions, worktrees, background agents
- `src/memory/` — SQLite + FTS5 persistent memory
- `src/skills/` — Reusable workflow system (.nexus/skills/*.md)
- `src/platforms/` — Telegram, Discord, Slack, Webhook adapters
- `src/plugins/` — Dynamic plugin loader
- `src/selfhost/` — Self-hosting (Nexus developing itself via `nexus develop`)
- `src/cli/` — Commander.js CLI with REPL
- `src/config/` — Multi-source config (defaults → user → project → env → CLI)

## Development Rules
- **No regressions**: Run `npm test` before every commit. All 711+ tests must pass.
- **Version bumps**: Update package.json, src/cli/index.ts (VERSION const), and CHANGELOG.md
- **Changelog**: Follow Keep a Changelog format. Update for every release.
- **Commits**: Descriptive messages. Include "Co-Authored-By: Claude" line.
- **Pushes**: Always push to `origin main` after committing.
- **README**: Update test count badge and test table when adding tests.
- **No references** to Claude Code source code or reverse engineering anywhere in the codebase.
- **Roadmap**: Internal only — stored in `roadmap.yaml` (gitignored). Never commit to repo.

## Current Roadmap Status
See `roadmap.yaml` for full details. Key remaining items:
- Phase 4: SOC 2 compliance guide (all other items done)
- Phase 5: Web UI, VS Code extension, WhatsApp/Matrix/Email adapters, Nexus Hub
- Phase 5: Web UI, VS Code extension
- Phase 6: Proactive agents, scheduled tasks, multi-model routing

## Testing
- All tests in `src/**/*.test.ts`, run with vitest
- Use real filesystem ops in temp dirs for tool tests (no mocking FS)
- Mock LLM providers with async generators for engine tests
- Mock fetch with `vi.stubGlobal` for provider tests
