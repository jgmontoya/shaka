/**
 * Provider registry and factory.
 * Central place to get provider modules and configurers.
 */

import type { ShakaConfig } from "../domain/config";
import type { DetectedProviders } from "../services/provider-detection";
import { claudeProvider } from "./claude/provider";
import { codexProvider } from "./codex/provider";
import { opencodeProvider } from "./opencode/provider";
import { piProvider } from "./pi/provider";
import type { ProviderConfigurer, ProviderModule, ProviderName } from "./types";

const PROVIDER_MODULE_BY_NAME = {
  claude: claudeProvider,
  opencode: opencodeProvider,
  codex: codexProvider,
  pi: piProvider,
} satisfies Record<ProviderName, ProviderModule>;

const PROVIDER_MODULES = Object.values(PROVIDER_MODULE_BY_NAME) satisfies ProviderModule[];

export function createProvider(name: ProviderName): ProviderConfigurer {
  return getProviderModule(name).createConfigurer();
}

export function getAllProviders(): ProviderConfigurer[] {
  return getProviderModules().map((provider) => provider.createConfigurer());
}

/** Return all registered provider names without constructing configurers. */
export function getProviderNames(): ProviderName[] {
  return getProviderModules().map((provider) => provider.metadata.name);
}

/** Return the registered provider names enabled in config, in priority order. */
export function getEnabledProviderNames(config: ShakaConfig): ProviderName[] {
  return getProviderNames().filter((name) => config.providers[name]?.enabled);
}

export function getProviderModule(name: ProviderName): ProviderModule {
  return PROVIDER_MODULE_BY_NAME[name];
}

export function getProviderModules(): ProviderModule[] {
  return [...PROVIDER_MODULES].sort((a, b) => a.metadata.priority - b.metadata.priority);
}

export function getInstalledProviderModules(detected: DetectedProviders): ProviderModule[] {
  return getProviderModules().filter((provider) => detected[provider.metadata.name]);
}
