/**
 * Provider detection service.
 * Detects which AI provider CLIs are installed on the system.
 *
 * This is the shared detection logic used by both:
 * - shaka core (CLI commands)
 * - defaults/ templates (via import from 'shaka')
 */

import { getProviderNames } from "../providers/registry";
import type { ProviderName } from "../providers/types";

// Re-export from the canonical definition in types.ts
export type { ProviderName } from "../providers/types";

export type DetectedProviders = Record<ProviderName, boolean>;

// Cache detection results within a session
let cachedDetection: DetectedProviders | null = null;

/**
 * Check if a specific provider CLI is installed.
 */
export function isProviderInstalled(provider: ProviderName): boolean {
  return Bun.which(provider) !== null;
}

/**
 * Detect all installed provider CLIs.
 * Results are cached for the session.
 */
export function detectInstalledProviders(): DetectedProviders {
  if (cachedDetection) {
    return cachedDetection;
  }

  const result = {} as DetectedProviders;
  for (const name of getProviderNames()) {
    result[name] = isProviderInstalled(name);
  }
  cachedDetection = result;
  return cachedDetection;
}

/**
 * Clear the detection cache.
 * Useful for testing or when providers may have been installed/uninstalled.
 */
export function clearDetectionCache(): void {
  cachedDetection = null;
}
