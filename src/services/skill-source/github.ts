/**
 * GitHub skill source provider.
 *
 * Clones a GitHub repository, locates the skill directory, and returns
 * a FetchResult for the downstream pipeline (validate, scan, deploy).
 *
 * Supports two modes:
 * 1. Single-skill repo — SKILL.md at root (or specified subdirectory)
 * 2. Marketplace fallback — .claude-plugin/marketplace.json listing skills
 */

import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseGitHubUrl } from "../../domain/github-url";
import { type Result, err, ok } from "../../domain/result";
import { cleanupTempDir } from "../skill-pipeline";
import type { FetchOptions, FetchResult, SkillSourceProvider } from "./types";

export type GitCloneFn = (
  url: string,
  dest: string,
  ref: string | null,
) => Promise<Result<void, Error>>;

export type GitRevParseFn = (cwd: string) => Promise<Result<string, Error>>;

export interface GitHubProviderOptions {
  /** Override git clone for testing. */
  gitClone?: GitCloneFn;
  /** Override git rev-parse for testing. */
  gitRevParse?: GitRevParseFn;
}

/** Marketplace manifest format (.claude-plugin/marketplace.json). */
interface MarketplaceManifest {
  name: string;
  plugins: { name: string; source: string; description?: string }[];
}

/** Create a GitHub skill source provider. */
export function createGitHubProvider(options: GitHubProviderOptions = {}): SkillSourceProvider {
  return {
    name: "github",

    canHandle(input: string): boolean {
      return parseGitHubUrl(input).ok;
    },

    async fetch(input: string, fetchOptions?: FetchOptions): Promise<Result<FetchResult, Error>> {
      const parsed = parseGitHubUrl(input);
      if (!parsed.ok) return parsed;

      const tempDir = join(
        tmpdir(),
        `shaka-skill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
      await mkdir(tempDir, { recursive: true });

      const cloneFn = options.gitClone ?? defaultGitClone;
      const cloneResult = await cloneFn(parsed.value.cloneUrl, tempDir, parsed.value.ref);
      if (!cloneResult.ok) {
        await cleanupTempDir(tempDir);
        return cloneResult;
      }

      const revParseFn = options.gitRevParse ?? defaultGitRevParse;
      const commitResult = await revParseFn(tempDir);
      if (!commitResult.ok) {
        await cleanupTempDir(tempDir);
        return commitResult;
      }

      const version = commitResult.value;
      const subdirectory = fetchOptions?.subdirectory ?? parsed.value.subdirectory;
      return resolveAfterClone(tempDir, subdirectory, version, input, fetchOptions);
    },
  };
}

/** Discover and resolve the skill directory after a successful clone. Owns tempDir cleanup on failure. */
async function resolveAfterClone(
  tempDir: string,
  subdirectory: string | null,
  version: string,
  source: string,
  fetchOptions?: FetchOptions,
): Promise<Result<FetchResult, Error>> {
  let discovered: Result<FetchResult, Error> | null;
  try {
    discovered = await discoverSkillDir(tempDir, subdirectory, version, source, fetchOptions);
  } catch (e) {
    await cleanupTempDir(tempDir);
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (discovered?.ok) return discovered;

  await cleanupTempDir(tempDir);
  if (discovered) return discovered;
  if (subdirectory) {
    return err(new Error(`SKILL.md not found in specified subdirectory: ${subdirectory}`));
  }
  return err(new Error("No SKILL.md or .claude-plugin/marketplace.json found in repository."));
}

// --- Skill discovery chain ---

/**
 * Try to locate SKILL.md in the cloned repo using multiple strategies:
 * 1. Root or explicit subdirectory
 * 2. Marketplace manifest (.claude-plugin/marketplace.json with plugins array)
 * 3. skills/ directory scan (plugin format repos)
 */
async function discoverSkillDir(
  tempDir: string,
  subdirectory: string | null,
  version: string,
  source: string,
  options?: FetchOptions,
): Promise<Result<FetchResult, Error> | null> {
  // Try explicit subdirectory first. If it misses, do not fall back to another skill.
  if (subdirectory) {
    const explicitSkillDir = resolveInsideRepo(tempDir, subdirectory);
    if (!explicitSkillDir) {
      return err(new Error(`Invalid skill subdirectory: ${subdirectory}`));
    }
    if (await Bun.file(join(explicitSkillDir, "SKILL.md")).exists()) {
      return ok({ skillDir: explicitSkillDir, tempDir, version, source, subdirectory });
    }
    return null;
  }

  // Try SKILL.md at repo root
  if (await Bun.file(join(tempDir, "SKILL.md")).exists()) {
    return ok({ skillDir: tempDir, tempDir, version, source, subdirectory: null });
  }

  // Fallback: marketplace
  const marketplaceResult = await tryMarketplace(tempDir, subdirectory, version, source, options);
  if (marketplaceResult) return marketplaceResult;

  // Fallback: scan skills/ directory (plugin format without valid marketplace.json)
  return trySkillsDirectory(tempDir, version, source, options);
}

// --- Marketplace fallback ---

async function tryMarketplace(
  tempDir: string,
  subdirectory: string | null,
  version: string,
  source: string,
  options?: FetchOptions,
): Promise<Result<FetchResult, Error> | null> {
  const manifestPath = join(tempDir, ".claude-plugin", "marketplace.json");
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) return null;

  let manifest: MarketplaceManifest;
  try {
    manifest = await file.json();
  } catch {
    return null;
  }

  if (!manifest.plugins || manifest.plugins.length === 0) return null;

  // If subdirectory was specified, find matching plugin
  if (subdirectory) {
    return resolveMarketplacePlugin(tempDir, manifest, subdirectory, version, source);
  }

  // Single plugin — auto-select
  if (manifest.plugins.length === 1) {
    const plugin = manifest.plugins[0] as MarketplaceManifest["plugins"][0];
    const result = await resolvePluginSkillDir(tempDir, plugin, version, source);
    return result;
  }

  // Multiple plugins — prompt user to choose
  if (!options?.selectSkill) return null;

  const choices = manifest.plugins.map((p) => ({
    name: p.name,
    description: p.description,
  }));

  const selected = await options.selectSkill(choices);
  if (!selected) return err(new Error("Skill selection cancelled."));

  const plugin = manifest.plugins.find((p) => p.name === selected);
  if (!plugin) return null;

  return resolvePluginSkillDir(tempDir, plugin, version, source);
}

/**
 * Resolve the skill directory for a marketplace plugin.
 * Tries the plugin's source path first, then falls back to
 * .claude/skills/<name>/ (Claude Code convention).
 */
async function resolvePluginSkillDir(
  tempDir: string,
  plugin: MarketplaceManifest["plugins"][0],
  version: string,
  source: string,
): Promise<Result<FetchResult, Error> | null> {
  const pluginPath = plugin.source.replace(/^\.\//, "");

  // Try the explicit source path
  const skillDir = pluginPath ? resolveInsideRepo(tempDir, pluginPath) : tempDir;
  if (!skillDir) {
    return err(new Error(`Invalid marketplace path: ${plugin.source}`));
  }
  if (await Bun.file(join(skillDir, "SKILL.md")).exists()) {
    return ok({ skillDir, tempDir, version, source, subdirectory: pluginPath || null });
  }

  // Fallback: .claude/skills/<plugin-name>/ (Claude Code convention)
  const claudeSkillDir = resolveInsideRepo(tempDir, join(".claude", "skills", plugin.name));
  if (claudeSkillDir && (await Bun.file(join(claudeSkillDir, "SKILL.md")).exists())) {
    const subdir = join(".claude", "skills", plugin.name);
    return ok({ skillDir: claudeSkillDir, tempDir, version, source, subdirectory: subdir });
  }

  // Fallback: scan .claude/skills/ for any single skill directory
  const claudeSkillsDir = join(tempDir, ".claude", "skills");
  const found = await findSingleSkillDir(claudeSkillsDir);
  if (found) {
    const subdir = join(".claude", "skills", found.name);
    return ok({ skillDir: found.path, tempDir, version, source, subdirectory: subdir });
  }

  return null;
}

/**
 * Find a single skill directory containing SKILL.md inside a parent directory.
 * Returns null if zero or multiple skills are found.
 */
async function findSingleSkillDir(
  parentDir: string,
): Promise<{ name: string; path: string } | null> {
  try {
    const entries = await readdir(parentDir, { withFileTypes: true });
    const skillDirs: { name: string; path: string }[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidatePath = join(parentDir, entry.name);
        if (await Bun.file(join(candidatePath, "SKILL.md")).exists()) {
          skillDirs.push({ name: entry.name, path: candidatePath });
        }
      }
    }

    return skillDirs.length === 1 ? (skillDirs[0] as { name: string; path: string }) : null;
  } catch {
    return null;
  }
}

async function resolveMarketplacePlugin(
  tempDir: string,
  manifest: MarketplaceManifest,
  subdirectory: string,
  version: string,
  source: string,
): Promise<Result<FetchResult, Error> | null> {
  const plugin = manifest.plugins.find((p) => {
    const normalized = p.source.replace(/^\.\//, "");
    return normalized === subdirectory || p.name === subdirectory;
  });

  if (!plugin) return null;

  const pluginPath = plugin.source.replace(/^\.\//, "");
  const skillDir = resolveInsideRepo(tempDir, pluginPath);
  if (!skillDir) {
    return err(new Error(`Invalid marketplace path: ${plugin.source}`));
  }

  const exists = await Bun.file(join(skillDir, "SKILL.md")).exists();
  if (!exists) return null;
  return ok({ skillDir, tempDir, version, source, subdirectory: pluginPath });
}

// --- skills/ directory fallback ---

/**
 * Scan the `skills/` directory at repo root for skill subdirectories.
 * Handles plugin-format repos where skills live under skills/<name>/.
 */
async function trySkillsDirectory(
  tempDir: string,
  version: string,
  source: string,
  options?: FetchOptions,
): Promise<Result<FetchResult, Error> | null> {
  const skillsDir = join(tempDir, "skills");

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skillDirs: { name: string; path: string }[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidatePath = join(skillsDir, entry.name);
        if (await Bun.file(join(candidatePath, "SKILL.md")).exists()) {
          skillDirs.push({ name: entry.name, path: candidatePath });
        }
      }
    }

    if (skillDirs.length === 0) return null;

    // Single skill — auto-select
    if (skillDirs.length === 1) {
      const skill = skillDirs[0] as { name: string; path: string };
      return ok({
        skillDir: skill.path,
        tempDir,
        version,
        source,
        subdirectory: join("skills", skill.name),
      });
    }

    // Multiple skills — prompt user to choose
    if (!options?.selectSkill) return null;

    const choices = skillDirs.map((s) => ({ name: s.name }));
    const selected = await options.selectSkill(choices);
    if (!selected) return err(new Error("Skill selection cancelled."));

    const chosen = skillDirs.find((s) => s.name === selected);
    if (!chosen) return null;

    return ok({
      skillDir: chosen.path,
      tempDir,
      version,
      source,
      subdirectory: join("skills", chosen.name),
    });
  } catch {
    return null;
  }
}

// --- Default git implementations ---

async function defaultGitClone(
  url: string,
  dest: string,
  ref: string | null,
): Promise<Result<void, Error>> {
  try {
    if (ref) {
      await Bun.$`git clone --depth 1 --branch ${ref} ${url} ${dest}`.quiet();
    } else {
      await Bun.$`git clone --depth 1 ${url} ${dest}`.quiet();
    }
    return ok(undefined);
  } catch (e) {
    return err(new Error(`Git clone failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

async function defaultGitRevParse(cwd: string): Promise<Result<string, Error>> {
  try {
    const result = await Bun.$`git -C ${cwd} rev-parse HEAD`.quiet();
    return ok(result.text().trim());
  } catch (e) {
    return err(
      new Error(`Failed to get commit SHA: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

function resolveInsideRepo(repoRoot: string, unsafePath: string): string | null {
  const root = resolve(repoRoot);
  const candidate = resolve(repoRoot, unsafePath);
  if (candidate === root || candidate.startsWith(`${root}${sep}`)) {
    return candidate;
  }
  return null;
}
