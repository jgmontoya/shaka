/**
 * Per-provider argv builders for the full-auto autoresearch setup session,
 * plus the `runSetupInteractive` orchestrator that dispatches to the right
 * builder and hands stdio to the provider's native TUI via `Bun.spawn`.
 *
 * Each builder returns the argv passed to `Bun.spawn`. Pure functions; no
 * side effects. Empirically verified against claude v2.1.116, opencode
 * 1.14.19, and codex v0.122.0 in Experiment 39.
 */

import type { ProviderName } from "../providers/types";

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
        : buildCodexArgs(objective, skillBody);
  const proc = spawn(argv, {
    cwd: worktreePath,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await proc.exited;
  return { exitCode, provider, resumeHint: null, sessionId: null };
}
