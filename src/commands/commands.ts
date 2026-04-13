/**
 * CLI handler for `shaka commands` subcommand.
 * Manage slash commands: list, new, disable, enable.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { loadConfig, resolveShakaHome } from "../domain/config";
import {
  type DiscoveredCommand,
  MAX_NAME_LENGTH,
  NAME_PATTERN,
  discoverCommands,
} from "../providers/command-discovery";
import { type CommandManifest, readManifest } from "../providers/command-manifest";
import { installCommandsForProviders } from "../providers/command-orchestrator";
import { getAllProviders } from "../providers/registry";
import type { ProviderConfigurer } from "../providers/types";

function getShakaHome(): string {
  return resolveShakaHome({
    SHAKA_HOME: process.env.SHAKA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  });
}

interface CommandRow {
  name: string;
  source: string;
  scope: string;
  status: string;
}

function resolveCommandStatus(
  cmd: DiscoveredCommand,
  manifest: CommandManifest,
  disabledSet: Set<string>,
): string {
  if (disabledSet.has(cmd.name)) return "disabled";
  const isInstalled = cmd.cwd
    ? cmd.cwd.some((p) => manifest.scoped[p]?.includes(cmd.name))
    : manifest.global.includes(cmd.name);
  return isInstalled ? "installed" : "pending (run shaka reload)";
}

function collectStaleEntries(
  manifest: CommandManifest,
  discoveredNames: Set<string>,
): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const name of manifest.global) {
    if (!discoveredNames.has(name)) {
      rows.push({ name, source: "—", scope: "global", status: "stale (run shaka reload)" });
    }
  }
  for (const [cwdPath, names] of Object.entries(manifest.scoped)) {
    for (const name of names) {
      if (!discoveredNames.has(name)) {
        rows.push({ name, source: "—", scope: cwdPath, status: "stale (run shaka reload)" });
      }
    }
  }
  return rows;
}

function buildCommandRows(
  commands: DiscoveredCommand[],
  manifest: CommandManifest,
  disabledSet: Set<string>,
): CommandRow[] {
  const rows: CommandRow[] = [];

  for (const cmd of commands) {
    const source = cmd.sourcePath.replace(/\\/g, "/").includes("/customizations/")
      ? "customizations"
      : "system";
    const scope = cmd.cwd ? cmd.cwd.join(", ") : "global";
    rows.push({
      name: cmd.name,
      source,
      scope,
      status: resolveCommandStatus(cmd, manifest, disabledSet),
    });
  }

  const discoveredNames = new Set(commands.map((c) => c.name));
  rows.push(...collectStaleEntries(manifest, discoveredNames));

  return rows;
}

function printCommandTable(rows: CommandRow[]): void {
  const nameWidth = Math.max(8, ...rows.map((r) => r.name.length));
  const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));
  const scopeWidth = Math.max(5, ...rows.map((r) => r.scope.length));

  console.log(
    [
      "COMMAND".padEnd(nameWidth),
      "SOURCE".padEnd(sourceWidth),
      "SCOPE".padEnd(scopeWidth),
      "STATUS",
    ].join("  "),
  );

  for (const row of rows) {
    console.log(
      [
        row.name.padEnd(nameWidth),
        row.source.padEnd(sourceWidth),
        row.scope.padEnd(scopeWidth),
        row.status,
      ].join("  "),
    );
  }
}

async function listCommands(): Promise<void> {
  const shakaHome = getShakaHome();
  const config = await loadConfig(shakaHome);
  const disabledSet = new Set(config?.commands?.disabled ?? []);

  const { commands, errors } = await discoverCommands(shakaHome);
  const manifest = await readManifest(shakaHome);

  if (commands.length === 0 && disabledSet.size === 0 && errors.length === 0) {
    console.log("No commands found.");
    console.log("\nCreate one with: shaka commands new <name>");
    return;
  }

  const rows = buildCommandRows(commands, manifest, disabledSet);
  printCommandTable(rows);

  if (errors.length > 0) {
    console.log(`\n${errors.length} command(s) with errors (run shaka doctor for details)`);
  }
}

async function newCommand(name: string): Promise<void> {
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    console.error(
      `Invalid command name "${name}" — must be lowercase alphanumeric with hyphens, max 64 chars`,
    );
    process.exit(1);
  }

  const shakaHome = getShakaHome();
  const targetPath = join(shakaHome, "customizations", "commands", `${name}.md`);

  if (await Bun.file(targetPath).exists()) {
    console.error(`Command "${name}" already exists at ${targetPath}`);
    process.exit(1);
  }

  // Also check system commands
  const systemPath = join(shakaHome, "system", "commands", `${name}.md`);
  if (await Bun.file(systemPath).exists()) {
    console.log(`Note: This will override the built-in '${name}' command.`);
  }

  const scaffold = `---
description: TODO
---

TODO: Add your command prompt here.

$ARGUMENTS
`;

  await mkdir(dirname(targetPath), { recursive: true });
  await Bun.write(targetPath, scaffold);
  console.log(`Created ${targetPath}`);
  console.log("Edit the file, then run `shaka reload` to install.");
}

/** Add names to the disabled list in config. Does not reload providers. */
export async function addToDisabledList(shakaHome: string, names: string[]): Promise<void> {
  const configPath = join(shakaHome, "config.json");
  let config: Record<string, unknown>;
  try {
    config = await Bun.file(configPath).json();
  } catch {
    throw new Error(`Failed to parse ${configPath} — fix the JSON syntax and retry`);
  }
  const disabled: string[] =
    ((config.commands as Record<string, unknown>)?.disabled as string[]) ?? [];
  const disabledSet = new Set(disabled);

  for (const name of names) {
    disabledSet.add(name);
  }

  config.commands = { ...(config.commands as object), disabled: [...disabledSet] };
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Remove names from the disabled list in config. Does not reload providers. */
export async function removeFromDisabledList(shakaHome: string, names: string[]): Promise<void> {
  const configPath = join(shakaHome, "config.json");
  let config: Record<string, unknown>;
  try {
    config = await Bun.file(configPath).json();
  } catch {
    throw new Error(`Failed to parse ${configPath} — fix the JSON syntax and retry`);
  }
  const disabled: string[] =
    ((config.commands as Record<string, unknown>)?.disabled as string[]) ?? [];
  const removeSet = new Set(names);
  const remaining = disabled.filter((n) => !removeSet.has(n));

  config.commands = { ...(config.commands as object), disabled: remaining };
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function disableCommands(names: string[]): Promise<void> {
  const shakaHome = getShakaHome();
  const configPath = join(shakaHome, "config.json");

  if (!(await Bun.file(configPath).exists())) {
    console.error("Config not found. Run `shaka init` first.");
    process.exit(1);
  }

  await addToDisabledList(shakaHome, names);
  console.log(`Disabled: ${names.join(", ")}`);
  await reloadProviders(shakaHome);
}

async function enableCommands(names: string[]): Promise<void> {
  const shakaHome = getShakaHome();
  const configPath = join(shakaHome, "config.json");

  if (!(await Bun.file(configPath).exists())) {
    console.error("Config not found. Run `shaka init` first.");
    process.exit(1);
  }

  await removeFromDisabledList(shakaHome, names);
  console.log(`Enabled: ${names.join(", ")}`);
  await reloadProviders(shakaHome);
}

async function reloadProviders(shakaHome: string): Promise<void> {
  const config = await loadConfig(shakaHome);
  const providers = getAllProviders();

  const installedProviders: ProviderConfigurer[] = [];
  for (const provider of providers) {
    if (!config?.providers[provider.name]?.enabled) continue;
    if (!provider.isInstalled()) continue;

    const result = await provider.install({ shakaHome });
    if (result.ok) {
      console.log(`  Reloaded ${provider.name}`);
      installedProviders.push(provider);
    } else {
      console.error(`  Failed to reload ${provider.name}: ${result.error.message}`);
    }
  }

  if (installedProviders.length > 0) {
    await installCommandsForProviders(shakaHome, installedProviders);
  }
}

export function createCommandsCommand(): Command {
  const cmd = new Command("commands").description("Manage slash commands");

  cmd
    .command("list")
    .description("Show all discovered commands")
    .action(async () => {
      await listCommands();
    });

  cmd
    .command("new")
    .description("Create a new command")
    .argument("<name>", "Command name (lowercase, hyphens allowed)")
    .action(async (name: string) => {
      await newCommand(name);
    });

  cmd
    .command("disable")
    .description("Disable one or more commands")
    .argument("<names...>", "Command name(s) to disable")
    .action(async (names: string[]) => {
      await disableCommands(names);
    });

  cmd
    .command("enable")
    .description("Enable one or more previously disabled commands")
    .argument("<names...>", "Command name(s) to enable")
    .action(async (names: string[]) => {
      await enableCommands(names);
    });

  return cmd;
}
