/**
 * Per-provider argv builders for the full-auto autoresearch setup session,
 * plus the `runSetupInteractive` orchestrator that dispatches to the right
 * builder and hands stdio to the provider's native TUI via `Bun.spawn`.
 *
 * Each builder returns the argv passed to `Bun.spawn`. Pure functions; no
 * side effects. Empirically verified against claude v2.1.116, opencode
 * 1.14.19, and codex v0.122.0 in Experiment 39.
 */

import { runAgentStep } from "../domain/agent-execution";
import { DEFAULT_PI_MODEL, DEFAULT_PI_PROVIDER } from "../providers/pi/defaults";
import type { ProviderName } from "../providers/types";
import type { DetectedProviders } from "../services/provider-detection";

/** Single-provider DetectedProviders override — forces `runAgentStep` to dispatch to one backend. */
function onlyProvider(provider: ProviderName): DetectedProviders {
  return {
    claude: provider === "claude",
    opencode: provider === "opencode",
    codex: provider === "codex",
    pi: provider === "pi",
  };
}

/**
 * Claude: positional seeds the first user turn; `--append-system-prompt`
 * layers the setup skill on top of the default system prompt.
 */
export function buildClaudeArgs(objective: string, skillBody: string): string[] {
  return ["claude", objective, "--append-system-prompt", skillBody];
}

/**
 * Opencode: `--prompt` seeds the first message; `--agent` references the
 * `shaka/autoresearch-setup` agent file installed at init time.
 */
export function buildOpencodeArgs(objective: string): string[] {
  return ["opencode", "--prompt", objective, "--agent", "shaka/autoresearch-setup"];
}

/**
 * Codex interactive exposes neither `--agent` nor `--system-prompt`, so we
 * prepend the skill body to the objective as a single positional prompt.
 * Mirrors `callCodexCLI` in `src/inference.ts`.
 */
export function buildCodexArgs(objective: string, skillBody: string): string[] {
  return ["codex", `${skillBody}\n\n## Objective\n\n${objective}`];
}

/**
 * Pi: pin Anthropic explicitly (Pi defaults to google per Exp 42), append
 * the setup skill on top of Pi's default coding-assistant prompt with
 * `--append-system-prompt`, and pass the objective as the positional
 * initial-prompt slot. Repeatable per Exp 42.
 */
export function buildPiArgs(objective: string, skillBody: string): string[] {
  return [
    "pi",
    "--provider",
    DEFAULT_PI_PROVIDER,
    "--model",
    DEFAULT_PI_MODEL,
    "--append-system-prompt",
    skillBody,
    // Terminate option parsing so an objective starting with `-` (YAML
    // frontmatter, Markdown lists, etc.) isn't misread as a Pi flag —
    // see memory/feedback_argv_prompts_need_double_dash.md.
    "--",
    objective,
  ];
}

export interface SetupSessionResult {
  readonly exitCode: number;
  readonly provider: ProviderName;
  /** Captured from provider's exit output, if emitted. Null when absent. */
  readonly resumeHint: string | null;
  readonly sessionId: string | null;
}

export interface SetupSessionDeps {
  readonly spawn?: typeof Bun.spawn;
}

/**
 * Run the interactive setup session in the user's terminal.
 *
 * Hands Shaka's stdin/stdout/stderr to the provider CLI via
 * `Bun.spawn({ stdio: "inherit" })` and awaits `proc.exited`. The user
 * converses directly with the agent inside the provider's native TUI; Shaka
 * is parked on the kernel-level wait until the child exits. See full-auto.md
 * Phase 1 ("How control transfers") for the mental model.
 *
 * **Resume-hint parsing is deferred.** Under `stdio: "inherit"`, the child's
 * stdout/stderr goes straight to the real terminal — no bytes flow through
 * Shaka to parse. This function therefore returns `resumeHint: null` and
 * `sessionId: null` unconditionally. The plan's session-hygiene table
 * (full-auto.md, "Session hygiene") is a forward-looking contract that
 * requires teeing output; implementing teeing is a future refinement and is
 * explicitly out of scope for this commit.
 *
 * No Shaka-side timeout cap: the user governs session length (Phase 1).
 */
export async function runSetupInteractive(
  worktreePath: string,
  objective: string,
  provider: ProviderName,
  skillBody: string,
  deps?: SetupSessionDeps,
): Promise<SetupSessionResult> {
  const spawn = deps?.spawn ?? Bun.spawn;
  const argv =
    provider === "claude"
      ? buildClaudeArgs(objective, skillBody)
      : provider === "opencode"
        ? buildOpencodeArgs(objective)
        : provider === "pi"
          ? buildPiArgs(objective, skillBody)
          : buildCodexArgs(objective, skillBody);
  const proc = spawn(argv, {
    cwd: worktreePath,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;
  return { exitCode, provider, resumeHint: null, sessionId: null };
}

/**
 * Run the setup agent non-interactively as a single `runAgentStep` call.
 *
 * Opt-in alternative to `runSetupInteractive` for unattended overnight queues,
 * CI, scripted invocations, or unambiguous objectives where the TTY round-trip
 * buys nothing. No TTY handoff — Shaka awaits the agent subprocess with a
 * 15-minute ceiling (generous enough for realistic setup work; exp 36 median
 * was ~125 s per cell).
 *
 * The skill body is prepended to the objective and paired with an explicit
 * "no user to ask" directive so the agent doesn't stall waiting for
 * clarification it can't receive. Self-verification (running
 * `./autoresearch.sh`) remains the agent's job; Shaka's `validateSetup`
 * re-runs it from the outside as the authoritative gate.
 *
 * Symmetric return shape with `runSetupInteractive` so the command layer can
 * dispatch trivially on `opts.oneshot`. Resume-hint parsing is irrelevant here
 * (no TUI session to resume) — returns `resumeHint: null, sessionId: null`
 * unconditionally.
 */
export interface SetupOneshotDeps {
  readonly runAgent?: typeof runAgentStep;
}

export async function runSetupOneshot(
  worktreePath: string,
  objective: string,
  provider: ProviderName,
  skillBody: string,
  deps?: SetupOneshotDeps,
): Promise<SetupSessionResult> {
  const prompt = `${skillBody}\n\n## Objective\n\n${objective}\n\n## Task\n\nCreate the setup artifacts in the current working directory. You do NOT have a user to ask clarifying questions — make your best judgment from the objective and the repo. Run \`./autoresearch.sh\` yourself to verify the METRIC line emits correctly before you finish.`;
  // Force the selected provider so `--provider X` is honored — without this,
  // runAgentStep falls back to detectInstalledProviders() and dispatches to
  // whichever backend happens to be first-available, silently ignoring the
  // user's choice.
  const result = await (deps?.runAgent ?? runAgentStep)(
    {
      prompt,
      cwd: worktreePath,
      timeout: 15 * 60 * 1000,
    },
    onlyProvider(provider),
  );
  return {
    exitCode: result.exitCode,
    provider: result.provider ?? provider,
    resumeHint: null,
    sessionId: null,
  };
}
