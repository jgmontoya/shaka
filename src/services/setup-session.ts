/**
 * Per-provider argv builders for the full-auto autoresearch setup session.
 *
 * Each function returns the argv passed to `Bun.spawn` when launching the
 * provider CLI in interactive mode (`stdio: "inherit"`). Pure functions; no
 * side effects. Empirically verified against claude v2.1.116, opencode
 * 1.14.19, and codex v0.122.0 in Experiment 39.
 */

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
