# Shaka

A personal AI assistant framework. Provider-agnostic. Clear architecture. Your data stays yours.

## Getting Started

```bash
git clone https://github.com/jgmontoya/shaka.git
cd shaka
bun install
bun link
shaka init
```

`shaka init` will detect your installed providers (Claude Code, opencode, or both) and set everything up.

**Prerequisites:** [Bun](https://bun.sh) and at least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [opencode](https://opencode.ai).

## What Happens

Shaka doesn't replace your AI coding assistant — it enhances it. Once installed, it works invisibly through hooks:

1. **You start a session** (Claude Code or opencode). The `SessionStart` hook loads your identity, preferences, goals, and reasoning framework into the conversation context. The AI knows who you are and how to think.

2. **You work normally.** Type prompts, ask questions, write code. Shaka is transparent.

3. **The AI tries to run a command.** The `security-validator` hook intercepts it, checks the command against your security patterns, and blocks anything catastrophic before it executes.

4. **You want to customize.** Copy any file from `system/` to `customizations/` and edit it. Your version takes priority. Upgrades never touch your files.

That's it. No new UI to learn, no new commands to memorize. Shaka makes your existing tools smarter.

## Philosophy

Inspired by [PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure), [Ren](https://github.com/erskingardner/ren), and [openclaw](https://github.com/openclaw/openclaw), but with a focus on:

1. **Deterministic First** — Do as much as possible in code before involving the model
2. **Local First** — No telemetry, no required cloud services, works with local models
3. **Incremental** — Ship working software at each phase
4. **Extensible** — Easy to add tools, skills, and agents
5. **Clear Boundaries** — Templates vs user files are never confused

## Architecture

### Design Principles

1. **Bun is the committed runtime** -- No abstraction layer around Bun APIs. Services use `Bun.file()`, `Bun.spawn()`, etc. directly.
2. **Hooks are standalone scripts** -- Run directly with `bun`, no CLI binary required at runtime.
3. **Content is declarative** -- Markdown files, JSON config, YAML patterns. Code only where determinism is needed.
4. **Dependencies at root level** -- `defaults/` is pure content. No `node_modules/` inside it.
5. **Both providers are first-class** -- Claude Code and opencode supported from day one, not one primary + one afterthought.

For the rationale behind key structural decisions, see [Architecture Decisions](docs/architecture-decisions.md).

### Directory Structure

```text
~/.config/shaka/              # XDG-compliant, provider-agnostic
├── user/                     # YOUR content (portable, backed up)
│   ├── user.md               # Who you are (name, timezone, handles)
│   ├── assistant.md          # How your assistant behaves
│   ├── missions.md           # High-level purpose (TELOS-lite)
│   ├── goals.md              # Specific objectives
│   ├── projects.md           # Active projects and paths
│   ├── tech-stack.md         # Preferred technologies
│   └── <your-folders>/       # Subdirectories are NOT auto-loaded
│       └── ...
│
├── memory/                   # What Shaka LEARNS about you (dynamic)
│   └── ...                   # Security logs, patterns (search TBD)
│
├── customizations/           # Your OVERRIDES for system/
│   └── base-reasoning-framework.md  # (example) Your reasoning variant
│   └── hooks/                      # Your hooks
│   └── ...
│
├── system/ → <repo>/defaults/system  # Symlink to framework (replaced on upgrade)
│   ├── base-reasoning-framework.md   # Default reasoning framework
│   ├── hooks/                # Event-driven automation
│   ├── commands/             # Slash commands (markdown)
│   ├── workflows/            # Multi-step pipelines (yaml)
│   ├── skills/               # Reusable playbooks (markdown)
│   ├── tools/                # Deterministic operations
│   └── agents/               # Specialized personas (markdown)
│
└── config.json               # Configuration file
```

> **User file loading:** All `.md` files directly under `user/` are automatically injected into the AI's context at session start. **Keep this level lean** — only files that are useful in every session (identity, preferences, goals). For detailed reference material (style guides, API docs, project specifics), create subdirectories. Subdirectory files are **not** auto-loaded — the model can read them on demand when relevant.
>
> **Index pattern:** If you add subdirectories, create a `user/index.md` to help the model discover them. Since it lives at the top level, it gets auto-loaded and acts as a routing guide:
>
> ```markdown
> # User Context Index
>
> ## reference/
> Detailed style guides and coding conventions. Read when making style or formatting decisions.
>
> ## api-docs/
> Internal API documentation. Read when integrating with or building against our services.
> ```

### Key Principle: Separation of Concerns

| Directory         | Purpose                          | Owner | Upgrades          | Backup |
| ----------------- | -------------------------------- | ----- | ----------------- | ------ |
| `user/`           | Who you are (you write it)       | You   | Never touched     | Yes    |
| `memory/`         | What Shaka learns (Shaka writes) | Shaka | Never touched     | Yes    |
| `customizations/` | Your overrides for system/       | You   | Never touched     | Yes    |
| `system/`         | Framework defaults (symlink)     | Shaka | Replaced entirely | No     |

When Shaka upgrades, `system/` is re-symlinked to the new version. Everything else is preserved.

### Customization via Override

Files in `customizations/` override their `system/` counterparts:

```text
customizations/base-reasoning-framework.md  →  overrides  →  system/base-reasoning-framework.md
customizations/hooks/session-start.ts       →  overrides  →  system/hooks/session-start.ts
customizations/tools/foo.ts                 →  overrides  →  system/tools/foo.ts
```

**Resolution order:** Customization → System default

This lets you tweak the reasoning framework, add hooks, or replace tools without modifying `system/`. Your customizations survive upgrades.

## CLI

### Available Commands

```bash
shaka init                    # Set up Shaka (creates dirs, symlinks, installs hooks)
shaka init --claude           # Set up for Claude Code only
shaka init --opencode         # Set up for opencode only
shaka init --all              # Set up for both providers
shaka update                  # Upgrade to latest release (tag-based)
shaka uninstall               # Remove hooks and config
shaka reload-hooks            # Re-discover hooks and regenerate provider configs
shaka doctor                  # Check installation health
shaka mcp serve               # Start MCP server (for Claude Code tool integration)
shaka commands list            # Show all commands and status
shaka commands new <name>     # Create a new command
shaka commands disable <name> # Disable a command
shaka commands enable <name>  # Re-enable a disabled command
shaka run <workflow> [input...] # Execute a multi-step workflow
shaka memory search <query>   # Search session summaries and learnings
shaka memory stats            # Show learnings count, exposures, and category breakdown
shaka memory review           # Browse and manage learnings interactively
shaka memory review --prune   # AI-assisted quality assessment of learnings
shaka memory consolidate      # Merge duplicate and contradictory learnings
```

### Init Flow

`shaka init` does the following:

1. Detects which providers (Claude Code, opencode) are installed
2. Prompts for provider selection (or use `--claude`/`--opencode`/`--all`)
3. Creates `user/`, `memory/`, `customizations/` directories
4. Symlinks `system/` to the repo's `defaults/system/`
5. Copies user file templates (identity.md, preferences.md, etc.)
6. Registers the `shaka` package globally via `bun link`
7. Installs hooks for selected providers
8. Tracks version in `.shaka-version`

### Upgrade Flow

`shaka update` uses git tags for releases:

1. Fetches latest tags from remote
2. Compares current vs latest version
3. Warns and prompts on major version bumps
4. Checks out the new tag and re-runs init

## Base Reasoning Framework

Shaka uses a structured reasoning framework inspired by [PAI's Algorithm](https://github.com/danielmiessler/TheAlgorithm), loaded at session start. The AI works through 7 phases — OBSERVE, THINK, PLAN, BUILD, EXECUTE, VERIFY, LEARN — and defines testable success criteria (ISC) before acting. This prevents the common failure of solving one problem while creating another.

To customize, copy `system/base-reasoning-framework.md` to `customizations/` and edit. For details, see [Reasoning Framework](docs/reasoning-framework.md).

## Core Concepts

Shaka uses a **progressive abstraction model** where each layer builds on the previous:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  WORKFLOWS   │ Multi-step pipelines with isolated contexts              │
│              │ Chains commands, prompts, and scripts                    │
│              │ e.g., review-and-fix, deploy-pipeline                    │
├──────────────┼──────────────────────────────────────────────────────────┤
│  SKILLS      │ Domain expertise and context containers                  │
│              │ Folder with SKILL.md + commands + context                │
│              │ e.g., code-review/, deployment/                          │
├──────────────┼──────────────────────────────────────────────────────────┤
│  COMMANDS    │ Single-purpose prompt + tool invocation                   │
│              │ Slash-invoked, atomic operations                         │
│              │ e.g., /commit, /diff, /lint                              │
├──────────────┼──────────────────────────────────────────────────────────┤
│  TOOLS       │ Deterministic TypeScript functions                       │
│              │ Pure code, no LLM involvement                            │
│              │ e.g., inference.ts                                        │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### Tools

Deterministic TypeScript functions that execute code, not prompts. Tools do the heavy lifting _before_ the LLM is involved.

Currently, two tools ship with Shaka:

- **`inference.ts`** — Provider-agnostic AI inference (wraps Claude CLI or opencode CLI)
- **`memory-search.ts`** — Search session summaries by keyword (exposed via MCP)

Shaka adopts [opencode's tool format](https://opencode.ai/docs/custom-tools/) for consistency across providers. Tools are TypeScript files using the `tool()` helper:

```typescript
// Example: ~/.config/shaka/system/tools/my-tool.ts
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Describe what the tool does",
  args: {},
  async execute(args, context) {
    // Deterministic code — no LLM involvement
    return "result";
  },
});
```

Tools are exposed to AI providers via:

- **opencode**: Symlinked to `.opencode/tools/` (native)
- **Claude Code**: Exposed via `shaka mcp serve` (MCP server)

### Commands

Atomic, slash-invoked operations. A command does **one thing**: invoke tools, add a prompt, and let the model respond. Markdown with YAML frontmatter.

```markdown
---
description: Create a git commit with AI-generated message
subtask: false
cwd:
  - "*"
providers:
  claude:
    model: sonnet
  opencode:
    model: openrouter/anthropic/claude-sonnet-4.6
---

Check what changed in the working tree, then generate a conventional commit message.

$ARGUMENTS
```

**Frontmatter fields:**

| Field            | Required | Description                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `description`    | Yes      | Short description shown in the slash menu                                   |
| `argument-hint`  | No       | Hint shown after command name (e.g., `[branch\|#pr]`)                       |
| `subtask`        | No       | Run as background subagent (`true`) or inline (`false`, default)            |
| `model`          | No       | Override the default model                                                  |
| `user-invocable` | No       | Show in slash menu (`true`, default) or hide for internal use (`false`)     |
| `cwd`            | No       | Project paths for scoped installation. `["*"]` = global (same as omitting)  |
| `providers`      | No       | Per-provider field overrides (e.g., different `model` for claude/opencode)  |

**Body substitutions:** `$ARGUMENTS` (all args), `$1`/`$2`/... (positional), `` !`cmd` `` (shell output).

Commands are the primary user interface. Type `/code-review` and it runs.

**Shipped commands:**

| Command       | Purpose                                             |
| ------------- | --------------------------------------------------- |
| `code-review` | Review local changes, a branch, or a PR             |

Commands live in `system/commands/` (shipped) and `customizations/commands/` (user). Customizations override system commands by filename match.

```bash
shaka commands list              # Show all commands and status
shaka commands new <name>        # Create a new command
shaka commands disable <name>    # Disable a command
shaka commands enable <name>     # Re-enable a disabled command
```

### Workflows

Multi-step pipelines that chain commands, prompts, and shell scripts. Each step runs with a fresh AI context, communicating through the file system and template variables — preventing the context degradation that happens when one long conversation tries to do everything.

```yaml
# review-and-fix.yaml
description: Review code changes and fix issues found
steps:
  - name: review
    command: /code-review
  - name: fix
    prompt: |
      Read the code review in reviews/review.md.
      Fix valid issues, skip incorrect suggestions.
      Delete reviews/ when done.
```

**Step types:**

| Type      | Description                                      | Example                          |
| --------- | ------------------------------------------------ | -------------------------------- |
| `command` | Invoke a slash command (provider resolves it)    | `command: /code-review`          |
| `prompt`  | Inline AI instruction with full tool access      | `prompt: Fix the failing tests`  |
| `run`     | Shell script (no AI, zero tokens)                | `run: bun test`                  |

**Template variables** for passing data between steps:

| Variable                    | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `{input}`                   | CLI input (`shaka run workflow "this text"`)   |
| `{previous.output}`        | stdout of the previous step                    |
| `{previous.exitCode}`      | Exit code of the previous step                 |
| `{steps.<name>.output}`    | stdout of a named step                         |
| `{steps.<name>.exitCode}`  | Exit code of a named step                      |

**Git state management:** By default (`state: "git-branch"`), the runner creates a branch, commits after each step that produces changes, and halts on failure — leaving a clean Git timeline. Use `state: "none"` for analysis-only workflows.

**Error handling:** Steps fail on non-zero exit by default (fail-fast). Mark a step with `allow-failure: true` to continue regardless — useful for test steps whose output feeds the next AI step.

Workflows live in `system/workflows/` (shipped) and `customizations/workflows/` (user). Customizations override system workflows by filename match.

**Shipped workflows:**

| Workflow         | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `review-and-fix` | Run a code review then assess and fix valid issues |

```bash
shaka run review-and-fix     # Run the shipped review-and-fix workflow
shaka run my-workflow "input" # Run a custom workflow with input
```

### Skills

Domain containers for complex workflows. A skill is a **folder** with a `SKILL.md` and optional supporting files. Skills are markdown-based — they provide context and workflow guidance to the AI, not executable code.

**Shipped skills:**

| Skill           | Purpose                                       |
| --------------- | --------------------------------------------- |
| BeCreative      | Extended thinking + diverse option generation |
| Council         | Multi-perspective debate (3-7 agents)         |
| RedTeam         | Adversarial validation (32 agents)            |
| Science         | Scientific method workflows                   |
| FirstPrinciples | Deconstruct → Challenge → Reconstruct         |

Skills are invoked by context ("review this PR") or explicitly ("use the code-review skill").

### Agents

Specialized personas defined as markdown prompt templates. Each agent has a defined role, tool access restrictions, and behavioral guidelines.

**12 agents ship with Shaka:** Algorithm, Architect, Artist, ClaudeResearcher, CodexResearcher, Designer, Engineer, GeminiResearcher, GrokResearcher, Intern, Pentester, QATester.

```markdown
---
name: reviewer
description: Code review specialist (read-only)
tools:
  read: true
  write: false
  bash: false
---

You are a code reviewer. You analyze but never modify code.
```

### Hooks

Event-driven automation. TypeScript scripts that run on specific events.

**Shipped hooks:**

| Hook                    | Event            | What it does                                                      |
| ----------------------- | ---------------- | ----------------------------------------------------------------- |
| `session-start.ts`      | SessionStart     | Loads reasoning framework, user context, recent session summaries |
| `session-end.ts`        | SessionEnd       | Parses transcript and generates session summary for memory        |
| `security-validator.ts` | PreToolUse       | Validates bash commands and file paths against security patterns  |
| `format-reminder.ts`    | UserPromptSubmit | Reminds the AI to follow the reasoning framework format           |

**Supported events:**

| Event              | Trigger                 |
| ------------------ | ----------------------- |
| `SessionStart`     | New conversation begins |
| `SessionEnd`       | Conversation ends       |
| `PreToolUse`       | Before a tool executes  |
| `PostToolUse`      | After a tool executes   |
| `UserPromptSubmit` | User sends a message    |

**Planned events:**

| Event           | Trigger                | Notes                                   |
| --------------- | ---------------------- | --------------------------------------- |
| `Stop`          | Session is terminated  | Graceful shutdown, final logging        |
| `SubagentStart` | A sub-agent is spawned | Claude Code native; opencode needs shim |
| `SubagentStop`  | A sub-agent completes  | Claude Code native; opencode needs shim |

### Memory

Persistent context that survives sessions. The memory system captures what happened in each session so the AI can reference past work.

- **Session summarization** — The `session-end` hook parses transcripts (Claude Code JSONL or opencode JSON) and generates structured summaries using AI inference
- **Summary storage** — Summaries are stored as markdown in `memory/summaries/` with a JSON index for fast lookup
- **Session context** — The `session-start` hook loads recent summaries into context so the AI knows what you worked on recently
- **Rolling summaries** — Daily, weekly, and monthly rollups compress session history into persistent per-project digests, loaded into context at session start
- **Search** — `shaka memory search <query>` searches summaries by keyword; also available as an MCP tool for in-session search
- **Review** — `shaka memory review` provides an interactive TUI for browsing, filtering, and deleting learnings. `--prune` adds AI-assisted quality scoring to flag low-value entries
- **Consolidation** — `shaka memory consolidate` merges duplicate learnings and resolves contradictions
- **Security event logging** — The security validator writes logs to `memory/security/`

**Planned:** Semantic retrieval via vector search (likely sqlite-vec), tiered memory with importance scoring.

## Provider Support

Shaka integrates with two AI coding assistants:

| Provider    | Tools                          | Hooks                      | Context    |
| ----------- | ------------------------------ | -------------------------- | ---------- |
| Claude Code | MCP server (`shaka mcp serve`) | Subprocess in `~/.claude/` | AGENTS.md  |
| opencode    | Native (`.opencode/tools/`)    | In-process plugin          | .opencode/ |

You write hooks once — provider-specific adapters handle the translation. For details on hook abstraction, event mapping, and tool integration, see [Providers](docs/providers.md).

## Security

The security validator hook (`security-validator.ts`) runs on every tool use, checking:

- **Bash commands** against patterns defined in `system/security/patterns.yaml`
- **File paths** for read/write operations (blocks access to sensitive directories)
- **Catastrophic operations** are blocked outright (e.g., `rm -rf /`)
- **Dangerous operations** trigger confirmation prompts

Security events are logged to `memory/security/`.

```yaml
# system/security/patterns.yaml
catastrophic:
  - pattern: "rm -rf /"
    description: "Recursive delete from root"
dangerous:
  - pattern: "git push --force"
    description: "Force push (rewrites history)"
```

**Planned:** Config-driven allow/deny directory lists, per-agent capability grants.

## Planned Features

These are ideas for future development, not yet implemented:

- **Interactive TUI** — `shaka` as a standalone terminal interface
- **Session management** — Persistent sessions across CLI invocations (`shaka start`, `shaka resume`, `shaka sessions`)
- **Workflow loops** — Conditional looping mechanics for workflows (file-based status contracts, max iterations)
- **Git worktrees** — `shaka run <workflow> --worktree` for isolated execution while you keep working
- **Feature polyfills** — Subagent events and background subagents for opencode

## Development

Requires [Bun](https://bun.sh) and [just](https://github.com/casey/just).

```bash
bun install          # Install dependencies
just check           # Run all checks (typecheck + lint + tests)
just test            # Run tests
just typecheck       # Run typechecker
just lint            # Run linter
just format          # Format code
```

### E2E Tests (Docker)

```bash
just e2e             # Run all e2e tests
just e2e-claude      # Claude Code e2e only
just e2e-opencode    # opencode e2e only
```

## Prior Art

This project learns from:

- **[PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure)** — Hook system, skill patterns, memory architecture
- **[PAI-OpenCode](https://github.com/Steffen025/pai-opencode)** — PAI port to opencode, hooks→plugins conversion
- **[Ren](https://github.com/erskingardner/ren)** — Deterministic-first philosophy, clean directory structure
- **[openclaw](https://github.com/openclaw/openclaw)** — Gateway pattern, typed workflows, multi-channel approach
- **[opencode](https://github.com/anomalyco/opencode)** — Provider abstraction, plugin architecture
- **[Claude Code](https://github.com/anthropics/claude-code)** — Hook system, context injection, subprocess model

## License

MIT
