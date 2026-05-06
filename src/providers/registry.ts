/**
 * Provider registry and factory.
 * Central place to get provider configurers.
 */

import { ClaudeProviderConfigurer } from "./claude/configurer";
import { CodexProviderConfigurer } from "./codex/configurer";
import { OpencodeProviderConfigurer } from "./opencode/configurer";
import { PiProviderConfigurer } from "./pi/configurer";
import type { ProviderConfigurer, ProviderName } from "./types";

const PROVIDERS = {
  claude: () => new ClaudeProviderConfigurer(),
  opencode: () => new OpencodeProviderConfigurer(),
  codex: () => new CodexProviderConfigurer(),
  pi: () => new PiProviderConfigurer(),
} satisfies Record<ProviderName, () => ProviderConfigurer>;

export function createProvider(name: ProviderName): ProviderConfigurer {
  return PROVIDERS[name]();
}

export function getAllProviders(): ProviderConfigurer[] {
  return getProviderNames().map((name) => createProvider(name));
}

/** Return all registered provider names without constructing configurers. */
export function getProviderNames(): ProviderName[] {
  return Object.keys(PROVIDERS) as ProviderName[];
}
