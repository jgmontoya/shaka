/**
 * Provider error detection for Pi runs.
 *
 * Pi exits 0 even when the provider returns a 4xx/5xx error (Exp 43); the
 * status line is printed to stdout instead. `runPi` and `callPiCLI` both call
 * this helper to surface those failures as runner errors.
 *
 * Two shapes observed empirically:
 *   401 {"type":"error","error":{"type":"authentication_error", ...}}   ← anthropic
 *   400 {"detail":"...model is not supported..."}                       ← openai-codex
 */

// Constrained to 4xx/5xx so a model that narrates an HTTP status (e.g.,
// `200 {"detail":"ok"}`) doesn't get flagged as a provider failure.
// Body is matched but not captured — `match[0]` carries the full line for
// callers that want to surface it; `match[1]` is the only meaningful capture.
const PI_PROVIDER_ERROR_LINE = /^([45]\d{2})\s+(?:\{.*"(?:type|detail)":.*\})\s*$/m;

export interface ProviderErrorMatch {
  /** HTTP status code parsed from the line prefix. */
  code: number;
  /** Verbatim line so callers can surface it to the user. */
  body: string;
}

export function detectProviderError(stdout: string): ProviderErrorMatch | null {
  const match = stdout.match(PI_PROVIDER_ERROR_LINE);
  if (!match) return null;
  const code = Number(match[1]);
  const body = match[0];
  return { code, body };
}
