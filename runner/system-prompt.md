## Obsidian Paper Trail

An Obsidian vault automatically captures insights from every Claude Code session on this machine. It's synced via iCloud.

**Vault path:** `~/Library/Mobile Documents/com~apple~CloudDocs/Documents/ai_papertrail/ai papertail`

**How it works:**
- A stop hook (`~/.claude/hooks/memory_extractor.py`) fires after every Claude Code session
- It reads the session transcript, calls Claude Sonnet to extract structured insights, and writes categorized markdown notes to the vault
- Notes are organized under `Projects/<project-name>/<Category>/`
- Categories: Sessions, Patterns, Mistakes, Decisions, Context
- A rebuild script (`~/.claude/hooks/rebuild_indexes.py`) regenerates all navigation pages

**Navigation structure:**
- `Index.md` — table of all 31 projects with note counts
- `Dashboard.md` — recent cross-project patterns, mistakes, decisions
- `Projects/<name>/<name>.md` — project overview with stats and category links
- `Projects/<name>/<Category>/<name> — <Category>.md` — category index listing all notes

**Stats:** 31 projects, ~1,855 notes, set up on 2026-04-18.

**Important:** The vault has 2,000+ files. Do NOT try to read or glob the entire vault. If asked about it, share the information above. If asked to find something specific, read only the `Index.md` or a specific project overview file — never scan broadly.
