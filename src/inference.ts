/**
 * Provider-agnostic inference tool
 * @version 1.2.0
 *
 * Uses CLI tools that handle their own authentication:
 * 1. Claude CLI (claude -p) — if installed
 * 2. OpenCode CLI (opencode run) — if installed, handles local models too
 * 3. Codex CLI (codex exec) — if installed
 * 4. Pi CLI (pi -p) — if installed
 *
 * No API keys needed — CLIs manage auth. Install one and inference works.
 */

import { getSummarizationModel } from "./domain/config";
import { runProcess } from "./platform/process-runner";
import {
  getInstalledProviderModules,
  getProviderModule,
  getProviderNames,
} from "./providers/registry";
import type { ProviderName } from "./providers/types";
import { type DetectedProviders, detectInstalledProviders } from "./services/provider-detection";

export interface InferenceOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  /**
   * Optional provider hint for session-context callers (session-end worker,
   * rollups, maintenance, knowledge compilation). When set and the provider
   * is installed, it's dispatched FIRST — other installed providers remain
   * as fallbacks. This matters because the provider that originated a
   * session is the authoritative dispatch target for its own summarization
   * work, regardless of what's first in the installed-priority list.
   * Omit for generic, session-free callers (compile, review, format-reminder).
   */
  provider?: ProviderName;
  timeout?: number;
  expectJson?: boolean;
}

export interface InferenceResult {
  success: boolean;
  text?: string;
  parsed?: unknown;
  error?: string;
  provider?: string;
}

export interface InferenceAttempt {
  readonly provider: ProviderName;
  readonly model: string | undefined;
}

/**
 * Compute the ordered list of (provider, model) attempts for an inference call.
 *
 * Pure function — takes `detected` as an injected parameter so the resolution
 * logic is trivially testable without mocking CLI probing. Model-resolution
 * belongs here (not in callers like format-reminder) because this is the only
 * layer that knows which backend inference() will actually dispatch to —
 * the hook-host provider and the dispatch-winner can differ when multiple
 * CLIs are installed.
 *
 * Semantics:
 *   - Iterate providers in registry priority order.
 *   - For each installed provider, emit one attempt.
 *   - If the caller passes an explicit `options.model`, it wins for every
 *     attempt — config is ignored entirely.
 *   - Otherwise, each attempt's model comes from
 *     getSummarizationModel(<provider>), which honors the per-provider
 *     config.json `summarization_model` and maps "auto" to undefined.
 */
export async function resolveInferenceAttempts(
  options: InferenceOptions,
  detected: DetectedProviders,
): Promise<InferenceAttempt[]> {
  const defaultOrder = getProviderNames();
  // If the caller hints a provider AND it's installed, it jumps to the head
  // of the list; the default order fills the remaining fallback slots.
  const hint = options.provider;
  const ordered: ProviderName[] =
    hint && detected[hint] ? [hint, ...defaultOrder.filter((p) => p !== hint)] : defaultOrder;

  const attempts: InferenceAttempt[] = [];
  for (const provider of ordered) {
    if (!detected[provider]) continue;
    const model =
      options.model !== undefined ? options.model : await getSummarizationModel(provider);
    attempts.push({ provider, model });
  }
  return attempts;
}

export { parseResponse } from "./providers/inference-response";
export { parseOpencodeJsonStream } from "./providers/opencode/inference";

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run inference using available CLI tools.
 *
 * Provider priority comes from the provider registry. Provider-specific CLI
 * argv, environment guards, output parsing, and cleanup live in provider
 * inference capabilities.
 *
 * All handle their own authentication — no API keys needed.
 *
 * Model resolution: if the caller omits `options.model`, each attempt uses
 * the per-provider `summarization_model` from config (via
 * resolveInferenceAttempts). This keeps callers like format-reminder,
 * compile, and review zero-config — they just call inference() and get
 * the right model for whichever backend wins the dispatch race.
 */
export async function inference(
  options: InferenceOptions,
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<InferenceResult> {
  const attempts = await resolveInferenceAttempts(options, detected);
  let lastFailure: InferenceResult | null = null;

  for (const attempt of attempts) {
    const resolvedOptions = { ...options, model: attempt.model };
    const provider = getProviderModule(attempt.provider);
    let result: InferenceResult;
    try {
      result = await provider.inference.run(resolvedOptions, { processRunner: runProcess });
    } catch (error) {
      result = {
        success: false,
        provider: attempt.provider,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.success) return result;
    lastFailure = result;
  }

  return (
    lastFailure ?? {
      success: false,
      error: `No inference provider available. Install ${getProviderNames().join(", ")} CLI.`,
    }
  );
}

/**
 * Check if any inference CLI is available.
 */
export async function hasInferenceProvider(
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<boolean> {
  return getInstalledProviderModules(detected).length > 0;
}
