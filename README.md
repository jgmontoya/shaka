# Shaka

Shaka is a local, provider-agnostic framework for shaping how AI coding assistants work. It adds shared context, reusable skills and commands, workflow automation, memory search, MCP tools, and safety hooks around assistants such as Claude Code, Codex, opencode, and Pi. The goal is to give the assistants you already use the same instructions, tool definitions, memories, and guardrails.

It is built for developers who use AI assistants on real projects and want those assistants to remember preferences, follow repeatable workflows, reuse project-specific guidance, and avoid unsafe commands. Without a layer like Shaka, each provider tends to have its own config, history, commands, and safety model; switching tools means losing context or rebuilding the same conventions.

AI-assisted development depends on more than the model. The surrounding runtime decides what context gets injected, which tool code the assistant can call, how commands are validated, and how past work is found again. Shaka keeps those pieces local, inspectable, and owned by you.

Shaka is organized around a few concrete pieces:

- **MCP tools** expose Shaka tools, including inference and memory search, to providers that speak MCP.
- **Hooks** run on session and tool events, loading context at session start, writing memory at session end, and validating tool use before execution.
- **Skills** are markdown-based playbooks for recurring tasks, domains, and operating styles.
- **Workflows** chain commands, prompts, and shell steps into repeatable multi-step processes.
- **Memory search** queries stored session summaries, active learnings, and archived learnings so future sessions can recover useful context without rereading every transcript.
- **Command security validation** checks matched bash commands and file paths against safety patterns before execution.

## Getting Started

```bash
git clone https://github.com/jgmontoya/shaka.git
cd shaka
bun install
bun link
shaka init
```

`shaka init` will detect your installed providers (Claude Code, opencode, Codex, Pi, or any combination) and set everything up.

**Prerequisites:** [Bun](https://bun.sh) (make sure it's [on your `PATH`](https://bun.com/docs/installation#add-bun-to-your-path)) and at least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [opencode](https://opencode.ai), [Codex](https://github.com/openai/codex), or [Pi](https://pi.dev).

After installation, the quickest inspection commands are:

```bash
shaka doctor                  # Check installation health
shaka commands list           # See available commands
shaka skill list              # See system and installed skills
shaka memory search "query"   # Search this project's summaries, learnings, and knowledge
shaka memory check            # Check knowledge and learning storage integrity
shaka mcp serve               # Start the MCP server for supported providers
```

For source development, run:

```bash
bun install
just check
bun run src/index.ts --help
```

## What Happens

After `shaka init`, Shaka works through provider hooks:

1. **You start a session** (Claude Code, opencode, Codex, or Pi). The `session-start` hook loads the reasoning framework, edited top-level user files, selected learnings, the project knowledge index, rollups, and recent session summaries into the conversation context.

2. **You work normally.** Type prompts, ask questions, write code. Shaka is transparent.

3. **The AI tries to run a command.** The `security-validator` hook intercepts it, checks the command against your security patterns, and blocks anything catastrophic before it executes.

4. **You want to customize.** Copy any file from `system/` to `customizations/` and edit it. Your version takes priority. Upgrades never touch your files.

That's it. There is no separate chat UI to learn; the day-to-day surface stays inside your existing assistant.

## Philosophy

Shaka follows a few practical principles:

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
5. **All providers are first-class** -- Claude Code, opencode, Codex, and Pi all get the same treatment, not one primary + others as afterthoughts.

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
├── memory/                   # What Shaka learns about you (dynamic)
│   └── ...                   # Summaries, learnings, rollups, security logs
│
├── customizations/           # Your OVERRIDES for system/
│   ├── base-reasoning-framework.md  # (example) Your reasoning variant
│   └── hooks/                      # Your hooks
│
├── skills/                   # Installed third-party skills (via `shaka skill install`)
│
├── skills.json               # Tracks installed skills (source, provider, version)
│
├── system/ → <repo>/defaults/system  # Symlink to framework (replaced on upgrade)
│   ├── base-reasoning-framework.md   # Default reasoning framework
│   ├── hooks/                # Event-driven automation
│   ├── commands/             # Slash commands (markdown)
│   ├── workflows/            # Multi-step pipelines (yaml)
│   ├── skills/               # Reusable playbooks (markdown)
│   ├── tools/                # Callable operations exposed to providers
│   └── agents/               # Specialized personas (markdown)
│
└── config.json               # Configuration file
```

> **User file loading:** Edited `.md` files directly under `user/` are injected into the AI's context at session start; unchanged default templates are skipped. **Keep this level lean** — only files that are useful in every session, such as profile, assistant behavior, missions, goals, active projects, and tech stack. For detailed reference material (style guides, API docs, project specifics), create subdirectories. Subdirectory files are **not** auto-loaded — the model can read them on demand when relevant.
>
> **Index pattern:** If you add subdirectories, create a `user/index.md` to help the model discover them. Since it lives at the top level, it gets auto-loaded and acts as a routing guide:
>
> ```markdown
> # User Context Index
>
> ## reference/
>
> Detailed style guides and coding conventions. Read when making style or formatting decisions.
>
> ## api-docs/
>
> Internal API documentation. Read when integrating with or building against our services.
> ```

### Key Principle: Separation of Concerns

| Directory         | Purpose                           | Owner | Upgrades          | Backup |
| ----------------- | --------------------------------- | ----- | ----------------- | ------ |
| `user/`           | Who you are (you write it)        | You   | Never touched     | Yes    |
| `memory/`         | What Shaka learns (Shaka writes)  | Shaka | Never touched     | Yes    |
| `customizations/` | Your overrides for system/        | You   | Never touched     | Yes    |
| `skills/`         | Installed third-party skills      | You   | Never touched     | Yes    |
| `config.json`     | Shaka settings and provider prefs | You   | Never overwritten | Yes    |
| `system/`         | Framework defaults (symlink)      | Shaka | Replaced entirely | No     |

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
shaka init --codex            # Set up for Codex only
shaka init --pi               # Set up for Pi only
shaka init --all              # Set up for all detected providers
shaka update                  # Upgrade to latest release (tag-based)
shaka uninstall               # Remove hooks and framework links; keep user data
shaka reload                  # Re-discover hooks and regenerate provider configs
shaka doctor                  # Check installation health
shaka mcp serve               # Start MCP server (for Claude Code/Codex tool integration)
shaka commands list            # Show all commands and status
shaka commands new <name>     # Create a new command
shaka commands disable <name> # Disable a command
shaka commands enable <name>  # Re-enable a disabled command
shaka skill install <source>  # Install a skill (auto-detects GitHub or Clawhub)
shaka skill remove <name>     # Remove an installed skill
shaka skill update [name]     # Update one or all installed skills
shaka skill list              # List system + installed skills
shaka run <workflow> [input...] # Execute a multi-step workflow
shaka scan <file>             # Scan prose for AI writing patterns (slop)
shaka scan --dir <path>       # Scan all .md files in a directory
shaka memory search <query>   # Search this project's summaries, learnings, and knowledge
shaka memory search <query> --all # Search memory across every project
shaka memory stats            # Show learnings count, exposures, and category breakdown
shaka memory review           # Browse and manage learnings interactively
shaka memory review --cwd ..  # Correct a learning's project applicability
shaka memory review --prune   # AI-assisted quality assessment of learnings
shaka memory consolidate      # Deduplicate, resolve contradictions, and condense related learnings
shaka memory compile          # Compile session knowledge into topic pages
shaka memory check            # Check knowledge and learning storage integrity
```

### Init Flow

`shaka init` does the following:

1. Detects which providers (Claude Code, opencode, Codex, Pi) are installed
2. Prompts for provider selection (or use `--claude`/`--opencode`/`--codex`/`--pi`/`--all`)
3. Creates `user/`, `memory/`, `customizations/` directories
4. Symlinks `system/` to the repo's `defaults/system/`
5. Copies user file templates (`user.md`, `assistant.md`, `missions.md`, `goals.md`, `projects.md`, `tech-stack.md`)
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

Shaka uses a structured reasoning framework inspired by [PAI's Algorithm](https://github.com/danielmiessler/TheAlgorithm), loaded at session start. The default framework asks the AI to work through 7 phases — OBSERVE, THINK, PLAN, BUILD, EXECUTE, VERIFY, LEARN — and define testable success criteria (ISC) before acting.

To customize, copy `system/base-reasoning-framework.md` to `customizations/` and edit. For details, see [Reasoning Framework](docs/reasoning-framework.md).

## Core Concepts

Shaka uses a **progressive abstraction model** where each layer builds on the previous:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  WORKFLOWS   │ Multi-step pipelines with isolated contexts              │
│              │ Chains commands, prompts, and scripts                    │
│              │ e.g., review-and-fix, plan-feature                       │
├──────────────┼──────────────────────────────────────────────────────────┤
│  SKILLS      │ Domain expertise and context containers                  │
│              │ Folder with SKILL.md + optional support files            │
│              │ e.g., tdd/, writing-rules/                                │
├──────────────┼──────────────────────────────────────────────────────────┤
│  COMMANDS    │ Single-purpose prompt templates                           │
│              │ Provider-invoked prompt templates                        │
│              │ e.g., /code-review                                        │
├──────────────┼──────────────────────────────────────────────────────────┤
│  TOOLS       │ TypeScript operations exposed through MCP/native bridges  │
│              │ May run local code or bridge to provider CLIs             │
│              │ e.g., inference.ts                                        │
└──────────────┴──────────────────────────────────────────────────────────┘
```

### Tools

TypeScript modules that expose callable operations to assistants. Some tools are deterministic code; others, such as `inference.ts`, bridge to AI provider CLIs.

Currently, two tools ship with Shaka:

- **`inference.ts`** — Provider-agnostic AI inference (wraps Claude CLI, opencode CLI, Codex CLI, or Pi CLI)
- **`memory-search.ts`** - Search project sessions, learnings, and compiled knowledge by keyword

Both tools are surfaced to every supported provider's model: Claude Code and Codex via Shaka's MCP server (`shaka mcp serve`), opencode via the generated plugin's `tool` field, and Pi via `pi.registerTool()` in the generated extension. The generated opencode and Pi bridges shell out to `shaka tool <name>` when those tools run, while MCP providers execute the same tool definitions through the MCP server. Tool definitions live in one place (`defaults/system/tools/`) regardless of which provider the model is running under.

Tools are TypeScript files that export a tool definition with `description`, `inputSchema`, and `execute`:

```typescript
// Example: ~/.config/shaka/system/tools/my-tool.ts
export default {
  name: "my-tool",
  description: "Describe what the tool does",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async execute(args) {
    return "result";
  },
};
```

Tools are exposed to AI providers via:

- **Claude Code**: Exposed via `shaka mcp serve` (MCP server)
- **Codex**: Exposed via `shaka mcp serve` (MCP server)
- **opencode**: Exposed as native tools in the generated Shaka plugin
- **Pi**: Exposed via `pi.registerTool()` in the generated extension (native)

### Commands

Atomic command prompt templates. A command provides metadata and a prompt body, then the provider lets the model respond with its normal tool access. Command files are markdown with YAML frontmatter.

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

| Field            | Required | Description                                                                |
| ---------------- | -------- | -------------------------------------------------------------------------- |
| `description`    | Yes      | Short description shown in the provider command UI                         |
| `argument-hint`  | No       | Hint shown after command name (e.g., `[branch\|#pr]`)                      |
| `subtask`        | No       | Run as background subagent (`true`) or inline (`false`, default)           |
| `model`          | No       | Override the default model                                                 |
| `user-invocable` | No       | Show in the provider command UI (`true`, default) or hide for internal use |
| `cwd`            | No       | Project paths for scoped installation. `["*"]` = global (same as omitting) |
| `providers`      | No       | Per-provider field overrides (e.g., different `model` for claude/opencode) |

**Body substitutions:** Shaka handles `$ARGUMENTS` (all args) and `$1`/`$2`/... (positional). Provider-native shell blocks such as `` !`cmd` `` are preserved when a provider supports them.

Commands are the main prompt-template interface. Providers surface them through their native command, skill, or prompt mechanisms.

**Shipped commands:**

| Command       | Purpose                                 |
| ------------- | --------------------------------------- |
| `code-review` | Review local changes, a branch, or a PR |

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
description: Review code changes and fix issues found — loops until the review is clean
loop: 3
until:
  prompt: |
    Read the code review in reviews/review.md. Condition: the review
    reports no issues requiring code changes.
steps:
  - name: review
    command: /code-review
  - name: fix
    prompt: |
      Read the code review in reviews/review.md.
      Fix valid issues, skip incorrect suggestions.
```

**Step types:**

| Type      | Description                                   | Example                         |
| --------- | --------------------------------------------- | ------------------------------- |
| `command` | Invoke a Shaka command through the provider   | `command: /code-review`         |
| `prompt`  | Inline AI instruction with full tool access   | `prompt: Fix the failing tests` |
| `run`     | Shell script (no AI, zero tokens)             | `run: bun test`                 |

**Template variables** for passing data between steps:

| Variable                  | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `{input}`                 | CLI input (`shaka run workflow "this text"`)               |
| `{previous.output}`       | stdout of the previous step (carries across iterations)    |
| `{previous.exitCode}`     | Exit code of the previous step (carries across iterations) |
| `{steps.<name>.output}`   | stdout of a named step (current iteration)                 |
| `{steps.<name>.exitCode}` | Exit code of a named step (current iteration)              |
| `{loop.iteration}`        | Current loop iteration (1-based)                           |
| `{loop.total}`            | Configured loop count                                      |

**Looping:** Add `loop: N` to repeat all steps N times. Useful for iterative refinement patterns like test-fix cycles. Each iteration's artifacts are stored in `iter-N/` subdirectories. Use `--loop N` on the CLI to override.

**Dynamic stopping (`until`):** Pair `loop: N` with an `until` condition to stop as soon as the work is good enough — the cap becomes a budget instead of a fixed count. The condition is evaluated after each iteration:

```yaml
loop: 5 # hard cap, required with until
until:
  run: bun test # exit code 0 = done, stop looping
steps:
  - name: fix
    prompt: "Fix the failing tests. Errors: {previous.output}"
```

Two condition types:

- `run:` — a shell check; exit code 0 stops the loop. Free and deterministic — prefer it whenever a scriptable check exists.
- `prompt:` — an LLM judge. Write only the question ("Condition: all review comments are addressed"); Shaka appends a verdict instruction and strictly parses the reply's last line — `SATISFIED` stops, anything else continues. Costs one agent call per iteration.

The condition sees the same template variables as steps, and its output lands in `iter-N/until.out` beside the step artifacts. Reaching the cap without satisfaction is still a completed run: `run.json` records `satisfiedAt` (the iteration that stopped early, or `null`), and the CLI prints `(satisfied after N/M iterations)` on early stops. Groups can carry their own `until` alongside their `loop`. A condition that fails to evaluate (crash, missing binary, no verdict line) counts as "not satisfied" — the loop continues, bounded by the cap.

> **Codex note:** `codex exec` refuses to run outside a git repository, so prompt-type conditions (and `prompt` steps generally) in `state: none` workflows need the working directory to be a git repo.

**Group steps:** Inline groups compose multiple steps under a single name with optional looping:

```yaml
steps:
  - name: refine
    loop: 3
    steps:
      - name: critique
        prompt: Review the plan critically
      - name: revise
        prompt: Address valid feedback
```

Groups isolate their `{steps.<name>}` scope — inner steps can't see outer variables, and the outer workflow sees the group's last result via `{steps.refine.output}`.

**Workflow references:** Reuse an entire workflow as a step. The referenced workflow's steps are inlined as a group, inheriting its loop count:

```yaml
steps:
  - name: setup
    run: echo "preparing"
  - name: review-cycle
    workflow: review-and-fix
  - name: deploy
    run: echo "deploying"
```

References are resolved transitively with cycle detection.

**Git state management:** By default (`state: "git-branch"`), the runner creates a temporary worktree on a branch, commits after each step that produces changes, and halts on failure. Use `state: "none"` for analysis-only workflows.

**Error handling:** Steps fail on non-zero exit by default (fail-fast). Mark a step with `allow-failure: true` to continue regardless — useful for test steps whose output feeds the next AI step.

Workflows live in `system/workflows/` (shipped) and `customizations/workflows/` (user). Customizations override system workflows by filename match.

**Shipped workflows:**

| Workflow         | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `review-and-fix` | Run a code review then assess and fix valid issues         |
| `plan-feature`   | Plan a feature with iterative critique and revision cycles |

```bash
shaka run review-and-fix     # Run the shipped review-and-fix workflow
shaka run my-workflow "input" # Run a custom workflow with input
```

### Skills

Domain containers for complex workflows. A skill is a **folder** with a `SKILL.md` and optional supporting files. Skills are markdown-first: they provide context and workflow guidance to the AI, and installed skills are scanned before they are linked into provider directories.

**Shipped skills:**

| Skill              | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| autoresearch       | Hypothesis, benchmark, keep/discard optimization protocol |
| autoresearch-setup | Benchmark harness setup for `shaka autoresearch start`   |
| be-creative        | Extended thinking and diverse option generation           |
| council            | Multi-perspective debate (3-7 agents)                     |
| experiment         | Reproducible proof-of-concept investigations              |
| first-principles   | Deconstruct, challenge, and reconstruct reasoning         |
| red-team           | Evidence-backed adversarial analysis and steelmanning     |
| science            | Scientific method workflows                               |
| tdd                | Test-driven development (default for implementation work) |
| validate-plan      | Multi-pass pressure test before implementation            |
| writing-rules      | Anti-slop prose constraints plus `shaka scan`             |

Skills are invoked by context ("review this PR") or explicitly ("use the code-review skill").

**Installing skills:**

Skills can be installed from GitHub repositories or the Clawhub registry. The source is auto-detected based on input format:

```bash
# GitHub (auto-detected when input contains /)
shaka skill install user/repo              # Shorthand
shaka skill install user/repo#v1.0.0       # Specific ref
shaka skill install https://github.com/user/skill-repo
shaka skill install https://github.com/user/repo/tree/main/skills/my-skill

# Clawhub (auto-detected for bare words without /)
shaka skill install sonoscli               # Latest version
shaka skill install sonoscli@1.2.0         # Specific version

# Explicit provider override
shaka skill install my-skill --github      # Force GitHub provider
shaka skill install my-skill --clawhub     # Force Clawhub provider
shaka skill install my-skill --clawdhub    # Legacy alias (deprecated)

# Security options
shaka skill install user/repo --yolo       # Skip security checks and prompt
```

GitHub repos without a root `SKILL.md` are discovered via fallback paths: marketplace metadata (`.claude-plugin/marketplace.json`), Claude layout (`.claude/skills/<name>/SKILL.md`), and plugin-style `skills/<name>/SKILL.md`.

Installed skills live in `skills/` and are symlinked to enabled provider skill directories. A security scan flags executable and unknown file types (`.ts`, `.js`, `.sh`, etc.), URLs, HTML comments, and invisible characters before installation.

### Agents

Specialized personas defined as markdown prompt templates. Each agent has a defined role, tool access restrictions, and behavioral guidelines.

**17 agent definitions ship with Shaka:** Algorithm, Architect, Artist, ClaudeResearcher, CodeReviewer, CodexResearcher, Designer, DevOpsEngineer, Engineer, GeminiResearcher, GrokResearcher, Intern, Pentester, QATester, TechnicalWriter, plus the internal `autoresearch-setup` and `inference` agents used by Shaka itself.

```markdown
---
name: reviewer
description: Code review specialist (read-only)
capability: review
permissions:
  allow:
    - "Read(*)"
    - "Grep(*)"
    - "Glob(*)"
mode: subagent
permission:
  read: allow
  grep: allow
  glob: allow
---

You are a code reviewer. You analyze but never modify code.
```

### Hooks

Event-driven automation. TypeScript scripts that run on specific events.

**Shipped hooks:**

| Hook                    | Event           | What it does                                                      |
| ----------------------- | --------------- | ----------------------------------------------------------------- |
| `session-start.ts`      | `session.start` | Loads reasoning framework, user context, recent session summaries |
| `session-end.ts`        | `session.end`   | Parses transcript and generates session summary for memory        |
| `security-validator.ts` | `tool.before`   | Validates bash commands and file paths against security patterns  |
| `format-reminder.ts`    | `prompt.submit` | Reminds the AI to follow the reasoning framework format           |

**Supported events:**

| Event           | Trigger                 |
| --------------- | ----------------------- |
| `session.start` | New conversation begins |
| `session.end`   | Conversation ends       |
| `tool.before`   | Before a tool executes  |
| `tool.after`    | After a tool executes   |
| `prompt.submit` | User sends a message    |

These are Shaka's canonical hook events. Provider adapters map them to native provider events; for example, Codex uses its native `Stop` event internally for `session.end` handling.

### Memory

Persistent context that survives sessions. The memory system captures what happened in each session so the AI can reference past work.

- **Session summarization** — The `session-end` hook parses transcripts (Claude Code JSONL, opencode export JSON, Codex JSONL, or Pi JSONL) and generates structured summaries using AI inference
- **Summary storage** — Summaries are stored as markdown with YAML frontmatter in `memory/sessions/`
- **Session context** - The `session-start` hook loads recent summaries from the current project scope
- **Rolling summaries** — Daily, weekly, and monthly rollups compress session history into persistent per-project digests, loaded into context at session start
- **Search** - `shaka memory search <query>` searches the current project's summaries, active and archived learnings, and compiled knowledge. Global learnings remain visible. Pass `--all` for an explicit cross-project search. The same scope rules apply to the MCP tool, which accepts `all_projects: true`.
- **Knowledge compilation** — `shaka memory compile` extracts reusable project knowledge from session summaries into topic pages and a loadable index
- **Review** - `shaka memory review` provides an interactive TUI for browsing, deleting, and correcting learning scope. Excluding a CWD rewrites the active `cwds`; including it reverses the stored exclusion. Use `--cwd <path>` to review another project. `--prune` adds AI-assisted quality scoring to flag low-value entries.
- **Consolidation** - `shaka memory consolidate` runs duplicate, contradiction, and condensation passes, then applies deterministic scope generalization. Interactive runs may offer a broader ancestor or global scope after the automatic step. Unattended runs apply the deterministic step and skip the prompts. Condensation archives its source entries so they remain searchable and recoverable.
- **Automatic maintenance** - After each session, the system checks time (24h) and volume (10+ new learnings) gates. When triggered, it runs consolidation, applies deterministic scope generalization, and may prune low-quality entries under budget pressure (capped at 3 per run, with exposure and age safety floors). Learnings with scope evidence or `nonglobal: true` are excluded from lossy pruning and condensation. Configurable via `memory.maintenance.enabled`.
- **Security event logging** — The security validator writes logs to `memory/security/`

Active `cwds` is the only runtime applicability rule. Promotion metadata records positive source CWDs and exclusions for review and deterministic consolidation; readers do not interpret it as a second filter. Legacy global learnings stay global while migration backfills every source CWD that can be recovered without guessing.

Automatic generalization requires positive evidence in three distinct immediate child branches. Three repositories under one project select the project ancestor; three projects under one company select the company ancestor. A qualifying filesystem root becomes global (`cwds: ["*"]`). Separate qualifying clusters remain a forest beside exact outliers, and repeated evidence inside one branch does not widen the scope. Shaka does not select the user's home directory automatically.

**Retrieval policy:** Shaka keeps substring search and the complete knowledge index as the baseline. A candidate retrieval backend must retrieve the corpus's known zero-overlap paraphrase or reduce separately measured production context cost without weakening exact lookup, project scope, archive visibility, evidence paths, result limits, or read-only behavior.

## Autoresearch

Autoresearch is a stateful optimization loop: an agent proposes a change, a scripted benchmark measures it, winners get committed, losers get reverted, and an append-only log accumulates across context resets. The "research" is algorithmic — hypothesize, test, keep or discard — not web research. Inspired by [Shopify's Autoresearch post](https://shopify.engineering/autoresearch).

```bash
shaka optimize start "cut bun test from 45s to <20s"
shaka optimize status
shaka optimize resume            # continue the unique active experiment
shaka optimize resume <slug>     # continue a specific one from anywhere
shaka optimize html <slug>       # generate and open a single-page HTML report
shaka optimize cleanup <slug>    # remove the experiment worktree, optionally the branch
```

`shaka autoresearch ...` remains available as the original command spelling. `optimize` is the friendlier alias.

`start` creates a dedicated git worktree + branch (`autoresearch/<slug>`) so the loop never touches your main checkout. Each iteration runs the agent against a prompt assembled from the skill protocol, your `autoresearch.md` spec, and the last few jsonl entries — then executes `./autoresearch.sh` to measure. The runner commits on a metric improvement, reverts otherwise, and appends one JSON line per iteration to `autoresearch.jsonl` (excluded from runner commits; preserved across reverts). The baseline is stored in `autoresearch.meta.json` so reports and resumes can distinguish the original baseline from candidate iterations.

`cleanup` is interactive by default and shows what it will remove before deleting anything. Use `shaka optimize cleanup <slug> --worktree --keep-branch --yes` to remove the temporary worktree while keeping `autoresearch/<slug>` available locally, or `--worktree --branch --yes` to remove both. Dirty worktrees and unmerged branch deletion require `--force`.

**State files** used in the worktree:

| File                     | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `autoresearch.md`        | Run spec: objective, metric, direction, files in scope, constraints |
| `autoresearch.sh`        | Benchmark script. Must print `METRIC name=<n> value=<v> unit=<u>`   |
| `autoresearch.checks.sh` | Optional setup artifact. Exit 0 = acceptable candidate              |
| `autoresearch.jsonl`     | Created/appended during iterations. Excluded from runner commits    |
| `autoresearch.meta.json` | Runner-owned metadata including the baseline. Excluded from commits |

**Verdict classes:** `keep` (improved + checks pass), `discard` (didn't improve), `incorrect` (checks failed or commit hook rejected), `crash` (benchmark errored), `timeout` (agent timed out).

**Flags:** `--provider <claude|opencode|codex>` forces a provider. `--max-iterations <N>` stops after N iterations. `--stop-after <N>` stops after N consecutive discards. Ctrl+C pauses between iterations; `resume` picks up where you left off.

See [docs/autoresearch-walkthrough.md](docs/autoresearch-walkthrough.md) for an end-to-end example.

## Provider Support

Shaka integrates with four AI coding assistants:

| Provider    | Tools                                 | Hooks                                                    | Commands                                  | Skills + Agents                                             |
| ----------- | ------------------------------------- | -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Claude Code | MCP server (`shaka mcp serve`)        | Subprocess hooks in `~/.claude/settings.json`           | `~/.claude/skills/<command>/SKILL.md`     | `~/.claude/skills/`, `~/.claude/agents/`                    |
| opencode    | Native tools in generated plugin      | In-process plugin at `~/.config/opencode/plugins/`      | `~/.config/opencode/commands/`            | `~/.config/opencode/skills/`, `~/.config/opencode/agents/`  |
| Codex       | MCP server (`shaka mcp serve`)        | Wrapper script via `~/.codex/hooks.json`                | `~/.agents/skills/<command>/SKILL.md`     | `~/.agents/skills/`, `~/.codex/agents/*.toml`               |
| Pi          | Native bridge via `pi.registerTool()` | Generated extension at `~/.pi/agent/extensions/shaka.ts` | `~/.pi/agent/prompts/`                    | `~/.pi/agent/skills/` with `shaka-` / `shaka-agent-` prefixes |

You write hooks once — provider-specific adapters handle the translation. For details on hook abstraction, event mapping, and tool integration, see [Providers](docs/providers.md).

## Security

The security validator hook (`security-validator.ts`) runs on matched `tool.before` events, checking:

- **Bash commands** against patterns defined in `system/security/patterns.yaml`
- **File paths** for matched read/write operations (blocks access to sensitive directories)
- **Catastrophic operations** are blocked outright (e.g., `rm -rf /`)
- **Dangerous operations** trigger confirmation prompts

Security events are logged to `memory/security/`.

```yaml
# system/security/patterns.yaml
version: "1.0"

bash:
  blocked:
    - pattern: "rm -rf /"
      reason: "Filesystem destruction"
  confirm:
    - pattern: "git push --force"
      reason: "Force push can lose commits"
  alert:
    - pattern: "curl.*\\|.*sh"
      reason: "Piping curl to shell"

paths:
  zeroAccess:
    - "~/.ssh/id_*"
  readOnly:
    - "/etc/**"
  confirmWrite:
    - "**/.env"
  noDelete:
    - "**/.git/**"
```

**Planned:** Config-driven allow/deny directory lists, per-agent capability grants.

## Planned Features

These are ideas for future development, not yet implemented:

- **Interactive TUI** — `shaka` as a standalone terminal interface
- **Session management** — Persistent sessions across CLI invocations (`shaka start`, `shaka resume`, `shaka sessions`)
- **Workflow early exit** — `until` conditions for loops (stop on no changes, sentinel output, or verification command pass)
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
just e2e-codex       # Codex e2e only
just e2e-pi          # Pi e2e only (mount ~/.pi/agent/auth.json to exercise the auth path)
```

## Prior Art

This project learns from:

- **[PAI](https://github.com/danielmiessler/Personal_AI_Infrastructure)** — Hook system, skill patterns, memory architecture
- **[PAI-OpenCode](https://github.com/Steffen025/pai-opencode)** — PAI port to opencode, hooks→plugins conversion
- **[opencode](https://github.com/anomalyco/opencode)** — Provider abstraction, plugin architecture
- **[Claude Code](https://github.com/anthropics/claude-code)** — Hook system, context injection, subprocess model
- **[Codex](https://github.com/openai/codex)** — Subprocess hooks, agent TOML format, MCP integration

## License

MIT
