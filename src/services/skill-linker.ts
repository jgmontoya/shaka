/**
 * Links/unlinks installed skills to provider skill directories.
 *
 * Bridge between the provider-agnostic install pipeline and
 * provider-specific discovery mechanisms. Each enabled provider
 * gets a per-skill symlink so skills appear as direct children
 * of the provider's skills directory.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../domain/config";
import { installAssetSymlink, uninstallAssetSymlink } from "../providers/asset-installer";

interface ProviderSkillDir {
  provider: "claude" | "opencode";
  skillsDir: string;
}

function getAllProviderSkillDirs(env: NodeJS.ProcessEnv = process.env): ProviderSkillDir[] {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
  return [
    { provider: "claude", skillsDir: join(homedir(), ".claude", "skills") },
    { provider: "opencode", skillsDir: join(base, "skills") },
  ];
}

function getEnabledProviderSkillDirs(
  config: { providers: { claude: { enabled: boolean }; opencode: { enabled: boolean } } },
  env: NodeJS.ProcessEnv = process.env,
): ProviderSkillDir[] {
  return getAllProviderSkillDirs(env).filter((dir) =>
    dir.provider === "claude" ? config.providers.claude.enabled : config.providers.opencode.enabled,
  );
}

/**
 * Create a per-skill symlink in each enabled provider's skills directory.
 * Called after `shaka skill install` so the skill is immediately discoverable.
 */
export async function linkSkillToProviders(shakaHome: string, skillName: string): Promise<void> {
  const config = await loadConfig(shakaHome);
  if (!config) return;

  const sourceDir = join(shakaHome, "skills", skillName);
  for (const { skillsDir } of getEnabledProviderSkillDirs(config)) {
    await installAssetSymlink(sourceDir, skillsDir, skillName);
  }
}

/**
 * Remove the per-skill symlink from all provider skill directories.
 * Sweeps all providers (not just enabled) to clean up stale symlinks
 * from providers that may have been disabled after the skill was installed.
 */
export async function unlinkSkillFromProviders(
  shakaHome: string,
  skillName: string,
): Promise<void> {
  const sourceDir = join(shakaHome, "skills", skillName);
  for (const { skillsDir } of getAllProviderSkillDirs()) {
    await uninstallAssetSymlink(sourceDir, skillsDir, skillName);
  }
}
