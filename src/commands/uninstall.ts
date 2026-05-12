/**
 * CLI handler for `shaka uninstall` command.
 *
 * Removes Shaka hooks from providers and cleans up the shaka home directory.
 * Prompts before deleting user-owned data (user/, customizations/, memory/).
 */

import { createInterface } from "node:readline";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import { createProvider, getProviderNames } from "../providers/registry";
import type { ProviderName } from "../providers/types";
import type { UninstallResult } from "../services/uninstall-service";
import { UninstallService } from "../services/uninstall-service";

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function promptDeleteUserData(
  options: { keepData?: boolean; deleteData?: boolean },
  shakaHome: string,
): Promise<boolean> {
  if (options.deleteData) return true;
  if (options.keepData) return false;

  console.log("Shaka will remove hooks and framework files.");
  console.log("Your personal data lives in:");
  console.log(`  ${shakaHome}/user/`);
  console.log(`  ${shakaHome}/customizations/`);
  console.log(`  ${shakaHome}/memory/\n`);

  const answer = await confirm("Delete your personal data too? [y/N] ");
  console.log();
  return answer;
}

/**
 * `scope` is the set of providers the user explicitly asked us to touch.
 * `null` means full uninstall — every detected provider was a target, so
 * a detected-but-not-uninstalled status is a real failure. With a scope,
 * detected providers outside it were intentionally skipped, not failed.
 */
export function logProviderStatus(
  providers: UninstallResult["providers"],
  scope: ReadonlySet<ProviderName> | null,
): void {
  console.log("Provider hooks:");
  for (const name of getProviderNames()) {
    const provider = createProvider(name);
    const p = providers[name];
    if (!p.detected) {
      console.log(`  ${provider.label}: not installed`);
      continue;
    }
    if (p.uninstalled) {
      console.log(`  ${provider.label}: ✓ removed`);
      continue;
    }
    const inScope = scope === null || scope.has(name);
    console.log(`  ${provider.label}: ${inScope ? "✗ failed" : "skipped (not in scope)"}`);
  }
}

function logResult(
  result: UninstallResult,
  deleteUserData: boolean,
  shakaHome: string,
  scope: ReadonlySet<ProviderName> | null,
): void {
  logProviderStatus(result.providers, scope);

  if (result.removed.length > 0) {
    console.log("\nRemoved:");
    for (const item of result.removed) {
      console.log(`  ${item}`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\nWarnings:");
    for (const e of result.errors) {
      console.log(`  ⚠ ${e}`);
    }
  }

  if (scope !== null) {
    // Scoped uninstall: only the named provider's integration was removed.
    // The framework, system/ symlink, and user data are intact, so the
    // "rm -rf shakaHome" hint would be actively dangerous.
    console.log("\n✅ Provider integration removed.");
    return;
  }

  console.log("\n✅ Shaka uninstalled.");

  if (!deleteUserData) {
    console.log(`   Your data is still at ${shakaHome}/`);
    const removeCmd =
      process.platform === "win32" ? `rmdir /s /q "${shakaHome}"` : `rm -rf ${shakaHome}`;
    console.log(`   To remove it: ${removeCmd}`);
  }
}

export function createUninstallCommand(): Command {
  return new Command("uninstall")
    .description("Remove Shaka hooks and configuration")
    .option("--claude", "Uninstall only the Claude Code integration")
    .option("--opencode", "Uninstall only the opencode integration")
    .option("--codex", "Uninstall only the Codex integration")
    .option("--pi", "Uninstall only the Pi integration")
    .option("--keep-data", "Skip prompt and keep user/, customizations/, memory/")
    .option("--delete-data", "Skip prompt and delete user/, customizations/, memory/")
    .action(async (options) => {
      const shakaHome = resolveShakaHome({
        SHAKA_HOME: process.env.SHAKA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      });

      const service = new UninstallService({ shakaHome });
      const only = getProviderNames().filter((name) => options[name]);

      console.log(
        only.length > 0
          ? `Uninstalling Shaka from: ${only.join(", ")}\n`
          : "Uninstalling Shaka...\n",
      );

      // Per-provider scope skips the interactive user-data prompt — the
      // user is not making a whole-install decision. `--delete-data` is
      // forwarded as-is so the service-layer guard rejects the
      // contradictory combination instead of silently ignoring it.
      const deleteUserData =
        only.length > 0
          ? options.deleteData === true
          : await promptDeleteUserData(options, shakaHome);
      const result = await service.uninstall({
        deleteUserData,
        ...(only.length > 0 ? { only } : {}),
      });

      if (!result.ok) {
        console.error(`ERROR: ${result.error.message}`);
        process.exit(1);
      }

      const scope = only.length > 0 ? new Set(only) : null;
      logResult(result.value, deleteUserData, shakaHome, scope);
    });
}
