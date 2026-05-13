/**
 * Autoresearch setup session orchestration.
 *
 * Provider-specific argv and oneshot behavior live in provider setup
 * capabilities. This module composes the shared setup prompt and dispatches
 * to the selected provider.
 */

import { type ProcessRunner, runProcess } from "../platform/process-runner";
import { getProviderModule } from "../providers/registry";
import type { ProviderName } from "../providers/types";

/**
 * Claude: positional seeds the first user turn; `--append-system-prompt`
 * layers the setup skill on top of the default system prompt.
 */
export function buildClaudeArgs(objective: string, skillBody: string): string[] {
  return getProviderModule("claude").setupSession.buildInteractiveArgs({ objective, skillBody });
}

/**
 * Opencode: `--prompt` seeds the first message; `--agent` references the
 * setup agent by its frontmatter name. The explicit project argument keeps
 * git-linked experiment worktrees from resolving back to the main worktree.
 */
export function buildOpencodeArgs(objective: string, worktreePath?: string): string[] {
  return getProviderModule("opencode").setupSession.buildInteractiveArgs({
    objective,
    skillBody: "",
    worktreePath,
  });
}

/**
 * Codex interactive exposes neither `--agent` nor `--system-prompt`, so we
 * prepend the skill body to the objective as a single positional prompt.
 */
export function buildCodexArgs(objective: string, skillBody: string): string[] {
  return getProviderModule("codex").setupSession.buildInteractiveArgs({ objective, skillBody });
}

/**
 * Pi: pin Anthropic explicitly (Pi defaults to google per Exp 42), append
 * the setup skill on top of Pi's default coding-assistant prompt with
 * `--append-system-prompt`, and pass the objective as the positional
 * initial-prompt slot.
 */
export function buildPiArgs(objective: string, skillBody: string): string[] {
  return getProviderModule("pi").setupSession.buildInteractiveArgs({ objective, skillBody });
}

export interface SetupSessionResult {
  readonly exitCode: number;
  readonly provider: ProviderName;
  /** Captured from provider's exit output, if emitted. Null when absent. */
  readonly resumeHint: string | null;
  readonly sessionId: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
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
  const providerModule = getProviderModule(provider);
  const argv = providerModule.setupSession.buildInteractiveArgs({
    objective,
    skillBody,
    worktreePath,
  });
  const proc = spawn(argv, {
    cwd: worktreePath,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;
  return { exitCode, provider, resumeHint: null, sessionId: null };
}

/**
 * Run the setup agent non-interactively through the selected provider's setup
 * capability.
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
  readonly runProcess?: ProcessRunner;
}

function buildOneshotPrompt(skillBody: string, objective: string): string {
  return `${skillBody}\n\n## Objective\n\n${objective}\n\n## Task\n\nCreate the setup artifacts in the current working directory. You do NOT have a user to ask clarifying questions — make your best judgment from the objective and the repo. Run \`./autoresearch.sh\` yourself to verify the METRIC line emits correctly before you finish.`;
}

export async function runSetupOneshot(
  worktreePath: string,
  objective: string,
  provider: ProviderName,
  skillBody: string,
  deps?: SetupOneshotDeps,
): Promise<SetupSessionResult> {
  const result = await getProviderModule(provider).setupSession.runOneshot(
    { worktreePath, prompt: buildOneshotPrompt(skillBody, objective) },
    { processRunner: deps?.runProcess ?? runProcess },
  );
  return {
    exitCode: result.exitCode,
    provider: result.provider,
    resumeHint: null,
    sessionId: null,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}
