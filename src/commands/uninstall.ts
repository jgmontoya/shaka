/**
 * CLI handler for `shaka uninstall` command.
 *
 * Removes Shaka hooks from providers and cleans up the shaka home directory.
 * Prompts before deleting user-owned data (user/, customizations/, memory/).
 */

import { createInterface } from "node:readline";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import { createProvider } from "../providers/registry";
import { getProviderNames } from "../providers/registry";
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

function logProviderStatus(providers: UninstallResult["providers"]): void {
  console.log("Provider hooks:");
  for (const name of getProviderNames()) {
    const provider = createProvider(name);
    const p = providers[name];
    const status = p.detected ? (p.uninstalled ? "✓ removed" : "✗ failed") : "not installed";
    console.log(`  ${provider.label}: ${status}`);
  }
}

function logResult(result: UninstallResult, deleteUserData: boolean, shakaHome: string): void {
  logProviderStatus(result.providers);

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

      console.log("Uninstalling Shaka...\n");

      const deleteUserData = await promptDeleteUserData(options, shakaHome);
      const result = await service.uninstall({ deleteUserData });

      if (!result.ok) {
        console.error(`ERROR: ${result.error.message}`);
        process.exit(1);
      }

      logResult(result.value, deleteUserData, shakaHome);
    });
}
