/**
 * Skill update service.
 *
 * Re-fetches an installed skill from its original source via the
 * appropriate provider and replaces the local copy.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Result, err, ok } from "../domain/result";
import { type InstalledSkill, loadManifest } from "../domain/skills-manifest";
import { runSecurityChecks } from "./skill-install-service";
import {
  cleanupTempDir,
  installSkillFiles,
  persistToManifest,
  validateSkillStructure,
} from "./skill-pipeline";
import { getProviderByName } from "./skill-source";
import type { SkillSourceProvider } from "./skill-source/types";

export interface UpdateOptions {
  /** Override provider lookup for testing. */
  provider?: SkillSourceProvider;
}

export interface UpdateResult {
  name: string;
  previousVersion: string;
  newVersion: string;
  upToDate: boolean;
  /** Security warnings for the updated version (non-blocking). */
  warnings?: string[];
}

export async function updateSkill(
  shakaHome: string,
  name: string,
  options: UpdateOptions = {},
): Promise<Result<UpdateResult, Error>> {
  const manifestResult = await loadManifest(shakaHome);
  if (!manifestResult.ok) return manifestResult;

  const skill = manifestResult.value.skills[name];
  if (!skill) {
    return err(new Error(`Skill "${name}" is not installed.`));
  }

  const providerResult = resolveUpdateProvider(skill.provider, options);
  if (!providerResult.ok) return providerResult;
  const provider = providerResult.value;

  // Fetch latest from provider (passing stored subdirectory for update flow)
  const fetchResult = await provider.fetch(skill.source, { subdirectory: skill.subdirectory });
  if (!fetchResult.ok) return fetchResult;

  try {
    // Check if already up to date
    if (fetchResult.value.version === skill.version) {
      return ok({
        name,
        previousVersion: skill.version,
        newVersion: fetchResult.value.version,
        upToDate: true,
      });
    }

    // Validate structure
    const validation = await validateSkillStructure(fetchResult.value.skillDir);
    if (!validation.ok) return validation;

    if (validation.value.name !== name) {
      return err(
        new Error(
          `Skill was renamed upstream from "${name}" to "${validation.value.name}". Remove and reinstall to use the new name.`,
        ),
      );
    }

    const warnings = await collectUpdateWarnings(fetchResult.value.skillDir);

    const applyResult = await deployAndPersistUpdate(
      shakaHome,
      name,
      skill,
      fetchResult.value.version,
      fetchResult.value.skillDir,
      fetchResult.value.tempDir,
    );
    if (!applyResult.ok) return applyResult;

    return ok({
      name,
      previousVersion: skill.version,
      newVersion: fetchResult.value.version,
      upToDate: false,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } finally {
    await cleanupTempDir(fetchResult.value.tempDir);
  }
}

export interface UpdateAllResult {
  results: UpdateResult[];
  failures: { name: string; error: Error }[];
}

export async function updateAllSkills(
  shakaHome: string,
  options: UpdateOptions = {},
): Promise<Result<UpdateAllResult, Error>> {
  const manifestResult = await loadManifest(shakaHome);
  if (!manifestResult.ok) return manifestResult;

  const results: UpdateResult[] = [];
  const failures: { name: string; error: Error }[] = [];

  for (const name of Object.keys(manifestResult.value.skills)) {
    const result = await updateSkill(shakaHome, name, options);
    if (result.ok) {
      results.push(result.value);
    } else {
      failures.push({ name, error: result.error });
    }
  }

  return ok({ results, failures });
}

function resolveUpdateProvider(
  providerName: string,
  options: UpdateOptions,
): Result<SkillSourceProvider, Error> {
  if (options.provider) {
    return ok(options.provider);
  }
  return getProviderByName(providerName);
}

async function collectUpdateWarnings(skillDir: string): Promise<string[]> {
  // Security checks (warn but don't block — user already trusts this source)
  const report = await runSecurityChecks(skillDir);
  if (report.allPassed) return [];

  return report.checks.filter((check) => !check.passed).map((check) => check.failureMessage);
}

async function deployAndPersistUpdate(
  shakaHome: string,
  name: string,
  skill: InstalledSkill,
  version: string,
  skillDir: string,
  tempDir: string,
): Promise<Result<void, Error>> {
  const backupResult = await backupCurrentSkill(shakaHome, name, tempDir);
  if (!backupResult.ok) return backupResult;

  const deployResult = await deploySkillVersion(shakaHome, name, skillDir);
  if (!deployResult.ok) {
    await restoreBackupSkill(shakaHome, name, backupResult.value);
    return deployResult;
  }

  const persistResult = await persistToManifest(shakaHome, name, {
    ...skill,
    version,
  });
  if (!persistResult.ok) {
    await restoreBackupSkill(shakaHome, name, backupResult.value);
    return persistResult;
  }

  return ok(undefined);
}

async function deploySkillVersion(
  shakaHome: string,
  name: string,
  skillDir: string,
): Promise<Result<void, Error>> {
  try {
    await installSkillFiles(skillDir, shakaHome, name);
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

async function backupCurrentSkill(
  shakaHome: string,
  name: string,
  tempDir: string,
): Promise<Result<string | null, Error>> {
  const currentDir = join(shakaHome, "skills", name);
  const exists = await Bun.file(join(currentDir, "SKILL.md")).exists();
  if (!exists) return ok(null);

  const backupDir = join(tempDir, "_backup", name);
  try {
    await mkdir(join(tempDir, "_backup"), { recursive: true });
    await cp(currentDir, backupDir, { recursive: true });
    return ok(backupDir);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

async function restoreBackupSkill(
  shakaHome: string,
  name: string,
  backupDir: string | null,
): Promise<void> {
  if (!backupDir) return;

  const skillDir = join(shakaHome, "skills", name);
  await rm(skillDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(shakaHome, "skills"), { recursive: true }).catch(() => {});
  await cp(backupDir, skillDir, { recursive: true }).catch(() => {});
}
