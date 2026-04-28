/**
 * Shared utilities for installing/uninstalling agents and skills.
 * Used by both Claude and OpenCode provider configurers.
 *
 * Agents use a directory symlink for namespacing:
 * - Agents: ~/.claude/agents/shaka/ → ${shakaHome}/system/agents/
 *
 * Skills use per-skill symlinks so providers discover them as direct children:
 * - Skills: ~/.claude/skills/council/ → ${shakaHome}/system/skills/council/
 */

import { access, lstat, mkdir, readdir, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readSymlinkTarget, removeLink } from "../platform/paths";
import type { ComponentStatus } from "./types";

/**
 * Install an asset directory via symlink: ${targetDir}/shaka → ${sourceDir}
 *
 * Uses a symlink to avoid duplication and ensure updates are instant.
 * Silently preserves existing real directories (user's custom setup).
 *
 * @param sourceDir - Path to source directory (e.g., ${shakaHome}/system/agents)
 * @param targetDir - Path to parent directory (e.g., ~/.claude/agents)
 * @param linkName - Name of the symlink (default: "shaka")
 */
async function installAssetSymlink(
  sourceDir: string,
  targetDir: string,
  linkName = "shaka",
): Promise<void> {
  const linkPath = join(targetDir, linkName);

  // Check if source exists
  try {
    await access(sourceDir);
  } catch {
    return;
  }

  await mkdir(targetDir, { recursive: true });

  try {
    await lstat(linkPath);

    // readlink works for both symlinks and Windows junctions
    const currentTarget = await readSymlinkTarget(linkPath);
    if (currentTarget === null) {
      // Real directory exists — user has custom content, preserve it
      return;
    }
    if (resolve(currentTarget) === resolve(sourceDir)) {
      return;
    }
    // Wrong target — remove and re-create
    await removeLink(linkPath);
  } catch {
    // Doesn't exist — will create
  }

  // "junction" requires no elevated privileges on Windows; ignored on Unix
  await symlink(sourceDir, linkPath, "junction");
}

/**
 * Uninstall an asset symlink if it points to the source directory.
 * Preserves real directories (user customizations) and symlinks pointing elsewhere.
 *
 * @param sourceDir - Path to source directory
 * @param targetDir - Path to parent directory
 * @param linkName - Name of the symlink (default: "shaka")
 */
async function uninstallAssetSymlink(
  sourceDir: string,
  targetDir: string,
  linkName = "shaka",
): Promise<void> {
  const linkPath = join(targetDir, linkName);

  try {
    // readlink works for both symlinks and Windows junctions
    const currentTarget = await readSymlinkTarget(linkPath);
    if (currentTarget === null) {
      return; // Not a symlink/junction — preserve it
    }

    if (resolve(currentTarget) === resolve(sourceDir)) {
      await removeLink(linkPath);
    }
  } catch {
    // Doesn't exist — nothing to uninstall
  }
}

/**
 * Verify an asset symlink exists and points to the correct source directory.
 * Returns ok:true if symlink is correct OR if a real directory exists (user's custom setup).
 *
 * @param sourceDir - Expected symlink target (e.g., ${shakaHome}/system/agents)
 * @param targetDir - Parent directory containing the symlink (e.g., ~/.claude/agents)
 * @param assetName - Human-readable name for error messages (e.g., "agents", "skills")
 * @param linkName - Name of the symlink (default: "shaka")
 */
export async function verifyAssetSymlink(
  sourceDir: string,
  targetDir: string,
  assetName: string,
  linkName = "shaka",
): Promise<ComponentStatus> {
  const linkPath = join(targetDir, linkName);

  try {
    await lstat(linkPath);

    // readlink works for both symlinks and Windows junctions
    const currentTarget = await readSymlinkTarget(linkPath);
    if (currentTarget === null) {
      // Real directory — acceptable (user's custom setup)
      return { ok: true };
    }

    if (resolve(currentTarget) !== resolve(sourceDir)) {
      return {
        ok: false,
        issue: `${assetName} symlink points to wrong location: ${currentTarget}`,
      };
    }

    return { ok: true };
  } catch {
    return { ok: false, issue: `shaka ${assetName} symlink not found` };
  }
}

/**
 * Install per-skill symlinks: for each subdirectory in sourceDir,
 * create a symlink targetDir/<name> → sourceDir/<name>.
 *
 * Used for skills so each appears as a direct child of the provider's skills dir
 * (e.g., ~/.claude/skills/council/ → system/skills/council/).
 */
async function installPerSkillSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  try {
    await access(sourceDir);
  } catch {
    return;
  }

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await installAssetSymlink(join(sourceDir, entry.name), targetDir, entry.name);
    }
  }
}

/**
 * Uninstall per-skill symlinks in targetDir that point into sourceDir.
 * Only removes symlinks whose resolved target starts with the resolved sourceDir.
 */
async function uninstallPerSkillSymlinks(sourceDir: string, targetDir: string): Promise<void> {
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const resolvedSource = resolve(sourceDir);

    for (const entry of entries) {
      const linkPath = join(targetDir, entry.name);
      const currentTarget = await readSymlinkTarget(linkPath);
      if (currentTarget !== null) {
        const resolvedTarget = resolve(currentTarget);
        if (
          resolvedTarget === resolvedSource ||
          resolvedTarget.startsWith(`${resolvedSource}${sep}`)
        ) {
          await removeLink(linkPath);
        }
      }
    }
  } catch {
    // Target dir doesn't exist — nothing to uninstall
  }
}

/**
 * Verify per-skill symlinks exist for all subdirectories in sourceDir.
 * Returns ok:true if all skills have correct symlinks (or sourceDir is empty/missing).
 */
async function verifyPerSkillSymlinks(
  sourceDir: string,
  targetDir: string,
  assetName: string,
): Promise<ComponentStatus> {
  try {
    await access(sourceDir);
  } catch {
    return { ok: true };
  }

  const entries = await readdir(sourceDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  if (skillDirs.length === 0) return { ok: true };

  for (const entry of skillDirs) {
    const result = await verifyAssetSymlink(
      join(sourceDir, entry.name),
      targetDir,
      `${assetName} (${entry.name})`,
      entry.name,
    );
    if (!result.ok) return result;
  }

  return { ok: true };
}

export {
  installAssetSymlink,
  uninstallAssetSymlink,
  installPerSkillSymlinks,
  uninstallPerSkillSymlinks,
  verifyPerSkillSymlinks,
};
