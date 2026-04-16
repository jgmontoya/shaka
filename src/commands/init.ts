/**
 * CLI handler for `shaka init` command.
 *
 * Sets up shaka from current state. Idempotent — safe to run anytime.
 * For safe upgrades with version checking, use `shaka update`.
 */

import { createInterface } from "node:readline";
import { Command } from "commander";
import { isPermissionsManaged, loadConfig, resolveShakaHome } from "../domain/config";
import { findNewerLocalTag, getGitRef } from "../domain/version";
import { resolveFromModule } from "../platform/paths";
import { installCommandsForProviders } from "../providers/command-orchestrator";
import { createProvider, getProviderNames } from "../providers/registry";
import type { ProviderConfigurer, ProviderName } from "../providers/types";
import { type InitResult, InitService, type Personalization } from "../services/init-service";
import { type DetectedProviders, detectInstalledProviders } from "../services/provider-detection";
import { printOpencodeSummarizationHint } from "./hints";

function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Resolve which providers to install from CLI flags.
 * Returns null when interactive prompt is needed.
 */
function resolveProvidersFromFlags(
  options: { claude?: boolean; opencode?: boolean; codex?: boolean; all?: boolean },
  detected: DetectedProviders,
): ProviderName[] | null {
  // Map CLI flags to wanted provider names
  const wanted: ProviderName[] = [];
  for (const name of getProviderNames()) {
    if (options[name] || options.all) wanted.push(name);
  }

  if (wanted.length === 0) return null;

  const selected: ProviderName[] = [];
  const warnings: string[] = [];

  for (const name of wanted) {
    if (detected[name]) {
      selected.push(name);
    } else {
      const provider = createProvider(name);
      warnings.push(`${provider.label} is not installed.`);
    }
  }

  for (const w of warnings) {
    console.log(`  ⚠ ${w}`);
  }

  if (selected.length === 0) {
    console.error("\nERROR: No selected providers are available.");
    console.error("Install Claude Code, opencode, or Codex first.");
    process.exit(1);
  }

  return selected;
}

/**
 * Interactive provider selection when no flags are given.
 */
async function promptProviderSelection(detected: DetectedProviders): Promise<ProviderName[]> {
  const allNames = getProviderNames();
  const available = allNames.filter((name) => detected[name]);

  if (available.length === 0) {
    console.error(
      "ERROR: No AI providers detected. Install Claude Code, opencode, or Codex first.",
    );
    process.exit(1);
  }

  console.log("Detected providers:");
  for (const name of allNames) {
    const provider = createProvider(name);
    const status = detected[name] ? "✓ available" : "✗ not found";
    console.log(`  ${provider.label}: ${status}`);
  }
  console.log();

  if (available.length === 1) {
    const name = available[0] as ProviderName;
    const provider = createProvider(name);
    console.log(`Only ${provider.label} is available — installing it.\n`);
    return available;
  }

  // Multiple available — let user choose
  console.log("Which providers do you want to install?");
  for (let i = 0; i < available.length; i++) {
    const name = available[i] as ProviderName;
    const provider = createProvider(name);
    console.log(`  ${i + 1}. ${provider.label}`);
  }
  console.log(`  ${available.length + 1}. All`);
  console.log();

  const choices = available.map((_, i) => String(i + 1));
  choices.push(String(available.length + 1));
  const answer = await prompt(`Select [${choices.join("/")}]: `);

  const choiceIndex = Number.parseInt(answer, 10) - 1;
  const chosen = available[choiceIndex];
  if (chosen !== undefined) {
    return [chosen];
  }
  if (choiceIndex === available.length) {
    return available;
  }

  const flagHints = allNames.map((n) => `--${n}`).join(", ");
  console.log(
    `Invalid selection. Use ${choices.join(", ")}. (Or re-run with ${flagHints}, or --all)`,
  );
  process.exit(1);
}

/**
 * Prompt user for their name and assistant name.
 * Uses existing config values as defaults when available, falls back to hardcoded defaults.
 */
async function promptPersonalization(shakaHome: string): Promise<Personalization> {
  const existing = await loadConfig(shakaHome);
  const defaultPrincipal = existing?.principal?.name ?? "Chief";
  const defaultAssistant = existing?.assistant?.name ?? "Shaka";

  const principalName = await prompt(`Your name [${defaultPrincipal}]: `);
  const assistantName = await prompt(`Assistant name [${defaultAssistant}]: `);

  return {
    principalName: principalName || defaultPrincipal,
    assistantName: assistantName || defaultAssistant,
  };
}

function logProviderStatus(providers: InitResult["providers"]): void {
  console.log("Detecting providers...");
  for (const name of getProviderNames()) {
    const provider = createProvider(name);
    const status = providers[name].detected ? "✓ detected" : "✗ not found";
    console.log(`  ${provider.label}: ${status}`);
  }
}

async function installProviders(
  providers: InitResult["providers"],
  shakaHome: string,
): Promise<void> {
  const config = await loadConfig(shakaHome);
  const permissionMode = isPermissionsManaged(config) ? undefined : "skip";

  const installedProviders: ProviderConfigurer[] = [];

  for (const name of getProviderNames()) {
    if (providers[name].installed) {
      const provider = createProvider(name);
      const result = await provider.install({ shakaHome, permissionMode });
      if (!result.ok) {
        console.error(`  ✗ Failed to install ${name} configuration: ${result.error.message}`);
      } else {
        console.log(`  ✓ Installed ${name} configuration`);
        installedProviders.push(provider);
      }
    }
  }

  // Install commands via orchestrator (discovery + manifest written once)
  if (installedProviders.length > 0) {
    await installCommandsForProviders(shakaHome, installedProviders);
  }

  // Register MCP server for providers that support it
  for (const provider of installedProviders) {
    const mcpResult = await provider.registerMcpServer?.();
    if (mcpResult && !mcpResult.ok) {
      console.error(
        `  ✗ Failed to register MCP server for ${provider.label}: ${mcpResult.error.message}`,
      );
    } else if (mcpResult?.ok) {
      console.log(`  ✓ Registered Shaka MCP server with ${provider.label}`);
    }
  }
}

function logCreatedItems(result: InitResult): void {
  if (result.symlinks.length > 0) {
    console.log("\nLinked:");
    for (const link of result.symlinks) {
      console.log(`  ${link}`);
    }
  }
  if (result.files.length > 0) {
    console.log("\nCreated files:");
    for (const file of result.files) {
      console.log(`  ${file}`);
    }
  }
}

async function logVersionInfo(result: InitResult): Promise<void> {
  const repoRoot = resolveFromModule(import.meta.url, "../..");
  const ref = await getGitRef(repoRoot);
  const refLabel = ref
    ? ref.type === "tag"
      ? ref.label
      : `v${result.currentVersion} (${ref.label})`
    : `v${result.currentVersion}`;

  console.log(`\n✅ Shaka initialized successfully — running on ${refLabel}`);

  const newerTag = await findNewerLocalTag(repoRoot);
  if (newerTag) {
    console.log(`   Update available: ${newerTag}. Run \`shaka update\` to upgrade.`);
  }
}

export function createInitCommand(): Command {
  return new Command("init")
    .description("Initialize Shaka configuration")
    .option("--claude", "Install hooks for Claude Code")
    .option("--opencode", "Install hooks for opencode")
    .option("--codex", "Install hooks for Codex")
    .option("--all", "Install hooks for all detected providers")
    .option("--force", "Overwrite existing configuration")
    .option("--defaults", "Skip name prompts and use defaults")
    .action(async (options) => {
      const shakaHome = resolveShakaHome({
        SHAKA_HOME: process.env.SHAKA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      });

      console.log("Initializing Shaka...\n");

      const detected = detectInstalledProviders();
      const flagProviders = resolveProvidersFromFlags(options, detected);
      const selectedProviders = flagProviders ?? (await promptProviderSelection(detected));

      // Prompt for names unless --defaults is passed
      let personalization: Personalization | undefined;
      if (!options.defaults) {
        console.log();
        personalization = await promptPersonalization(shakaHome);
      }

      console.log();

      const initService = new InitService({ shakaHome });
      const result = await initService.init({
        providers: selectedProviders,
        force: options.force,
        personalization,
      });

      if (!result.ok) {
        console.error(`ERROR: ${result.error.message}`);
        process.exit(1);
      }

      logProviderStatus(result.value.providers);
      await installProviders(result.value.providers, shakaHome);
      logCreatedItems(result.value);
      await logVersionInfo(result.value);
      await printOpencodeSummarizationHint(shakaHome);
    });
}
