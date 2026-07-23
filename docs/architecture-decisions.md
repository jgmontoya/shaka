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

---

## ADR-012: Canonical Boundaries for Compiled Knowledge

**Status:** Accepted

**Context:** Compiled topic pages use model-produced tags as filesystem
identities. A page can satisfy the Markdown schema while its filename creates a
second identity. This happened when a backtick-wrapped tag created a duplicate
topic. Generated pages can also omit required fields or source provenance.

**Decision:** Treat generated topic pages and tags as untrusted input. Use one
topic-slug contract for compilation, indexing, inspection, title discovery, and
search. Topic slugs contain lowercase ASCII letters and digits separated by
single hyphens, have a 200-character limit, and exclude reserved filenames.
Normalize Unicode form, surrounding whitespace, case, and whitespace runs in
model-produced tags before validation. Reject punctuation, path syntax, and
noncanonical stored entries.

Validate stored topic entries and fragment tags before compilation inference.
Validate every generated page against the topic schema and its expected sources
before writing any page in the batch. If generated output is invalid, make one
correction request containing typed validation issues and the authoritative
sources, then fail the compilation if the corrected output remains invalid.

Each reader uses the same filename parser: index rebuilding rejects invalid
stored entries, search and title discovery exclude them, and inspection reports
them while retaining provenance from readable regular files. Knowledge project
directories must be non-symlink directories directly under the knowledge root,
and topic paths must remain direct children of their project directory.

**Rationale:** A shared identity contract keeps compilation and retrieval from
assigning different meanings to the same filename. Preflight checks stop invalid
identities before model calls or filesystem mutation. One correction attempt
handles repairable model output with a fixed cost. Batch validation prevents a
validation failure from leaving a partially written topic set.

**Consequences:** Unicode remains available in page content while filesystem
identities stay portable. Existing noncanonical entries require explicit repair
before compilation can continue. Invalid generated output may use one extra
model call. A second validation failure leaves topic pages, the index, the log,
and the manifest unchanged. Readers report invalid stored state according to
their role without treating it as valid knowledge.

---

## ADR-013: One Authoritative Learning Applicability Scope

**Status:** Accepted

**Context:** Learnings can become useful across several projects. A wildcard
made those learnings global, but it discarded the project roots that supported
the decision. Adding runtime exclusions would require every recall path to
combine two applicability rules and would make broad ancestor inference unsafe.

**Decision:** The learning's active `cwds` array is the only runtime
applicability rule. Promotion metadata stores source CWDs, exclusions, exposure
snapshots, and provenance for reviewed transitions. Readers select entries from
`cwds` and do not interpret that metadata as another filter.

Scope widening follows the lexical path hierarchy. Positive evidence in three
distinct immediate child branches lets maintenance and explicit consolidation
replace those descendants with their parent. The rule runs from the deepest
nodes upward, so separate clusters and exact outliers can remain in one active
scope. A qualifying filesystem root is stored as `cwds: ["*"]`. The user's home
directory is never selected automatically.

Interactive consolidation starts from the automatic result and may offer a
broader common ancestor or global scope. Keeping the current scope sets
`nonglobal` and blocks later automatic widening. An exclusion immediately
rewrites active `cwds` to exact effective roots or a confirmed ancestor and sets
`nonglobal`. Inclusion removes one exact stored exclusion and previews the
result before writing it.

Legacy wildcard records remain global during migration. Migration preserves
mixed wildcard companion paths and adds exact source CWDs recovered from
history, with no inferred paths. Future reinforcement can add missing positive
roots.

**Rationale:** One active rule keeps session context, search, measurement, and
maintenance consistent. Stored evidence makes corrections reversible and gives
deterministic consolidation enough information to choose a safe narrower scope.
The three-child rule bounds each automatic widening step without assigning
meaning to directory names or inspecting the filesystem. Manual review covers
broader choices that the branch evidence does not support automatically.

**Consequences:** The flat three-CWD-to-global policy is removed.
Non-interactive consolidation still applies the deterministic hierarchy and
skips every prompt. A scope can become global only when a filesystem root, or
three distinct platform-parsed roots, has enough branch evidence. Lossy pruning
and condensation exclude entries with promotion evidence or `nonglobal: true`
until compound evidence partitioning has its own design. Mutation paths migrate
and validate active or archived storage before writing; ordinary reads remain
write-free.

---

## ADR-014: Recover Condensation Moves from an Immutable Intent

**Status:** Accepted

**Context:** Condensation appends source entries to `learnings-archive.md` and
removes them from `learnings.md`. A directory lock serializes Shaka writers,
but it cannot make both file replacements atomic. Publishing the archive first
can leave duplicate active and archived records if the process exits before the
active replacement. Retrying the old append-first flow can archive the sources
again.

**Decision:** Publish a condensation-specific intent before either target
changes. The intent stores each target's exact source state and validated
replacement text with SHA-256 hashes. While holding the learning lock, replay
accepts only a source or replacement state, publishes archive before active,
verifies both replacements, and removes the unchanged intent last. Every public
learning mutation resumes a pending intent before loading its requested target.

The consolidation compare-and-swap returns without an intent when the active
snapshot is stale. Condensation with no archive entries remains an
active-only replacement. `memory check` reports a safe pending intent as a
warning and malformed or third-state storage as an error without changing it.

**Rationale:** The intent freezes one logical move and makes each publication
step idempotent. Retry never recomputes the archive append. A small module for
two fixed files keeps this recovery rule separate from learning grammar and
avoids a general transaction abstraction.

**Consequences:** A process interruption can leave a visible partial state
until the next mutation runs recovery. Read-only operations remain write-free.
The protocol relies on the existing atomic-rename behavior and does not claim
power-loss durability because Shaka does not `fsync` files or directories.
