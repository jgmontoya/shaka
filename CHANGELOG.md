# Changelog

All notable changes to Shaka are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-02-12

### Added

- **Automatic continuous learning** — The assistant learns from sessions and improves over time
  - Learnings extracted from transcripts at session end (single inference call, no extra cost)
  - Learnings loaded into context at session start within a 6000-char budget
  - Non-matching CWD entries excluded before scoring; only global and CWD-matching entries are candidates
  - Scoring by recency (90-day decay) and reinforcement (exposure count) within the relevant set
  - Title-match reinforcement: repeated learnings gain weight automatically
- **`shaka memory consolidate` command** — Merge duplicates and resolve contradictions
  - Two-pass LLM classification: duplicate detection then contradiction detection
  - Deterministic CWD overlap resolution (newer entry wins)
  - Interactive CWD-to-global promotion with nonglobal opt-out
  - Backup written before every consolidation
- **Learnings search** — `shaka memory search` and MCP tool now return learnings alongside sessions
- **Search result type discriminator** — `SearchResult.type` field (`"session"` | `"learning"`)
- **Windows support** — Shaka now runs on Windows alongside macOS and Linux
  - Cross-platform path utilities (`src/platform/paths.ts`) with `readSymlinkTarget()` and `removeLink()` helpers
  - Junctions instead of directory symlinks for zero-privilege Windows support (no Developer Mode or admin required)
  - `Bun.which()` for cross-platform executable lookup in provider detection
  - `USERPROFILE` fallback for home directory resolution on Windows
  - `.gitattributes` for consistent line endings across platforms
- **Windows CI** — GitHub Actions matrix now includes Windows

### Changed

- **`session-end` hook is fire-and-forget** — Dispatch reads stdin and spawns a detached background worker, returning control to the CLI in milliseconds instead of blocking during inference
- **Summarization prompt extended** — Now extracts learnings alongside session summaries in a single inference call
- **Session summaries exclude learnings** — `## Learnings` section stripped from session summary body (stored separately in `learnings.md`)
- **`hashSessionId` extracted** — Shared utility in `src/memory/utils.ts` (was private in storage.ts)
- **All path construction uses `path.join()`** — Replaced hardcoded `/` separators across `src/` modules, `defaults/` hooks, providers, configurers, and tests
- **`pathToFileURL()` for dynamic imports** — Bare Windows paths (`C:\...`) fail with `import()`, now converted to `file://` URLs
- **Security pattern matching is cross-platform** — Path patterns normalize separators before matching
- **Uninstall shows platform-appropriate cleanup command** — Displays the correct shell command for the user's OS
- **Tests use `os.tmpdir()` and `path.join()`** — All test temp directories are now cross-platform

## [0.2.2] — 2026-02-11

### Added

- **`shaka config get/set` commands** — Get and set configuration values from the CLI using dot-notation paths (e.g., `shaka config get providers.opencode.enabled`, `shaka config set providers.opencode.summarization_model=openrouter/anthropic/claude-haiku-4.5`)
- **Destructive overwrite protection** — `config set` prevents accidentally replacing objects with primitives (e.g., setting `providers.claude=foo` when it contains multiple keys)
- **opencode summarization model hint** — After `shaka init`, `shaka doctor`, or `shaka update`, displays a hint suggesting users configure a specific summarization model
- **Agents installation** — Agents from `system/agents/` are now symlinked to provider config directories (`~/.claude/agents/shaka/`, `~/.config/opencode/agents/shaka/`)
- **Skills installation** — Skills from `system/skills/` are now symlinked to provider config directories
- **Dual provider permissions in agents** — All agent definitions now include both Claude Code and OpenCode permission blocks
- **Inference agent** — Tool-restricted agent (`inference.md`) for safe LLM inference calls

### Changed

- **`shaka reload-hooks` renamed to `shaka reload`** — Command now reinstalls all provider components (hooks, agents, skills), not just hooks
- **Provider interface broadened** — `installHooks`/`uninstallHooks`/`verifyHooks` renamed to `install`/`uninstall`/`checkInstallation` to reflect expanded scope
- **`shaka doctor` checks all components** — Now verifies hooks, agents, and skills installation status separately
- **Docker auth simplified** — Uses `CLAUDE_CODE_OAUTH_TOKEN` env var instead of volume-mounted credentials file

### Fixed

- **`shaka update` works from any directory** — Repo root now resolved via `import.meta.url` instead of `git rev-parse` from cwd, so update no longer requires running from inside the shaka repo
- **Stale error message in uninstall** — Changed "hooks" to "configuration" in error output

## [0.2.1] — 2026-02-10

### Added

- **`shaka reload-hooks` command** — Re-discovers hooks and regenerates provider configurations without running full init
- **Customization hook support** — Hooks in `customizations/hooks/` are now discovered alongside system hooks
- **Hook override by filename** — A customization hook with the same filename as a system hook replaces it (e.g., `customizations/hooks/session-start.ts` overrides `system/hooks/session-start.ts`)
- **Template-skip logic** — Session-start hook skips unmodified plain-markdown user files (goals.md, missions.md, etc.) to save context tokens. Eta-sourced files (user.md, assistant.md) are always included since they contain configured identity info.

### Fixed

- **Stale hook cleanup** — Claude configurer now removes old Shaka hook entries before re-registering, so deleted hooks don't persist in `settings.json`

## [0.2.0] — 2026-02-09

### Added

- **Session memory system** — Full transcript-to-summary pipeline
  - Transcript parsers for both Claude Code (JSONL) and opencode (JSON) formats
  - Summarization via AI inference with structured prompt builder and output parser
  - Summary storage as markdown files with JSON index for fast lookup
  - Recent session summaries loaded into context at session start
- **`session-end` hook** — Parses transcripts and generates session summaries on conversation end
- **`memory-search` MCP tool** — Search session summaries by keyword, exposed via MCP server
- **`shaka memory search` CLI command** — Search summaries from the command line
- **opencode session.end support** — Wired session end handling into the generated opencode plugin

### Changed

- Hook event system expanded with `session.end` and `tool.after` events
- Domain types extended with `SessionEndEvent` and `ToolAfterEvent`

## [0.1.3] — 2026-02-08

### Fixed

- Hardened update/init/doctor flows — fixed detached HEAD handling, version comparison, provider persistence, and config-aware re-init
- CI now runs `just check` (typecheck + lint + tests)

## [0.1.2] — 2026-02-08

### Fixed

- Init now persists provider selection to config and respects it during update and doctor

## [0.1.1] — 2026-02-08

### Changed

- Updated base reasoning framework from upstream v0.3.x assessment

## [0.1.0] — 2026-02-08

Initial release. Core infrastructure for a provider-agnostic AI assistant framework.

### Added

- **Hook system** — SessionStart, PreToolUse, PostToolUse, UserPromptSubmit events with TypeScript hooks
- **Provider support** — Claude Code (subprocess hooks + MCP tools) and opencode (in-process plugin) as first-class providers
- **Init / upgrade / uninstall CLI** — `shaka init`, `shaka update`, `shaka uninstall` with tag-based releases
- **Config system** — JSON config with validation, override support, provider detection
- **MCP server** — `shaka mcp serve` exposes tools to Claude Code via stdio
- **Security validation** — Bash command and file path validation via PreToolUse hook with YAML patterns
- **Base reasoning framework** — 7-phase algorithm loaded at session start
- **Customization overrides** — `customizations/` directory overrides `system/` counterparts
- **Skills** — 5 markdown-based skills: BeCreative, Council, RedTeam, Science, FirstPrinciples
- **Agents** — 12 markdown agent definitions
- **Doctor command** — `shaka doctor` for installation health checks
- **Inference tool** — Provider-agnostic AI inference via CLI wrappers
- **Provider selection prompt** — Interactive provider selection during init with `--claude`/`--opencode`/`--all` flags
- **Identity configuration** — Principal and assistant name prompts during init
- **E2E tests** — Docker-based end-to-end tests for both providers
- **Unit tests** — 200+ tests covering core logic

[0.3.0]: https://github.com/jgmontoya/shaka/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/jgmontoya/shaka/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jgmontoya/shaka/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jgmontoya/shaka/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jgmontoya/shaka/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jgmontoya/shaka/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jgmontoya/shaka/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jgmontoya/shaka/releases/tag/v0.1.0
