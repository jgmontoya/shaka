# Architecture Decisions

Decisions made during Shaka's development, capturing rationale and trade-offs.

---

## ADR-001: External Templates over Embedded Strings

**Status:** Accepted

**Context:** Should template content (config, hooks, reasoning framework) be embedded as string literals in TypeScript, or kept as external files?

**Decision:** Use external files in `defaults/` directory, deployed during `shaka init`.

**Rationale:**

| Factor          | Embedded Strings          | External Files       |
| --------------- | ------------------------- | -------------------- |
| Maintainability | Edit TypeScript to change | Edit files directly  |
| Editor support  | No syntax highlighting    | Full highlighting    |
| Version control | Noisy diffs               | Clean diffs          |
| Testing         | Hard to test content      | File existence tests |

**Consequences:** `shaka init` must deploy files from `defaults/`. Template changes don't require code changes.

---

## ADR-005: Source Directory Structure

**Status:** Accepted

**Context:** How should `src/` be organized?

**Decision:** Flat four-layer structure:

```pseudocode
src/
├── domain/      # Pure types and functions (no I/O)
├── services/    # Business logic with Bun I/O
├── providers/   # Claude Code / opencode / Codex / Pi abstraction
└── commands/    # CLI handlers
```

**Rationale:** Premature separation adds complexity. The domain layer stays pure (no Bun imports), services use Bun APIs directly (no `FileSystemPort` abstraction), and providers are the only port interface. Refactor into deeper structure only when it earns its complexity.

**Consequences:** Simple to navigate. May need splitting if Phase 1+ adds significant infrastructure.

---

## ADR-006: Two-Tier Override Pattern

**Status:** Accepted

**Context:** How should users customize framework behavior without editing framework files?

**Decision:** Resolution order: `customizations/` -> `system/`

A file at `customizations/base-reasoning-framework.md` replaces `system/base-reasoning-framework.md`. Same pattern applies to hooks, tools, and any other system file.

**Rationale:** Matches PAI's SYSTEM/USER pattern. `system/` is framework-owned and replaced on upgrade. `customizations/` is user-owned and never touched by upgrades. Clear ownership boundaries.

**Consequences:** All file loading must check `customizations/` first. Users can fully customize without editing system files.

---

## ADR-008: Dependencies at Root Level

**Status:** Accepted

**Context:** Runtime dependencies (`eta`, `yaml`) were initially installed in `defaults/system/node_modules/`. This meant `defaults/` contained megabytes of packages that would need to be copied on every init.

**Decision:** Move all dependencies to the root `package.json`. No `package.json` or `node_modules/` inside `defaults/`.

**Rationale:** `defaults/` should be pure content (markdown, TypeScript source, YAML config). It gets symlinked to `~/.config/shaka/system/` -- having `node_modules` there conflates content with installed packages. The root `package.json` handles all dependencies, and `bun link` makes them available to hooks at runtime.

**Consequences:** Clean `defaults/` directory. Hooks resolve imports via `bun link shaka` (handled automatically by `shaka init`).

---

## ADR-009: Runtime Libraries in defaults/

**Status:** Accepted

**Context:** Hooks need shared code (e.g., `inference.ts`) at runtime. Should this live in `src/` or `defaults/`?

**Decision:** Runtime libraries used by hooks live in `defaults/system/tools/`, not `src/`.

**Rationale:** The key distinction is **CLI code vs deployed runtime**:

- `src/` = CLI tool code (`init`, `doctor`, `update`) -- NOT deployed to `~/.config/shaka/`
- `defaults/` = content that gets symlinked to `~/.config/shaka/system/` -- must be self-contained

Since hooks run at `~/.config/shaka/` (not in the repo), any code they import must travel with them. Putting `inference.ts` in `src/` would break hooks because `src/` isn't deployed.

**Consequences:** `inference.ts` lives at `defaults/system/tools/inference.ts`. Hooks import via relative path or the `shaka` package name (resolved by `bun link`).

---

## ADR-010: Autoresearch is a Command, not a Workflow

**Status:** Accepted

**Context:** The autoresearch pattern (hypothesize → benchmark → keep/discard, looped) is a long-running orchestration. Shaka already has workflows — yaml pipelines that chain steps with git commits between them. Should autoresearch be a workflow?

**Decision:** Autoresearch is a top-level command (`shaka autoresearch start|status|resume`), not a workflow.

**Rationale:** Workflows and autoresearch are different execution models:

|               | Workflow               | Autoresearch                   |
| ------------- | ---------------------- | ------------------------------ |
| Shape         | Finite step pipeline   | Unbounded optimization loop    |
| State         | Fresh context per step | Stateful across iterations     |
| Exit          | Last step completes    | User stops (Ctrl+C / `resume`) |
| Commits       | One per step           | One per keep verdict           |
| Context needs | Independent steps      | Reads prior iterations         |

Forcing autoresearch into workflow shape would mean inheriting branch-per-step commits, step-scoped variables, and one-shot semantics — all wrong. It reuses backend primitives (`runAgentStep`, git helpers from `src/services/git.ts`, `Bun.spawn` for the benchmark) without wearing the workflow-runner's clothes.

**Consequences:** `src/commands/autoresearch.ts` + `src/services/autoresearch.ts` are their own files. `listWorktrees`, `commitAllExcept`, `isCleanExcept`, and `revertWorkingTree` live in `src/services/git.ts` so future loop-shaped features can reuse them. A separate skill (`defaults/system/skills/autoresearch/SKILL.md`) carries the agent-facing protocol; the runner carries the mechanics.

---

## ADR-011: Provider Capabilities over Provider Switches

**Status:** Accepted

**Context:** Shaka supports Claude Code, opencode, Codex, and Pi. Install code
already lived under `src/providers/`, but execution behavior had drifted into
shared orchestration files: inference, agent execution, setup sessions, command
compilation, and doctor status checks each knew provider-specific CLI flags,
env guards, output formats, model mapping, or credentials.

**Decision:** Use small provider capability interfaces and concrete provider
modules instead of provider-name switches in orchestration code. The registry is
the explicit wiring point for provider order and module lookup. Provider modules
own their CLI quirks, generated artifacts, command formats, model mapping,
credential checks, and install paths. Shared orchestration may select and
iterate providers, but it must call provider capabilities for provider-specific
behavior.

**Rationale:** Adding a provider should change one provider module and one
registry entry, not inference, setup sessions, agent execution, commands, and
doctor in parallel. TypeScript interfaces plus composition fit the codebase
better than an abstract provider base class with many overrides.

**Consequences:** Provider-specific argv, env guards, output parsing, command
formatting, setup invocation, and health checks live beside the provider. Shared
helpers are allowed when at least two providers use the same behavior and tests
name that shared contract. A warning-only architecture check guards large
configurers, provider branches outside provider modules, stale opencode agent
names, provider-specific generic option fields, and duplicate process timeout
chains.
