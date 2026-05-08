/**
 * Default model + provider for Pi-backed inference and agent steps.
 *
 * Pi defaults to google (Exp 42); Shaka pins Anthropic so behavior is
 * deterministic across user environments. This single source is consumed
 * by every code path that spawns Pi:
 *
 *   - `src/inference.ts:callPiCLI` (when no `options.model` is set)
 *   - `src/domain/agent-execution.ts:runPi`
 *   - `src/services/setup-session.ts:buildPiArgs`
 *
 * Three hardcoded copies of the same literal was the smell that prompted
 * the extraction — not a config-knob ask.
 */

export const DEFAULT_PI_PROVIDER = "anthropic";
export const DEFAULT_PI_MODEL = `${DEFAULT_PI_PROVIDER}/claude-sonnet-4-5`;

/**
 * Map a model identifier to Pi's `--provider` value. Pi's provider names
 * don't always match the model-namespace prefix: `openai/*` models are served
 * by Pi's `openai-codex` provider (verified Exp 48).
 *
 * Bare names and unknown namespaces return undefined so callers can fail fast
 * instead of sending contradictory `--provider`/`--model` flags.
 */
export function piProviderForModel(model: string): string | undefined {
  if (model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("openai-codex/")) return "openai-codex";
  if (model.startsWith("openai/")) return "openai-codex";
  if (model.startsWith("google/")) return "google";
  return undefined;
}
