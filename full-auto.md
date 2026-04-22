# Full-auto autoresearch setup (default)

**Status:** implemented in PR #28; retained as design notes
**Started:** 2026-04-21

## Problem

Running `shaka autoresearch start "<objective>"` today takes three ceremony steps between "I have an idea" and "the loop is running":

1. Answer six wizard questions — in a rigid, one-field-at-a-time format, even when the user's objective already implied most of them in free-form natural language
2. Edit `autoresearch.sh` by hand to extract the runtime number and emit a `METRIC` line
3. Run `shaka autoresearch resume`

Both (1) and (2) are pain, for different reasons. Step 2 forces the user to write shell plumbing — `awk`/`grep` against whatever their benchmark happens to print. Step 1 forces a rigid-schema input shape: six discrete questions, answered in order, even when the user would rather describe the whole thing once in a paragraph and point at a file. The wizard's schema and the manual `METRIC` wiring are two facets of the same underlying problem: today's setup requires the user to translate their intent into a specific schema and a specific output format, instead of letting a capable agent do that translation from the natural-language description they already have. Full-auto replaces both with one agent-driven setup session that creates and validates the setup artifacts before the normal autoresearch loop starts.

**Full-auto is an interactive session in the user's terminal, not a one-shot background task.** Shaka hands stdin/stdout/stderr to the provider CLI via `Bun.spawn({ stdio: "inherit" })`, and the user converses directly with the agent inside the provider's native TUI (claude's Ink UI, opencode's Bubble Tea UI, codex's Rust UI). When the agent asks a clarifying question, the user answers. When the agent has produced the setup, the user types `/exit` or Ctrl-D. Shaka then takes control back, validates the files on disk, commits if they pass, and enters the loop. The setup phase is seconds-to-minutes long and happens right after the user hits Enter on `shaka autoresearch start` — they haven't walked away yet — so "interactive" matches the actual usage pattern without forcing a non-interactive ceremony it would have to guess around.

**Full-auto is the default**, not an opt-in flag. `shaka autoresearch start "<objective>"` uses the agent-driven setup path. The original interactive wizard is still available behind an explicit `--wizard` opt-out for users who prefer to fill in each field by hand, environments that can't run an agent, or CI/non-TTY contexts where interactive handoff isn't possible. The release story is "we made setup work from a conversation with the agent, in your terminal"; a `--full-auto` flag would bury that behind a discovery problem.

**What this costs (make-or-break trade-off to know upfront):** full-auto requires a TTY by default. If stdin isn't a TTY (CI, scripted `shaka autoresearch start` in a bash pipeline, ssh with `-T`), the command fails with an actionable error pointing at `--wizard`. Default is interactive. A `--oneshot` opt-in runs non-interactively via `runAgentStep` (no TTY required) — useful for unattended queues, CI, or unambiguous objectives. The loop itself still runs unattended after setup regardless of path.

## Design

Four phases, each with specific failure modes and fallbacks. No phase silently produces a broken experiment.

This is a pre-loop setup path, not a new loop mode. `runLoop` stays ignorant of the setup mechanism; it continues to consume a committed, validated `autoresearch.md` and executable `autoresearch.sh`.

### Phase 0: Worktree creation

Reuse the existing autoresearch worktree model, but do not commit TODO templates before the setup agent runs.

Add an explicit setup mode to the workspace setup boundary:

- `templateMode: "wizard"`: current interactive wizard behavior
- `templateMode: "todo"`: current non-TTY placeholder behavior
- `templateMode: "defer"`: create the worktree/branch only; leave missing setup artifacts for the setup agent. Named `defer` not `none` so it reads as intent ("deferred to a later step"), not absence.

Default (full-auto) uses `templateMode: "defer"`. If the source repo already tracks `autoresearch.md`, `autoresearch.sh`, or `autoresearch.checks.sh`, the worktree inherits them and the setup agent may refine them. Otherwise, the setup agent creates them from scratch. This avoids a noisy "commit TODO template, then replace it" history.

### Phase 1: Interactive setup session

Writing a working `autoresearch.sh` from an objective isn't a classifier task. Real benchmarks require exploration (what does `just benchmark` invoke?), iteration (the first extraction regex won't parse the output reliably), sometimes reading source (the scenario file describes the metric better than stdout does), and sometimes clarification (the user's objective was ambiguous enough that the agent should ask rather than guess). That's the shape of an interactive agent session, not a chain of `inference()` calls, and not a one-shot subprocess.

#### How control transfers (the mental model that matters)

**Shaka never actually leaves.** `Bun.spawn(..., { stdio: "inherit" })` tells the OS to give the child process copies of Shaka's stdin/stdout/stderr file descriptors. Both processes share the terminal. Shaka then calls `await proc.exited`, which is a kernel-level wait syscall — Shaka is parked, not gone. The provider CLI reads user input and writes output directly. When the user types `/exit` or Ctrl-D, the provider exits, the OS wakes Shaka via `SIGCHLD`, and the next line of Shaka's code runs.

Analog: this is exactly what `git commit` without `-m` does when it spawns `$EDITOR`. Git doesn't hand the terminal away; it waits on the editor's exit. When you `:wq`, git resumes and writes the commit. Same mechanism — decades of Unix tools rely on it. No PTY, no `node-pty`, no output parsing, no custom streaming.

Empirically verified end-to-end against all three providers in Experiment 39 (`experiments/39-provider-interactive-handoff/`): TUI renders, initial prompt reaches the agent, keystrokes route correctly, exit returns control to Bun. See Step 2 for the per-provider invocation commands that were verified.

#### AutoresearchSetup skill

We introduce a new skill, `AutoresearchSetup`, that parallels the existing `Autoresearch` skill. The loop's skill teaches "one hypothesis, one change, one HYPOTHESIS: line." The setup skill teaches "produce a working harness — a passing `./autoresearch.sh` that emits `METRIC name=… value=… unit=…`, plus a minimal `autoresearch.md` spec, and optionally `autoresearch.checks.sh`. Ask the user if the objective is genuinely ambiguous; self-verify by running the script before you declare done." The skill body gets injected into the interactive session via each provider's system-prompt / agent mechanism (see Step 2).

#### Session length

No Shaka-side timeout cap. The user governs session length. Typical setups run 30 seconds to a few minutes (exp 36 median ~125 s for claude one-shot; interactive will add some conversation overhead but remains bounded by human attention). Ctrl-C bubbles up as a normal signal and terminates the session; Shaka catches it, runs validation against whatever files exist (usually: fails), and exits.

### Phase 2: Validation gate

After the interactive session exits, Shaka validates the setup independently. Agent success text is never enough, and for opencode specifically, the child-process exit code can be zero even on fatal startup errors (Experiment 39 caveat) — validation looks at artifacts on disk, not at session state.

Validation checks:

1. `autoresearch.md` parses with the existing `parseSpec` contract, including `- direction: minimize|maximize`.
2. `./autoresearch.sh` exists, is executable, exits 0, and emits a parseable `METRIC name=... value=... unit=...` line via the existing benchmark behavior.
3. `./autoresearch.checks.sh`, when present, exists, is executable, and exits 0 against the baseline tree.
4. Only setup artifacts are dirty after setup and validation: `autoresearch.md`, `autoresearch.sh`, and optional `autoresearch.checks.sh`. Any unrelated dirty path fails the setup instead of being committed or reverted.

**Contract (what Phase 2 does):** interactive session exits → `validateSetup` runs once. No retry, no re-entry, no second agent invocation.

- **Pass:** commit the setup files (Phase 3), enter the loop.
- **Fail:** print the failing phase, captured stdout/stderr (where applicable), and the worktree path. Exit without entering the loop. Worktree stays on disk for inspection. The user can re-run `shaka autoresearch start` with a more specific objective, or open the worktree and hand-edit.

<details>
<summary><strong>Archive: why there is no retry (2026-04-21, per Experiment 40)</strong></summary>

Earlier drafts prescribed one bounded retry with a structured `priorFailure` payload fed back to the agent. Experiment 40 (`experiments/40-retry-on-validation-failure/`) ran 4 diverse fixtures (1 mechanical + 3 semantic) against all three providers — 12 cells across claude v2.1.116, opencode 1.14.19, and codex v0.122.0 — and found that retry **never fired on any cell, on any provider**. Every first attempt passed mechanical validation. The combination of the skill's self-verification directive ("run `./autoresearch.sh` yourself to verify") and each provider's semantic comprehension made retry a cold code path. The bounded-retry mechanism's expected value on realistic setups is close to zero, and keeping it would have been code that never executes. In an interactive session, any pre-validation recovery also dies naturally: if the agent is uncertain, it asks the user in the TUI rather than producing a broken output that needs a retry to catch. One secondary exp-40 finding is plan-relevant: on `sem-multi-benchmark`, opencode correctly chose one of two candidate benchmarks but did NOT record the choice in `autoresearch.md`, while claude and codex both did. This is a skill-authoring concern (strengthen the "record your choice" directive for opencode — addressed in Step 1), not a retry/plumbing concern.

</details>

### Phase 3: Enter the loop

Identical to the existing post-wizard flow. `commitFinalizeIfDirty` commits the generated setup files, then `runLoop` runs. No new logic belongs in `runLoop`.

With `--dry-run`, validation still runs, but Shaka does not commit and does not enter the loop. The generated setup artifacts remain dirty for review; `shaka autoresearch resume <slug>` finalizes them through the existing `commitFinalizeIfDirty` path.

## Trust model

Full-auto is autonomous agent execution with user-in-the-loop. The agent may author and run a benchmark harness inside a linked git worktree; the user sees the agent's actions live in the TUI as they happen, but the commit only lands after Shaka's independent validation passes.

Shaka does not add OS-level sandboxing. Git worktrees protect the user's main checkout from **git operations** — `git reset`, `git clean`, etc. — but they do NOT contain filesystem operations. An agent running `rm -rf ../main-checkout` from inside the worktree will happily oblige. Mitigation is layered: (a) the user watches the session live; (b) validation rejects unrelated dirty files before commit; (c) `--dry-run` lets the user inspect the script before the loop starts; (d) error text and docs call out that full-auto is autonomous harness generation. Not perfect, but materially safer than a purely unattended non-interactive variant would be.

## Prerequisite refactors

These land before the steps that depend on them. Each is small; grouping them up-front keeps the steps themselves focused on the new behavior.

1. **Parameterize `loadAutoresearchSkill()`** → `loadSkill(name: string)`. Today it hardcodes `Autoresearch`; the setup agent needs `AutoresearchSetup`. Resolution order (customizations/ wins over system/) preserved. Blocks Step 1.
2. **Export a `runBenchmark(worktreePath): Promise<BenchResult>`** helper, factored out of today's private `defaultBenchmark`. Used by both the service-layer loop (unchanged call site) and the new `validateSetup`. Blocks Step 3.
3. **Add `templateMode: "wizard" | "todo" | "defer"` to `setupWorkspace`**. Current call sites switch from implicit (TTY + answers) to explicit. The non-TTY path migrates to `"todo"` without behavior change; the wizard path migrates to `"wizard"`. Blocks Step 4.
4. **Extract `assertOnlySetupDirty(worktreePath)`** — a single helper shared by `commitFinalizeIfDirty` (existing) and `validateSetup` (new). The `SETUP_ARTIFACTS` constant (`src/services/autoresearch.ts:250`) stays the single source of truth; callers must import it, never inline. Prevents drift between validation's dirty-gate and the command layer's.
5. **Install `shaka/autoresearch-setup` agent files at init time** for opencode (`~/.config/opencode/agents/shaka/autoresearch-setup.md`) and codex (`~/.codex/agents/shaka/autoresearch-setup.md`), mirroring the existing `shaka/inference` installation that `shaka init` already manages. **Content policy:** the agent-file body is the same Markdown as `defaults/system/skills/AutoresearchSetup/SKILL.md` — one source of truth, installed into two provider-specific paths. Implementation follows the existing `shaka/inference` installer in the provider-configurer surface verbatim; no new format to invent. Claude uses `--append-system-prompt <SKILL body>` at spawn time and does not need a pre-installed agent file. Blocks Step 2.

## Steps

### Step 0: Setup-agent validation spike

**Done 2026-04-21.** `experiments/36-full-auto-setup/` ran the 5-shape × 2-length matrix and closed the gate: 10/10 cells passed on first attempt, 10/10 generated scripts POSIX-only, 10/10 wired the canonical invocation, no regression between short and long objectives. Per-cell wall-time maxed at 161 s against a 900 s cap. See experiment Findings for the full table. **Provider parity closed post-spike**: Experiment 40 (2026-04-21) re-ran a 4-fixture cut against opencode 1.14.19 and codex v0.122.0 — all 12 cells passed first-attempt validation, confirming the spike generalizes across providers.

**Unblocks**: full-auto as default can ship.

**Note on experiment relevance to interactive mode:** exp 36 and exp 40 both used non-interactive `runAgentStep` (one-shot). Step 0's empirical claim is that **the agent can produce a correct harness from a clear objective** — which interactive mode strictly strengthens (conversation can only add signal, not subtract). Exp 39 separately verified that the interactive handoff mechanism itself (stdio inherit, TUI render, keystroke routing, exit-returns-control) works across all three providers. The two together give full coverage.

### Step 1: `AutoresearchSetup` skill

- New skill at `defaults/system/skills/AutoresearchSetup/SKILL.md`
- Content: the contract ("produce files that make the loop runnable"), the `METRIC` line format with examples, the validation check the agent should perform itself (run `./autoresearch.sh`, confirm one `METRIC name=... value=... unit=...` line on stdout), guidance on keeping `autoresearch.md` minimal, and permission to ask the user for clarification when the objective is genuinely ambiguous (interactive-mode-specific).
- The generated `autoresearch.md` MUST record the chosen benchmark command or benchmark source when the repo exposes more than one candidate. Experiment 40 surfaced a real gap: on `sem-multi-benchmark` (two plausible benchmarks, objective "Make it faster"), claude and codex both documented their pick in `autoresearch.md`; opencode picked one but left the spec silent. Iteration agents later read the spec, not the transcript — silent choices break the audit trail. Mitigation is authoring-level: the skill body must include an explicit example, not just a directive.
- Parallel file structure to existing `defaults/system/skills/Autoresearch/SKILL.md` so the same loader surface handles both.
- **Seed a `## What's Been Tried` section in the generated `autoresearch.md`** (initially empty, e.g. `_no iterations yet_`). Idea cribbed from pi-autoresearch's rolling-log convention: a fresh iteration agent resuming after a context reset reads this narrative faster than it can re-derive history from `autoresearch.jsonl`. **This step seeds the section only**; the iteration side (teaching the Autoresearch loop skill to append a one-line bullet when logging each entry) is a separate follow-up and explicitly out of scope here.

#### Concrete `SKILL.md` skeleton

Use this as the starting template. Frontmatter shape mirrors the sibling skill `defaults/system/skills/Autoresearch/SKILL.md`; only the `name`, `description`, `key`, and `include_when` lines differ.

````markdown
---
name: AutoresearchSetup
description: Interactive setup protocol — produce autoresearch.md + autoresearch.sh + optional autoresearch.checks.sh from a natural-language objective so the loop can run.
key: autoresearch-setup
include_when: Only inside `shaka autoresearch start` (full-auto default) before the loop begins. Loaded via provider-specific system-prompt / agent mechanism at session spawn time.
---

# Autoresearch Setup Protocol

You have been handed a git worktree and a natural-language objective. You are in an interactive terminal session with the user. Produce a working benchmark harness that the autoresearch loop can consume. Ask the user if the objective is genuinely ambiguous — you are talking to them in real time.

## Output contract

Three files in the worktree root:

1. **`autoresearch.md`** — the spec. Required fields under `## Metric`:
   - `- command: ./autoresearch.sh`
   - `- direction: minimize` OR `- direction: maximize`
   - `- unit: <unit>` (e.g. `s`, `ms`, `ops/s`, `count`, `bytes`)

2. **`autoresearch.sh`** — executable shell script. When run with no args from the worktree root, it exits 0 and emits exactly one line on stdout matching:
   `METRIC name=<name> value=<number> unit=<unit>`

3. **`autoresearch.checks.sh`** (optional) — correctness gate. Exits 0 when the candidate is acceptable against the baseline tree.

## How to verify yourself

Before exiting, run `./autoresearch.sh` from the worktree root. If it exits 0 and stdout contains a line matching `METRIC name=... value=... unit=...`, you're done. If not, fix and re-run. When you're confident the setup is correct, tell the user and exit (`/exit` or Ctrl-D).

## When to ask the user

Ask, don't guess, when:
- The objective names a benchmark that doesn't exist in the repo.
- The repo has multiple plausible benchmarks and the objective doesn't disambiguate (e.g. "make it faster" with both `bench-cli.sh` and `bench-api.sh`).
- The metric direction is unclear (is "performance" latency or throughput?).
- The benchmark produces output you can't confidently parse.

Don't ask for decisions you can make safely on your own (file names, awk regexes, POSIX vs non-POSIX tool choice, etc.).

## Constraints

- Only touch `autoresearch.md`, `autoresearch.sh`, and (optionally) `autoresearch.checks.sh`. Do not modify anything else in the worktree.
- Prefer POSIX tools (`awk`, `grep`, `sed`, `cut`) over `rg`, `fd`, or `jq`. The generated script must work on a minimal Unix system.
- **Record your choices in `autoresearch.md`.** When the repo exposes more than one plausible benchmark, iteration agents later read the spec, not your transcript — silent choices break the audit trail. Use the shape below.

## Required spec structure

```markdown
# <one-line objective, paraphrased>

## Metric
- command: ./autoresearch.sh
- direction: minimize
- unit: s

## Benchmark
- wraps: ./bench-cli.sh — CLI startup latency (lower is better)

## What's Been Tried
_no iterations yet_
```

Seed the `## What's Been Tried` section as shown — the iteration loop appends to it later.
````

This skeleton is the starting deliverable. Subsequent edits (e.g. adding examples of `METRIC` lines for different units, clarifying `autoresearch.checks.sh` patterns) land incrementally without changing the loader surface.

### Step 2: Interactive setup harness

Per-provider invocation shims dispatch to `Bun.spawn({ stdio: "inherit" })`. One function per provider; `runSetupInteractive` dispatches on detected provider.

```ts
interface SetupSessionResult {
  readonly exitCode: number;
  readonly provider: ProviderName;
  /** Captured from provider's exit output, if emitted. Null when absent. */
  readonly resumeHint: string | null;
  readonly sessionId: string | null;
}

async function runSetupInteractive(
  worktreePath: string,
  objective: string,
  provider: ProviderName,
): Promise<SetupSessionResult>;
```

The function returns after the child process exits (Shaka is parked on `await proc.exited` — see Phase 1's mental model). No timeout; user governs session length.

#### Per-provider invocation (empirically verified, Experiment 39)

All three verified end-to-end:

- **Claude (v2.1.116):** `claude "<objective>" --append-system-prompt "<SKILL body>"` — positional arg seeds the first user turn; `--append-system-prompt` layers the setup skill on top of the default.
- **Opencode (1.14.19):** `opencode --prompt "<objective>" --agent shaka/autoresearch-setup` — TUI is the default; `--prompt` seeds the first message; `--agent` references the file installed by Prereq #5. An earlier draft of this plan incorrectly used `opencode tui …`, which opencode parses as "start TUI with project path `tui`" and fails with `Error: Failed to change directory to <cwd>/tui` while still exiting 0 — that silent-fail mode is addressed by the validation gate looking at artifacts on disk, not at child exit codes.
- **Codex (v0.122.0):** `codex "<SKILL body>\n\n## Objective\n\n<objective>"` — codex interactive has no `--agent` or `--system-prompt` flag (confirmed via `codex --help`), so the skill body is prepended to the objective as a single positional prompt, mirroring `callCodexCLI` in `src/inference.ts`. The `~/.codex/agents/shaka/autoresearch-setup.md` file installed by Prereq #5 remains useful for `codex agent` listing/picker, but is not referenced at spawn time for full-auto.

#### Session hygiene

All three providers persist sessions by default and print a resume hint at exit. After the child exits, Shaka captures the resume ID from the child's stderr/stdout via the regex patterns below (best-effort; no match → skip cleanup, don't fail), then fire-and-forget cleanup runs off the critical path:

| Provider | Exit-line pattern (observed in exp 39) | Extraction regex | Cleanup command |
|---|---|---|---|
| Claude | `Resume this session with: claude --resume <session-id>` | `/claude --resume (\S+)/` | No-op this release. Claude sessions under `~/.claude/projects/<hash>/<session>.jsonl` are append-only and don't accumulate fast. Revisit if users report clutter. |
| Opencode | `Continue  opencode -s ses_<id>` | `/opencode -s (ses_\S+)/` | `opencode --pure session delete <sessionId>` (fire-and-forget, non-blocking). Matches existing inference-path hygiene (see `reference_opencode_session_ops.md`). |
| Codex | `codex resume <uuid>` | `/codex resume (\S+)/` | No subcommand to delete a codex session as of v0.122.0; no-op this release. Flag follow-up if user-facing clutter accumulates. |

Cleanup never blocks commit or loop entry. A failed cleanup logs and continues. Regex capture is intentionally permissive — if a provider updates its exit-line format, capture returns `null` and cleanup simply skips.

#### Where it lives

- Orchestration in `src/services/autoresearch.ts` alongside `setupWorkspace`, `runLoop`, `runResume`.
- Per-provider invocation shims in a new `src/services/setup-session.ts`. Three pure functions: `buildClaudeArgs(objective, skillBody): string[]`, `buildOpencodeArgs(objective): string[]`, `buildCodexArgs(objective): string[]`. Each returns the `argv` passed to `Bun.spawn`. `runSetupInteractive` dispatches on provider, builds argv, spawns with `stdio: "inherit"`, awaits exit, triggers hygiene.
- `runSetupOneshot` lives alongside `runSetupInteractive` in the same file. It shares the `SetupSessionResult` return type so the command layer dispatches on `opts.oneshot` with identical downstream handling. Internally it composes the skill body + objective + a "no user to ask" task directive and calls `runAgentStep` (non-interactive, 15-minute ceiling); no `Bun.spawn` stdio-inherit handoff and no session-hygiene path.
- CLI printing, flags, `--dry-run` / `--oneshot` handling, exit behavior in `src/commands/autoresearch.ts`.

`runSetupInteractive` accepts an optional `deps?: { spawn?: typeof Bun.spawn }` parameter so integration tests can inject a fake spawn without touching real CLIs. The stub-provider smoke test (Step 6) uses the real `Bun.spawn` against a deterministic sh script.

### Step 3: Validation gate

- Export or reuse the existing benchmark behavior instead of duplicating script execution logic; today it is private as `defaultBenchmark`.
- `validateSetup(worktreePath, deps?: { runBenchmark?, parseSpec?, assertOnlySetupDirty? }): Promise<SetupValidationResult>` — explicit `deps` shape so the test seam is visible.
- Supporting types already exported from `src/services/autoresearch.ts`:

  ```ts
  export interface Measurement {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
  }

  export interface BenchResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    /** Null iff parse failed or the script exited non-zero. */
    readonly measurement: Measurement | null;
  }
  ```

  Prereq #2 exports `runBenchmark(worktreePath): Promise<BenchResult>` from the existing private `defaultBenchmark`. `validateSetup` calls it and narrows the `Measurement` out into the success variant below.

- `SetupValidationResult` is a discriminated union:

  ```ts
  type SetupValidationResult =
    | { ok: true; measurement: Measurement; checksExitCode?: number }
    | {
        ok: false;
        phase: "spec" | "benchmark" | "checks" | "dirty";
        message: string;
        stdout?: string;
        stderr?: string;
      };
  ```

  TS narrows on `result.ok`; callers get actionable diagnostics without null-branching.

- Called by the command layer after `runSetupInteractive` returns.
- **Sets the executable bit defensively** on `autoresearch.sh` and `autoresearch.checks.sh` (if present) before attempting to run them, so a user who edited the files by hand during the interactive session doesn't fail validation for missing `+x`. Equivalent to the exp-36 spike's validate function.
- On failure: print a clear message naming the failing phase and pointing at the worktree. Exit without entering the loop.

### Step 4: CLI wiring — full-auto as the default

- `shaka autoresearch start "<objective>"` takes the agent-driven interactive path by default.
- Add `--wizard` opt-out flag. When set, skip the setup agent entirely and use today's interactive wizard + TODO-template flow. Kept for three reasons: (a) environments without an installed agent provider, (b) non-TTY contexts (CI, scripted starts, `-T` ssh), (c) users who prefer to fill fields by hand.
- Add `--oneshot` flag. Runs the setup agent non-interactively via `runAgentStep` (no TTY handoff); bypasses the non-TTY guard. Rejected when combined with `--wizard` (orthogonal escape hatches); combines cleanly with `--dry-run`.
- Add `--dry-run` flag. Useful with the default path; rejected when combined with `--wizard` (the wizard doesn't produce a loop-entry step to skip).
- Add `--provider <name>` flag to force a specific provider when multiple are installed. Default resolution order matches `runAgentStep`: claude → opencode → codex.
- **No agent provider installed** → the default fails with an actionable error pointing at `shaka init` / `shaka doctor` AND suggesting `--wizard`. We do NOT auto-fall-back to the wizard — silent fallback turns a clear provider-setup issue into confusing flow drift.
- **Non-TTY** (`process.stdin.isTTY !== true`) → the default fails with an error that names `--wizard` as the fallback and explains why (interactive handoff requires a TTY). We do NOT auto-fall-back. Same reasoning as no-provider.
- Command flow:
  1. If `--wizard`: `setupWorkspace({ templateMode: "wizard" })`, then existing wizard path unchanged. Exit via resume.
  2. If non-TTY and no `--oneshot` (no `--wizard`): print error naming `--wizard`, exit non-zero. No worktree created. (`--oneshot` bypasses this check by design.)
  3. If no provider detected (no `--wizard`): print error naming `--wizard` and `shaka init`, exit non-zero. No worktree created. Applies to both default and `--oneshot` paths.
  4. Default (TTY or `--oneshot`, provider available, no `--wizard`): `setupWorkspace({ templateMode: "defer" })` → dispatch on `opts.oneshot` to either `runSetupOneshot(worktreePath, objective, provider, skill)` or `runSetupInteractive(worktreePath, objective, provider, skill)` → `validateSetup(worktreePath)`.
  5. If `--dry-run`: after validation passes (which sets `+x` defensively — see Step 3), print the worktree path + `autoresearch.sh` contents, then exit without commit or loop. Works with or without `--oneshot`.
  6. Default (no `--dry-run`): `commitFinalizeIfDirty(worktreePath, { message: "autoresearch: finalize agent-generated setup" })`, then `runLoop(...)`.

  **Note on `commitFinalizeIfDirty` signature:** today the function is `commitFinalizeIfDirty(worktreePath: string): Promise<void>` with the commit message hardcoded to `"autoresearch: finalize benchmark"` (see `src/commands/autoresearch.ts:100`). This step extends the signature to `commitFinalizeIfDirty(worktreePath: string, opts?: { message?: string }): Promise<void>`, defaulting to the existing string when omitted. Wizard callers don't change; full-auto passes the agent-generated message for git-log provenance (so `git log --grep "agent-generated"` finds auto-setup commits). Small, backward-compatible.

### Step 5: Review affordance

- `--dry-run`: after the interactive session exits and validation passes, don't commit and don't enter the loop. Print the worktree path and the generated `autoresearch.sh` for review. User runs `shaka autoresearch resume <slug>` when ready.
- Default (without `--dry-run`): enter the loop immediately after validation succeeds.
- Rationale: the promise is "no wizard and no shell plumbing," not "no loop entry." Whether the loop starts immediately or waits for `resume` is a separate axis. First-time users who want to eyeball what the agent produced can pass `--dry-run`; returning users in flow-state don't need it.

### Step 6: Tests and docs

The interactive session itself is LLM-mediated and effectively untestable at the conversation level. Test strategy follows three axes:

- **Unit tests** for per-provider invocation arg construction (`buildClaudeArgs`, `buildOpencodeArgs`, `buildCodexArgs` — or whatever the names settle to). Pure functions; no subprocess.
- **Integration tests** with injected `spawn` — exercise command-layer composition (non-TTY error, provider-missing error, `--wizard` path, dry-run path, commit + loop on validation pass, diagnostic on validation fail) without a real child.
- **One stub-provider end-to-end smoke test** — spawn a deterministic stub script (simple sh that writes canned setup files and exits) via the real `Bun.spawn({ stdio: "inherit" })`. Verifies the handoff mechanism works and validation picks up what the child wrote. This is the sole test that touches the real spawn path.
- **Validation-gate tests** (same as before):
  - missing/invalid `autoresearch.md` direction
  - missing or unparsable `METRIC`
  - failing `autoresearch.checks.sh`
  - dirty gate rejecting non-setup artifacts
- **Skill-contract fixture test**: the generated `autoresearch.md` contains `## What's Been Tried` when a scripted-agent stub produces the spec.
- **Docs**: update `docs/autoresearch-walkthrough.md` to lead with the default agent-driven interactive path; document `--wizard` and `--dry-run` as opt-outs; document the non-TTY behavior explicitly.

## Open questions

1. **Command provenance**: how strict should this release be when the objective does not name a benchmark command? Options:
   - require an explicit command in the objective and fail to the wizard otherwise
   - allow repo-discovered commands (`just bench`, `bun test`, package scripts, cargo/go/pytest conventions) when the setup agent records its choice in `autoresearch.md`
   - allow arbitrary inference and rely on validation

   Lean: allow repo-discovered commands, but require the generated spec to record what was chosen. The interactive session can also ask the user if the agent is uncertain — which strengthens this lean.

2. **No-provider-installed path**: the default fails with an actionable error naming `--wizard` and `shaka init`. Lean hard-error — hidden behavior changes are worse than a clear message.

3. **Non-TTY path**: hard-error naming `--wizard` as the fallback. Resolved; see Problem section for the trade-off.

4. **Objective length limits**: at what objective length does setup quality degrade? Test fixtures should include short one-line and long paragraph objectives. Lean: no Shaka-side hard cap — short objectives are handled by the agent asking for clarification in the TUI; long objectives are bounded by the provider's own context window. Revisit only if users report specific failures tied to input length.

5. **Multiple benchmark candidates**: if the objective or repo exposes several plausible commands, the interactive session's answer is "agent asks the user." The spec still must record the final choice. No hardcoded heuristic.

6. **Resume semantics after Ctrl-C mid-session**: if the user Ctrl-Cs the interactive session, the worktree has partial or missing setup artifacts. `shaka autoresearch resume <slug>` today assumes `autoresearch.md` exists. Options: (a) resume requires the spec and fails fast if missing (clearest); (b) resume re-invokes setup when the spec is missing (most forgiving, more complex). Lean (a): missing spec means setup never finished; re-running `start` from the main repo is the right recovery.

7. ~~**Setup-agent abort threshold for Step 0 spike**~~ — **Resolved 2026-04-21 (moot)**. Step 0 closed at 10/10; no threshold slide was needed.

8. ~~**Deleted-inherited-artifact handling**~~ — **Resolved 2026-04-21** via `experiments/38-porcelain-z-deletion-shape`. `listDirtyPaths` handles the `" D autoresearch.sh"` porcelain-z token correctly; dirty-gate accepts deletions alongside modifications and untracked files with no code change.

9. ~~**Agent `autoresearch.sh` depending on host-only tools**~~ — **Resolved 2026-04-21** via `experiments/36-full-auto-setup` (10/10 generated scripts POSIX-only, including the `hyperfine` JSON shape where reaching for `jq` would have been ergonomic). No skill directive needed; the agent defaults to POSIX.

10. ~~**Retry mechanism on validation failure**~~ — **Removed 2026-04-21** per Experiment 40's 12-cell cross-provider matrix (0 retries fired). See Phase 2 archive.

11. ~~**Interactive-vs-non-interactive design**~~ — **Resolved: interactive only.** See Problem section for the decision and trade-off.

## Rejected alternatives

Don't revisit unless new evidence.

- **Chain of `inference()` calls (objective-extract → probe → snippet-inference → validate)** — the shape this plan started in. Rejected because real benchmarks need exploration, not classification. The agent often needs to read the benchmark source before it can interpret the output; needs to iterate when the first extraction doesn't parse; needs to decide whether to use `awk`, `jq`, a temp file, or a re-run with a different flag. That's agent-shaped work, not a pipeline of single-turn classifiers. The validation gate survives in Phase 2.

- **One-shot non-interactive setup as the default** — rejected as the default; shipped as the `--oneshot` opt-in flag. Experiment 40's 12-cell cross-provider matrix (11/12 first-attempt real fixes across claude / opencode / codex) justifies both sides of the decision: one-shot is good enough to be a reliable opt-in for unattended / CI / scripted contexts where a TTY handoff isn't possible or wanted, but the one marginal cell (opencode's silent-choice gap on `sem-multi-benchmark`) is why interactive stays the default — conversational handoff lets the agent ask rather than guess. `--oneshot` is explicit user opt-in into the "no user to ask" mode, not a silent fallback.

- **Generate `autoresearch.sh` without validation, let the baseline measurement fail naturally** — harder to debug. Fail fast at setup.

- **Fall back to the interactive wizard automatically on any setup failure** — surprising UX. The default is now the agent path; if the agent fails, silently swapping to the wizard hides the real problem (missing provider? non-TTY? bad objective?) behind a reset of the user's expectation. Fail loudly, leave the worktree, point at it. `--wizard` is explicit.

- **Keep full-auto behind an opt-in flag** — rejected because the release story is "setup works from a conversation with the agent" — burying that behind a flag turns it into a discovery problem and leaves the wizard as the implicit "right way," which contradicts the point of the feature. The wizard stays available behind `--wizard` for users who want it.

- **Shaka-level setup loop with a separate `inference()` semantic gate and a user-input feedback cycle** — considered during plan review. Rejected because (a) the separate `inference()` semantic gate duplicates the work the agent session already does (a hallucinating agent will often be agreed with by a hallucinating verifier); (b) a Shaka-mediated user-prompt loop between agent runs requires state we don't want to maintain (loop counter, conversation history, Ctrl-C recovery semantics); (c) interactive handoff natively provides the user-in-the-loop that this Shaka-mediated loop was trying to approximate, without Shaka needing to own the state machine.

- **Retry on validation failure** — removed 2026-04-21 per exp 40. See Phase 2 archive.

- **Always run `--dry-run` first (never auto-enter the loop)** — too cautious. Users who invoked full-auto have opted in; adding an extra gate erodes the value. Make `--dry-run` opt-in.

- **Build a denylist of "dangerous" benchmark commands to refuse** (`rm -rf`, `dd`, etc.) — false-sense-of-security: denylists are always incomplete and scanning shell strings meaningfully is intractable. Interactive handoff's real mitigation is that the user watches the session live in the TUI.

- **Use a PTY or `node-pty` for the handoff** — rejected; `Bun.spawn({ stdio: "inherit" })` is sufficient (verified in exp 37 against a stub and exp 39 against all three real providers). PTY adds a dependency, a primitive, and a maintenance surface for no functional gain on this code path.

## Acceptance criteria

End-to-end done when:

- `shaka autoresearch start "<objective>"` (no flags, TTY, provider installed) launches an interactive session in the provider's TUI with the objective seeded as the first message. Verified against claude, opencode, and codex.
- The 5 canonical benchmark shapes from Step 0 (`cargo-bench`, `go-bench`, `hyperfine`, `just-tracing`, `pytest-benchmark`, under `experiments/36-full-auto-setup/fixtures/`) all complete setup, pass validation, and enter the loop when exercised end-to-end with each provider. Manual verification; automating this requires real LLM sessions and is out of scope.
- `shaka autoresearch start "<objective>" --wizard` still runs the original six-question wizard and leaves the TODO-marker `autoresearch.sh` exactly as it does today. Regression-level behavior.
- `shaka autoresearch start "<objective>" --dry-run` runs the interactive session, validates the files, prints the worktree path + generated `autoresearch.sh`, does not commit, and does not enter the loop.
- `shaka autoresearch start "<objective>" --oneshot` succeeds in a non-TTY context (the TTY guard is bypassed) and commits + enters the loop when validation passes. Combining with `--dry-run` runs oneshot setup + validation and exits without committing or entering the loop. Combining with `--wizard` is rejected at arg-parse time.
- `shaka autoresearch start "<objective>"` on a box with no agent provider installed fails with an actionable message that names `--wizard` and `shaka init` and does NOT silently fall back.
- `shaka autoresearch start "<objective>"` in a non-TTY context (piped stdin or `ssh -T`) fails with an actionable message that names `--wizard` as the fallback and explains the reason.
- When validation fails after the interactive session exits, the error message names the failing phase (spec / benchmark / checks / dirty) and leaves the worktree on disk for user inspection.
- Existing autoresearch tests stay green; new tests cover: per-provider invocation arg construction (unit), command-layer composition with injected spawn (integration), stub-provider end-to-end smoke (real `stdio: "inherit"` path), validation gate, and the `## What's Been Tried` seed.
- `docs/autoresearch-walkthrough.md` leads with the default agent-driven interactive path and documents `--wizard`, `--dry-run`, and `--provider` as opt-outs/overrides.
