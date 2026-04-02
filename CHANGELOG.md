# Changelog

All notable changes to Shaka are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versions follow [Semantic Versioning](https://semver.org/).

## [0.8.0] — 2026-04-02

### Added

- **Learning condensation** — `shaka memory consolidate` now synthesizes related learnings into compound entries, freeing context budget. Originals are archived and remain searchable
- **Automatic maintenance** — Learnings are consolidated, promoted, and pruned automatically after sessions. Disable with `memory.maintenance.enabled: false` in config
- **Archive search** — `shaka memory search` includes archived learnings

### Changed

- **Reasoning framework** — Context sizing guidance and stub detection before claiming completion
- **Steering rules** — "Handle Discovered Issues" rule: auto-fix blockers, flag non-blockers, ask on scope changes

## [0.7.2] — 2026-03-14

### Fixed

- **System skill discovery** — System skills (TDD, Council, RedTeam, etc.) were not discoverable by Claude Code or opencode because they were nested under a single `shaka/` directory symlink. Providers do single-level skill discovery, so skills two levels deep were invisible. Changed to per-skill symlinks so each system skill appears as a direct child of the provider's skills directory. Legacy `shaka/` symlinks are cleaned up automatically on reload

## [0.7.1] — 2026-03-13

### Added

- **TDD skill** — Default-on test-driven development skill with red-green-refactor discipline, horizontal slicing anti-pattern, mock boundary guidelines, and per-cycle gate. Adapted from [Matt Pocock's TDD skill](https://github.com/mattpocock/skills/tree/main/tdd) with modifications for AI agent context

### Changed

- **Engineer agent** — Improved TDD section with vertical slice workflow, tracer bullet approach, and horizontal slicing anti-pattern warning
- **Skills cleanup** — Removed dead Customization boilerplate from BeCreative, Council, FirstPrinciples, and RedTeam skills (section referenced a `customizations/skills/` path with no backing infrastructure)

## [0.7.0] — 2026-03-12

### Added

- **Skill management** — Install, update, and remove third-party skills from GitHub or the Clawhub registry
  - `shaka skill install user/repo` — install from GitHub (shorthand, full URL, or with `#ref`)
  - `shaka skill install sonoscli` — install from Clawhub (bare name, or `name@version`)
  - `shaka skill update [name]` — update one skill or all installed skills
  - `shaka skill remove <name>` — remove an installed skill
  - `shaka skill list` — list system and installed skills with their source
  - `--github` and `--clawhub` flags to override auto-detection
- **Security scanning on install** — Skills are scanned before installation for executable files, URLs, HTML comments, and invisible characters. Findings are presented for review before proceeding. Use `--yolo` to skip
- **GitHub skill discovery** — Repos without a root `SKILL.md` are searched via fallback paths: marketplace metadata (`.claude-plugin/marketplace.json`), `.claude/skills/`, and `skills/` directories
- **Clawhub registry** — HTTP-based skill source with version resolution and ZIP extraction
- **Skill manifest** — Installed skills tracked in `skills.json` with source, provider, and version metadata
- **Doctor integration** — `shaka doctor` now checks installed skill health

## [0.6.1] — 2026-03-11

### Added

- **Workflow looping** — Add `loop: N` to workflow frontmatter to repeat all steps N times. Useful for iterative refinement patterns like review-fix cycles. Override from the CLI with `--loop N`
- **Group steps** — Compose steps within a workflow using inline groups with `steps: [...]` and optional `loop: N` for group-level iteration
- **Workflow references** — Reference other workflows as steps with `workflow: "other-name"`. References are resolved transitively with cycle detection, and the referenced workflow's steps are inlined as a group
- **Loop template variables** — `{loop.iteration}` and `{loop.total}` for iteration-aware commands, commit messages, and artifact paths
- **Shipped workflow: `plan-feature`** — Multi-step planning pipeline that produces `plan.md` and `implementation-strategy.md` with iterative critique and revision cycles

## [0.6.0] — 2026-03-07

### Added

- **WritingRules skill** — Anti-slop writing constraints that the Algorithm autonomously selects for prose-writing tasks (blog posts, docs, emails). Detects banned words, AI patterns, hedging, rhythm issues, and structural anti-patterns. Customizable via override in `customizations/skills/WritingRules/`.
- **`shaka scan` command** — CLI tool to scan prose files for AI writing patterns
  - Scores content on a 100-point scale (pass threshold: 80+)
  - Single file, directory (`--dir`), and stdin (`--stdin`) input modes
  - Markdown-aware: ignores YAML frontmatter, fenced code blocks, and inline code
  - Per-paragraph breakdown with `-p` flag
  - JSON output for CI integration (`--json`)
  - Directory mode validates paths and errors on empty results

## [0.5.0] — 2026-03-01

### Added

- **Workflows** — Multi-step agentic pipelines via `shaka run <workflow> [input...]`
  - Three step types: `command` (slash commands), `prompt` (inline AI instructions), `run` (shell scripts)
  - Template variables for output handoff between steps: `{input}`, `{previous.output}`, `{previous.exitCode}`, `{steps.<name>.output}`, `{steps.<name>.exitCode}`
  - Optional git state management with `state: "git-branch"` — auto-creates branch and commits after each step that produces changes
  - Run artifacts and metadata stored in `~/.config/shaka/runs/<workflow>-<runId>/`
  - Workflows defined as `.yaml` files — pure configuration, no frontmatter ceremony
  - Workflow discovery from `system/workflows/` and `customizations/workflows/` with override semantics
  - CWD scoping for project-specific workflows
  - Step and workflow name validation (lowercase alphanumeric with hyphens, max 64 chars)
  - Provider-agnostic agent execution for AI steps (tools enabled, hooks active)
- **Shipped workflow: `review-and-fix`** — Run a code review then critically assess and fix valid issues
- **Shared path utilities** — Extracted `expandTilde()` and `normalizeCwd()` to `src/domain/paths.ts` for reuse by both command and workflow discovery

## [0.4.2] — 2026-02-23

### Added

- **`shaka doctor --context`** — Measure context injection overhead across all hooks
  - Per-component breakdown: reasoning framework, user files, learnings, rolling summaries, session summaries, separators
  - Budget utilization bars for learnings and sessions with actual config values
  - Format reminder measurement for FULL/ITERATION/MINIMAL depth modes
  - Session start composition breakdown with character counts and token estimates
  - Unmodified user template detection (skips default templates from injection totals)
  - Shared `renderSessionSection` and `resolveDefaultsUserDir` between hook and measurement for accurate results

## [0.4.1] — 2026-02-23

### Added

- **Rolling summaries (rollups)** — Daily, weekly, and monthly session summary rollups provide compressed institutional knowledge per project
  - Daily rollups accumulate session summaries, weekly folds completed days, monthly folds completed weeks
  - Per-project storage under `memory/rollups/` with YAML frontmatter + markdown body
  - AI-powered summarization for folding lower-period rollups into higher periods
  - Directory-based locking with stale-lock recovery for concurrency safety
  - Atomic writes via temp+rename pattern
  - Fail-open integration: rollup failures never block session-end processing
  - Rolling summaries loaded into session-start context between learnings and recent sessions

## [0.4.0] — 2026-02-21

### Added

- **Slash commands system** — Markdown-based commands with YAML frontmatter, compiled to provider-native formats (Claude Code skills, opencode commands)
  - `shaka commands list` — Show all discovered commands and their installation status
  - `shaka commands new <name>` — Scaffold a new command in `customizations/commands/`
  - `shaka commands disable <name>` — Disable a command (persisted in config, excluded from discovery)
  - `shaka commands enable <name>` — Re-enable a disabled command
- **Command frontmatter** — `description` (required), `argument-hint`, `subtask`, `model`, `user-invocable` (Claude only), `cwd`, `providers`
- **Scoped command installation** — Commands can target specific project directories via `cwd` field; `cwd: ["*"]` is global (same as omitting)
- **Per-provider field overrides** — `providers` block in frontmatter allows different `model`, `description`, `subtask` per provider
- **Body substitutions** — `$ARGUMENTS` (all args), `$1`/`$2`/... (positional), `` !`cmd` `` (shell output). Auto-appends `$ARGUMENTS` when no references found
- **Customization overrides for commands** — `customizations/commands/` overrides `system/commands/` by filename match, consistent with hooks and skills
- **Shipped command: `code-review`** — Review local changes, a branch, or a PR. Runs as background subagent with provider-specific model overrides

### Fixed

### Changed

## [0.3.3] — 2026-02-19

### Added

- **`shaka memory stats` command** — Shows learnings count, total exposures, category breakdown, CWD distribution, and oldest/newest entries
- **Search metadata filters** — `shaka memory search` now supports `--type` (session/learning) and `--after`/`--before` date filters
- **Config-driven memory budgets** — `memory.learnings_budget`, `memory.sessions_budget`, `memory.recency_window_days`, and `memory.search_max_results` are now configurable in `config.json`
- **Stale temp file cleanup** — Session-start hook removes orphaned `.session-end-input-*.json` files older than 1 hour

### Fixed

- **Config upgrade backfills partial memory blocks** — `ensureConfigComplete()` now backfills individual missing memory subfields instead of only creating the block when entirely absent
- **Configured recency window now honored** — Session-start hook passes `config.memory.recency_window_days` through to `selectLearnings` instead of always using the hardcoded default
- **Zero/negative recency window guard** — `recencyScore` returns 0 when `windowDays <= 0` to prevent NaN from poisoning sort ordering

### Changed

- **Scoring timestamp hoisted** — `selectLearnings` captures `new Date()` once before mapping instead of per-entry

## [0.3.2] — 2026-02-17

### Added

- **`shaka memory review` command** — Interactive TUI for browsing, filtering, and deleting learnings with pagination. `--prune` flag enables AI-assisted quality assessment that flags low-value entries for review. `--filter` pre-filters by text match.
- **Learnings quality criteria constants** — Shared `QUALITY_GATES`, `LOW_QUALITY_PATTERNS`, and `HIGH_QUALITY_PATTERNS` ensure extraction and pruning prompts stay in sync.

### Changed

- **Reasoning framework upgraded** — Adopted improvements from PAI v3: stricter constraint-to-criteria traceability, explicit/inferred tagging, mandatory anti-criteria, drift prevention checkpoints, and empirical-over-inferred verification. Algorithm agent and docs updated to match.
- **Learnings extraction prompt tightened** — Reduced max learnings per session from 3 to 2, added three-gate quality test (NON-OBVIOUS, RECURRING, BEHAVIOR-CHANGING), expanded anti-patterns list to reduce low-value extractions.
- **`learnings.ts` split into focused modules** — Extracted `memory/consolidation.ts` (duplicate/contradiction detection) and `commands/memory/` directory (consolidate, review subcommands). Largest file reduced from 776 to ~520 lines.

## [0.3.1] — 2026-02-16

### Added

- **Default permission management** — Shaka applies sensible default permissions during `shaka init` for both providers
  - Claude Code: allow list for standard dev tools, ask list guarding destructive operations (force push, rm -rf, secret file reads)
  - OpenCode: edit and bash set to `allow` when no existing permissions found
  - Merge strategy: union-dedupe for Claude Code (preserves user customizations), apply-if-missing for OpenCode
- **`permissions.managed` config field** — Toggle to disable Shaka's permission management (`shaka config set permissions.managed=false`)
- **`ensureConfigComplete()` utility** — Backfills missing config fields with defaults, called from reload, doctor --fix, and update
- **Permission mode support** — `InstallConfig.permissionMode` controls behavior: `apply`, `merge`, or `skip`

### Changed

- **`shaka doctor` expanded** — Now checks and reports permission installation status for each provider
- **`shaka reload` applies permissions** — Reloading now re-applies permission defaults alongside hooks, agents, and skills
- **`shaka init` applies permissions** — Permission defaults applied during initial setup when `permissions.managed` is true

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

[0.8.0]: https://github.com/jgmontoya/shaka/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/jgmontoya/shaka/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/jgmontoya/shaka/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jgmontoya/shaka/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/jgmontoya/shaka/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jgmontoya/shaka/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jgmontoya/shaka/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/jgmontoya/shaka/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jgmontoya/shaka/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jgmontoya/shaka/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/jgmontoya/shaka/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jgmontoya/shaka/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jgmontoya/shaka/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jgmontoya/shaka/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/jgmontoya/shaka/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jgmontoya/shaka/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jgmontoya/shaka/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jgmontoya/shaka/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jgmontoya/shaka/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jgmontoya/shaka/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jgmontoya/shaka/releases/tag/v0.1.0
