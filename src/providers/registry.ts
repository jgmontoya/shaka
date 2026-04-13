/**
 * Provider registry and factory.
 * Central place to get provider configurers.
 */

import { ClaudeProviderConfigurer } from "./claude/configurer";
import { CodexProviderConfigurer } from "./codex/configurer";
import { OpencodeProviderConfigurer } from "./opencode/configurer";
import type { ProviderConfigurer, ProviderName } from "./types";

export function createProvider(name: ProviderName): ProviderConfigurer {
  switch (name) {
    case "claude":
      return new ClaudeProviderConfigurer();
    case "opencode":
      return new OpencodeProviderConfigurer();
    case "codex":
      return new CodexProviderConfigurer();
  }
}

export function getAllProviders(): ProviderConfigurer[] {
  return [
    new ClaudeProviderConfigurer(),
    new OpencodeProviderConfigurer(),
    new CodexProviderConfigurer(),
  ];
}

/** Return all registered provider names without constructing configurers. */
export function getProviderNames(): ProviderName[] {
  return ["claude", "opencode", "codex"];
}
