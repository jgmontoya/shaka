/**
 * Credential check for Pi.
 *
 * Pi authenticates via three paths:
 *   1. `pi /login` — TUI OAuth flow that writes `~/.pi/agent/auth.json`.
 *   2. `ANTHROPIC_API_KEY` env var.
 *   3. `ANTHROPIC_OAUTH_TOKEN` env var.
 *
 * Headless Pi (`pi -p`) silently fails-fast when all three are absent (Exp 43);
 * `shaka doctor` surfaces this as an actionable warning so first-run users
 * aren't left guessing why `--provider pi` exits nonzero.
 *
 * Pure function — caller injects env + filesystem state so the helper itself
 * has no side effects and tests don't need to touch real env vars.
 */

export interface PiCredentialInputs {
  /** Process env subset; only `ANTHROPIC_API_KEY` and `ANTHROPIC_OAUTH_TOKEN` are read. */
  env: { ANTHROPIC_API_KEY?: string; ANTHROPIC_OAUTH_TOKEN?: string };
  /** Whether `~/.pi/agent/auth.json` (or the equivalent under `PI_CODING_AGENT_DIR`) exists. */
  hasAuthFile: boolean;
}

export interface PiCredentialStatus {
  ok: boolean;
  issue?: string;
}

export function checkPiCredentials(inputs: PiCredentialInputs): PiCredentialStatus {
  if (inputs.hasAuthFile) return { ok: true };
  if (inputs.env.ANTHROPIC_API_KEY?.trim()) return { ok: true };
  if (inputs.env.ANTHROPIC_OAUTH_TOKEN?.trim()) return { ok: true };
  return {
    ok: false,
    issue:
      "no credentials found — set ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN), or run `pi /login`",
  };
}
