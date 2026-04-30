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
