/**
 * CLI handler for `shaka reload` command.
 *
 * Re-discovers hooks from system/hooks/ and customizations/hooks/,
 * then regenerates provider configurations (settings.json, opencode plugin).
 * Also reinstalls agents and skills symlinks.
 *
 * Use after adding, removing, or modifying hook files.
 */

import { Command } from "commander";
import {
  ensureConfigComplete,
  isPermissionsManaged,
  loadConfig,
  resolveShakaHome,
} from "../domain/config";
import { createProvider } from "../providers/registry";
import type { ProviderName } from "../providers/types";

async function reloadProviders(shakaHome: string): Promise<void> {
  // Backfill missing config fields (e.g., permissions added in v0.4.0)
  await ensureConfigComplete(shakaHome);

  const config = await loadConfig(shakaHome);
  if (!config) {
    console.error("ERROR: No config found. Run `shaka init` first.");
    process.exit(1);
  }

  const providers: ProviderName[] = [];
  if (config.providers.claude.enabled) providers.push("claude");
  if (config.providers.opencode.enabled) providers.push("opencode");

  if (providers.length === 0) {
    console.error("ERROR: No providers enabled in config. Run `shaka init` first.");
    process.exit(1);
  }

  console.log("Reloading configuration...\n");

  const permissionMode = isPermissionsManaged(config) ? undefined : "skip";

  for (const providerName of providers) {
    const provider = createProvider(providerName);
    const result = await provider.install({ shakaHome, permissionMode });
    if (!result.ok) {
      console.error(`  ✗ Failed to reload ${providerName}: ${result.error.message}`);
    } else {
      console.log(`  ✓ Reloaded ${providerName} configuration`);
    }
  }

  console.log("\nDone. Restart your provider session to pick up changes.");
}

export function createReloadCommand(): Command {
  return new Command("reload")
    .description("Reload provider configuration (hooks, agents, skills)")
    .action(async () => {
      const shakaHome = resolveShakaHome({
        SHAKA_HOME: process.env.SHAKA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      });

      await reloadProviders(shakaHome);
    });
}
