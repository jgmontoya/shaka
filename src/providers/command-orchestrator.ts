/**
 * Command installation orchestrator.
 *
 * Coordinates discovery and manifest I/O across providers.
 * Discovery happens once, manifest is written once — providers only clean + install.
 */

import { loadConfig } from "../domain/config";
import { discoverCommands } from "./command-discovery";
import { readManifest, writeManifest } from "./command-manifest";
import type { ProviderConfigurer } from "./types";

/**
 * Install commands across all given providers.
 *
 * 1. Read manifest (once)
 * 2. Discover commands (once)
 * 3. Each provider cleans + installs
 * 4. Write manifest (once, deterministic from discovery)
 */
export async function installCommandsForProviders(
  shakaHome: string,
  providers: ProviderConfigurer[],
): Promise<void> {
  const shakaConfig = await loadConfig(shakaHome);
  const disabled = shakaConfig?.commands?.disabled;

  const manifest = await readManifest(shakaHome);
  const { commands, errors } = await discoverCommands(shakaHome, disabled);

  for (const e of errors) {
    console.error(`  ⚠ Skipped command "${e.name}" — ${e.error}\n    → ${e.sourcePath}`);
  }

  for (const provider of providers) {
    try {
      await provider.commands.install({ commands, manifest });
    } catch (e) {
      console.error(
        `  ⚠ Command installation failed for ${provider.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Manifest reflects discovery (what Shaka manages), not per-provider results.
  // Cleanup is idempotent — rm --force on non-existent files is a no-op.
  const global = commands.filter((c) => !c.cwd).map((c) => c.name);
  const scoped: Record<string, string[]> = {};
  for (const cmd of commands) {
    for (const cwdPath of cmd.cwd ?? []) {
      if (!scoped[cwdPath]) scoped[cwdPath] = [];
      scoped[cwdPath].push(cmd.name);
    }
  }

  await writeManifest(shakaHome, { global, scoped });
}
