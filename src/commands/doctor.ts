/**
 * CLI handler for `shaka doctor` command.
 * Checks system health, installation status, and config-vs-reality alignment.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import {
  type ShakaConfig,
  ensureConfigComplete,
  loadConfig,
  resolveShakaHome,
} from "../domain/config";
import { loadManifest } from "../domain/skills-manifest";
import { getAllProviders } from "../providers/registry";
import type { InstallationStatus, ProviderConfigurer, ProviderName } from "../providers/types";
import { measureContext } from "./context-measurement";
import { printOpencodeSummarizationHint } from "./hints";

async function checkShakaHome(shakaHome: string): Promise<boolean> {
  console.log(`Shaka home: ${shakaHome}`);

  const configFile = Bun.file(join(shakaHome, "config.json"));
  if (await configFile.exists()) {
    console.log("  ✓ config.json exists");
    return false;
  }
  console.log("  ✗ config.json not found");
  return true;
}

function formatStatus(ok: boolean, issue?: string): string {
  if (ok) return "✓ yes";
  return issue ? `✗ no (${issue})` : "✗ no";
}

function logProviderStatus(
  provider: ProviderConfigurer,
  cliInstalled: boolean,
  status: InstallationStatus,
  enabled: boolean,
): boolean {
  let hasIssues = false;
  console.log(`\n  ${provider.name}:`);
  console.log(`    CLI installed: ${cliInstalled ? "✓ yes" : "✗ no"}`);
  console.log(`    Enabled:       ${enabled ? "✓ yes" : "– no"}`);

  if (cliInstalled && enabled) {
    console.log(`    Hooks:         ${formatStatus(status.hooks.ok, status.hooks.issue)}`);
    console.log(`    Agents:        ${formatStatus(status.agents.ok, status.agents.issue)}`);
    console.log(`    Skills:        ${formatStatus(status.skills.ok, status.skills.issue)}`);
    console.log(
      `    Installed:     ${formatStatus(status.installedSkills.ok, status.installedSkills.issue)}`,
    );
    console.log(`    Commands:      ${formatStatus(status.commands.ok, status.commands.issue)}`);

    if (!isFullyInstalled(status)) {
      hasIssues = true;
    }
  } else if (cliInstalled && !enabled) {
    console.log("    Hooks:         – skipped (not enabled)");
    console.log("    Agents:        – skipped (not enabled)");
    console.log("    Skills:        – skipped (not enabled)");
    console.log("    Installed:     – skipped (not enabled)");
    console.log("    Commands:      – skipped (not enabled)");
  }
  return hasIssues;
}

/** Check if all installation components are ok. */
function isFullyInstalled(status: InstallationStatus): boolean {
  return (
    status.hooks.ok &&
    status.agents.ok &&
    status.skills.ok &&
    status.installedSkills.ok &&
    status.commands.ok
  );
}

interface ProviderMismatch {
  name: ProviderName;
  configEnabled: boolean;
  actuallyInstalled: boolean;
}

/** Cached provider status from a single check pass. */
interface ProviderCheckResult {
  provider: ProviderConfigurer;
  cliInstalled: boolean;
  status: InstallationStatus;
}

/**
 * Collect installation status for all providers in a single pass.
 * Returns cached results to avoid duplicate checkInstallation calls.
 */
async function collectProviderStatuses(shakaHome: string): Promise<ProviderCheckResult[]> {
  const providers = getAllProviders();
  const results: ProviderCheckResult[] = [];

  for (const provider of providers) {
    const cliInstalled = provider.isInstalled();
    const status = await provider.checkInstallation({ shakaHome });
    results.push({ provider, cliInstalled, status });
  }

  return results;
}

/**
 * Compare config.json provider flags against actual installation.
 * Uses pre-collected statuses to avoid duplicate calls.
 */
function findConfigMismatches(
  config: ShakaConfig | null,
  statuses: ProviderCheckResult[],
): ProviderMismatch[] {
  if (!config) return [];

  const mismatches: ProviderMismatch[] = [];

  for (const { provider, cliInstalled, status } of statuses) {
    const configEnabled = config.providers[provider.name].enabled;
    const actuallyInstalled = cliInstalled && isFullyInstalled(status);

    if (configEnabled !== actuallyInstalled) {
      mismatches.push({ name: provider.name, configEnabled, actuallyInstalled });
    }
  }

  return mismatches;
}

function logConfigAlignment(mismatches: ProviderMismatch[]): boolean {
  console.log("\nConfig alignment:");

  if (mismatches.length === 0) {
    console.log("  ✓ config.json matches installation state");
    return false;
  }

  for (const m of mismatches) {
    if (m.actuallyInstalled && !m.configEnabled) {
      console.log(`  ✗ ${m.name}: installed but config says disabled`);
    } else if (!m.actuallyInstalled && m.configEnabled) {
      console.log(`  ✗ ${m.name}: config says enabled but not fully installed`);
    }
  }
  console.log("  Run `shaka doctor --fix` to update config.json to match.");
  return true;
}

async function fixConfigAlignment(
  shakaHome: string,
  mismatches: ProviderMismatch[],
): Promise<void> {
  const configPath = join(shakaHome, "config.json");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    console.log("\n  ✗ Cannot fix: config.json not found. Run `shaka init` first.");
    return;
  }

  const config = await file.json();

  for (const m of mismatches) {
    config.providers[m.name].enabled = m.actuallyInstalled;
    console.log(`\n  ✓ Set ${m.name}.enabled = ${m.actuallyInstalled}`);
  }

  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log("  ✓ config.json updated");
}

/**
 * Log provider statuses and return whether any issues were found.
 * Uses pre-collected statuses to avoid duplicate calls.
 */
function logProviderStatuses(config: ShakaConfig | null, statuses: ProviderCheckResult[]): boolean {
  let hasIssues = false;

  for (const { provider, cliInstalled, status } of statuses) {
    const enabled = config?.providers[provider.name].enabled ?? false;
    const providerHasIssues = logProviderStatus(provider, cliInstalled, status, enabled);
    hasIssues = hasIssues || providerHasIssues;
  }

  return hasIssues;
}

async function recheckAfterFix(shakaHome: string): Promise<boolean> {
  const config = await loadConfig(shakaHome);
  let hasIssues = await checkShakaHome(shakaHome);
  const providers = getAllProviders();

  for (const provider of providers) {
    const cliInstalled = provider.isInstalled();
    const status = await provider.checkInstallation({ shakaHome });
    const enabled = config?.providers[provider.name].enabled ?? false;
    if (enabled && cliInstalled && !isFullyInstalled(status)) {
      hasIssues = true;
    }
  }

  return hasIssues;
}

async function checkInstalledSkills(shakaHome: string): Promise<boolean> {
  console.log("\nInstalled skills:");

  const manifest = await loadManifest(shakaHome);
  if (!manifest.ok) {
    console.log(`  ✗ ${manifest.error.message}`);
    return true;
  }

  const names = Object.keys(manifest.value.skills);
  if (names.length === 0) {
    console.log("  (none)");
    return false;
  }

  let hasIssues = false;
  const skillsDir = join(shakaHome, "skills");

  for (const name of names) {
    const dirExists = await dirExistsOnDisk(join(skillsDir, name));
    if (dirExists) {
      const version = manifest.value.skills[name]?.version ?? "unknown";
      const display = version.length > 12 ? version.slice(0, 7) : version;
      console.log(`  ✓ ${name} (${display})`);
    } else {
      console.log(`  ✗ ${name} — missing from disk (orphaned manifest entry)`);
      hasIssues = true;
    }
  }

  return hasIssues;
}

async function dirExistsOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function printSummary(hasIssues: boolean): void {
  console.log(`\n${"─".repeat(40)}`);
  if (hasIssues) {
    console.log("⚠️  Some issues found. Run `shaka init` to fix.");
    process.exit(1);
  } else {
    console.log("✅ All systems operational.");
  }
}

async function checkIncompleteConfig(shakaHome: string): Promise<boolean> {
  const configFile = Bun.file(join(shakaHome, "config.json"));
  if (!(await configFile.exists())) return false;

  // Read raw JSON to detect missing fields without going through validateConfig
  const raw = (await configFile.json()) as Record<string, unknown>;
  if (raw.permissions === undefined) {
    console.log("  ✗ config.json is incomplete (missing permissions field)");
    console.log("    Run `shaka doctor --fix` to backfill missing fields.");
    return true;
  }

  return false;
}

async function runDoctor(shakaHome: string, options: { fix?: boolean }): Promise<void> {
  let hasIssues = await checkShakaHome(shakaHome);
  let fixedSomething = false;

  // Backfill missing config fields before loading (e.g., permissions added in v0.4.0)
  if (options.fix) {
    const configBackfilled = await ensureConfigComplete(shakaHome);
    if (configBackfilled) {
      console.log("  ✓ Backfilled missing config fields (permissions)");
      fixedSomething = true;
    }
  }

  const config = await loadConfig(shakaHome);

  // Detect incomplete config when not fixing
  if (!config && !hasIssues) {
    const incomplete = await checkIncompleteConfig(shakaHome);
    hasIssues = hasIssues || incomplete;
  }

  // Collect all provider statuses once (avoids duplicate checkInstallation calls)
  const statuses = await collectProviderStatuses(shakaHome);

  console.log("\nProvider status:");
  const providerIssues = logProviderStatuses(config, statuses);
  hasIssues = hasIssues || providerIssues;

  const mismatches = findConfigMismatches(config, statuses);
  const alignmentIssues = logConfigAlignment(mismatches);
  hasIssues = hasIssues || alignmentIssues;

  if (options.fix && mismatches.length > 0) {
    await fixConfigAlignment(shakaHome, mismatches);
    fixedSomething = true;
    hasIssues = await recheckAfterFix(shakaHome);
  }

  if (fixedSomething) {
    console.log("\n  Run `shaka reload` to apply changes to provider configurations.");
  }

  const skillIssues = await checkInstalledSkills(shakaHome);
  hasIssues = hasIssues || skillIssues;

  printSummary(hasIssues);
  await printOpencodeSummarizationHint(shakaHome);
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("Check Shaka installation health")
    .option("--fix", "Auto-fix config mismatches")
    .option("--context", "Measure context injection overhead")
    .action(async (options) => {
      if (options.context) {
        await measureContext();
        return;
      }

      console.log("Shaka Doctor\n");
      console.log("Checking system health...\n");

      const shakaHome = resolveShakaHome({
        SHAKA_HOME: process.env.SHAKA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      });

      await runDoctor(shakaHome, options);
    });
}
