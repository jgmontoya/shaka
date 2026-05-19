/**
 * Pi provider configuration.
 *
 * Pi (`@earendil-works/pi-coding-agent`) integrates via a generated extension
 * at `~/.pi/agent/extensions/shaka.ts` (rendered from `defaults/pi/extension.ts`
 * with install-time substitutions) and per-skill symlinks under
 * `~/.pi/agent/skills/`. The extension shells out to `shaka hook <event>` for
 * hook execution; Pi sees Shaka as a single bridge file plus a registry of
 * `shaka-`-prefixed resources.
 *
 * Empirical sources for every behaviour decision: `experiments/{42..51}-pi-*`
 * (gitignored), summarised in pi.md and the project's reference memory.
 *
 * Shipped surface: extension generation + smoke-load gate, system + installed
 * skill symlinks, agent-as-skill translation (`shaka-agent-<name>`), Pi
 * prompt-template compilation, idempotent install/uninstall with user-file
 * preservation, native `pi.registerTool()` bridge for `inference` and
 * `memory-search`.
 */

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "../../domain/result";
import { resolveFromModule } from "../../platform/paths";
import { installAssetSymlink, verifyAssetSymlink } from "../asset-installer";
import type {
  CommandInstallConfig,
  InstallConfig,
  InstallationStatus,
  ProviderConfigurer,
} from "../types";
import { checkPiCommands, installPiCommands, uninstallPiCommands } from "./commands";
import { checkPiHealth } from "./health";
import { type SmokeLoadRunner, defaultSmokeLoadRunner } from "./smoke-load";

/** Source of truth for the generated Pi extension template. */
const EXTENSION_TEMPLATE_PATH = resolveFromModule(
  import.meta.url,
  "../../../defaults/pi/extension.ts",
);

/** Marker the install writes and uninstall reads to identify Shaka-managed files. */
const EXTENSION_MARKER = "SHAKA_GENERATED_EXTENSION";

/** Smoke-load gate signal emitted by Pi on a broken extension (Exp 44). */
const PI_LOAD_FAILURE_MARKER = "Failed to load extension";
const SHAKA_HOME_PLACEHOLDER = "__SHAKA_INSTALLED_HOME__";

/**
 * Pi auto-discovers skills from `~/.agents/skills/` regardless of
 * `PI_CODING_AGENT_DIR` (Exp 47). Every Shaka-managed skill carries this
 * prefix in Pi's view to keep its model registry free of name collisions
 * with ambient user skills.
 */
const SHAKA_SKILL_PREFIX = "shaka-";

interface PiRollbackSnapshot {
  extensionContent: string | null;
  backupDir: string;
  skillsBackupDir: string;
  skillEntries: Array<
    { name: string; type: "copy" } | { name: string; type: "symlink"; target: string }
  >;
}

export class PiProviderConfigurer implements ProviderConfigurer {
  readonly name = "pi" as const;
  readonly label = "Pi";
  readonly skillsDir: string;
  readonly commands = {
    install: (config: CommandInstallConfig) => this.installCommands(config),
  };
  private readonly piHome: string;
  private readonly runSmokeLoad: SmokeLoadRunner;
  private readonly extensionTemplatePath: string;

  constructor(options?: {
    piHome?: string;
    skillsDir?: string;
    runSmokeLoad?: SmokeLoadRunner;
    extensionTemplatePath?: string;
  }) {
    this.piHome =
      options?.piHome ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    this.skillsDir = options?.skillsDir ?? join(this.piHome, "skills");
    this.runSmokeLoad = options?.runSmokeLoad ?? defaultSmokeLoadRunner;
    this.extensionTemplatePath = options?.extensionTemplatePath ?? EXTENSION_TEMPLATE_PATH;
  }

  isInstalled(): boolean {
    return Bun.which("pi") !== null;
  }

  checkHealth() {
    return checkPiHealth(this.piHome);
  }

  async install(config: InstallConfig): Promise<Result<void, Error>> {
    let extensionInstalled = false;
    let rollbackSnapshot: PiRollbackSnapshot | undefined;
    try {
      rollbackSnapshot = await this.captureRollbackSnapshot();
      await this.installExtension(config.shakaHome);
      extensionInstalled = true;
      const smokeLoadError = await this.smokeLoadExtension();
      if (smokeLoadError) throw smokeLoadError;
      await this.syncPrefixedSkills([
        join(config.shakaHome, "system", "skills"),
        join(config.shakaHome, "skills"),
      ]);
      await this.installAgentSkills(join(config.shakaHome, "system", "agents"));
      await this.discardRollbackSnapshot(rollbackSnapshot);
      return ok(undefined);
    } catch (e) {
      // Atomicity: any post-extension failure restores the pre-install
      // extension and shaka-* skill state, so a failed reinstall doesn't
      // wipe the last known-good Pi integration. Covers all three failure
      // shapes uniformly: smoke-load returns an error, smoke-load throws,
      // or skill installation throws.
      if (extensionInstalled && rollbackSnapshot) {
        await this.rollbackInstall(rollbackSnapshot);
      } else if (rollbackSnapshot) {
        await this.discardRollbackSnapshot(rollbackSnapshot);
      }
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async rollbackInstall(snapshot: PiRollbackSnapshot): Promise<void> {
    try {
      await this.restoreExtensionSnapshot(snapshot.extensionContent);
      await this.restoreSkillsSnapshot(snapshot);
    } catch {
      // Best-effort rollback — preserve the original install failure.
    } finally {
      await this.discardRollbackSnapshot(snapshot);
    }
  }

  private async captureRollbackSnapshot(): Promise<PiRollbackSnapshot> {
    const backupDir = await mkdtemp(join(tmpdir(), "shaka-pi-rollback-"));
    const skillsBackupDir = join(backupDir, "skills");
    const extensionPath = join(this.piHome, "extensions", "shaka.ts");
    const extension = Bun.file(extensionPath);
    const extensionContent = (await extension.exists()) ? await extension.text() : null;
    const skillEntries: PiRollbackSnapshot["skillEntries"] = [];

    if (await directoryExists(this.skillsDir)) {
      await mkdir(skillsBackupDir, { recursive: true });
      const entries = await readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith(SHAKA_SKILL_PREFIX)) continue;
        const source = join(this.skillsDir, entry.name);
        if (await isSymlink(source)) {
          skillEntries.push({ name: entry.name, type: "symlink", target: await readlink(source) });
          continue;
        }
        await cp(source, join(skillsBackupDir, entry.name), {
          recursive: entry.isDirectory(),
          force: true,
          verbatimSymlinks: true,
        });
        skillEntries.push({ name: entry.name, type: "copy" });
      }
    }

    return { extensionContent, backupDir, skillsBackupDir, skillEntries };
  }

  private async restoreExtensionSnapshot(content: string | null): Promise<void> {
    const extensionPath = join(this.piHome, "extensions", "shaka.ts");
    if (content === null) {
      await rm(extensionPath, { force: true });
      return;
    }
    await mkdir(join(this.piHome, "extensions"), { recursive: true });
    await Bun.write(extensionPath, content);
  }

  private async restoreSkillsSnapshot(snapshot: PiRollbackSnapshot): Promise<void> {
    if (!(await directoryExists(this.skillsDir)) && snapshot.skillEntries.length === 0) return;
    await mkdir(this.skillsDir, { recursive: true });

    const current = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of current) {
      if (!entry.name.startsWith(SHAKA_SKILL_PREFIX)) continue;
      await rm(join(this.skillsDir, entry.name), { recursive: true, force: true });
    }

    for (const entry of snapshot.skillEntries) {
      const destination = join(this.skillsDir, entry.name);
      if (entry.type === "symlink") {
        await symlink(entry.target, destination, "junction");
      } else {
        await cp(join(snapshot.skillsBackupDir, entry.name), destination, {
          recursive: true,
          force: true,
          verbatimSymlinks: true,
        });
      }
    }
  }

  private async discardRollbackSnapshot(snapshot: PiRollbackSnapshot): Promise<void> {
    try {
      await rm(snapshot.backupDir, { recursive: true, force: true });
    } catch {
      // Snapshot cleanup is best-effort; it must not mask install outcome.
    }
  }

  /**
   * Verify Pi can load the freshly written extension. Returns null on success
   * (or skip), an Error when Pi reports `Failed to load extension`. Pi's
   * stderr contains the offending path + parse/import message verbatim
   * (Exp 44), which we surface to the caller for diagnosis.
   */
  private async smokeLoadExtension(): Promise<Error | null> {
    const result = await this.runSmokeLoad(this.piHome);
    if (result.stderr.includes(PI_LOAD_FAILURE_MARKER)) {
      return new Error(`Pi rejected the generated extension: ${result.stderr.trim()}`);
    }
    // `runProcessWithTimeout` surfaces hangs and crashes via exitCode !== 0
    // without the load-failure marker. Treat any non-zero exit as a failed
    // gate so a hung Pi never leaves a half-installed extension on disk.
    if (result.exitCode !== 0) {
      return new Error(result.stderr.trim() || `Pi smoke-load exited with code ${result.exitCode}`);
    }
    return null;
  }

  private async installExtension(shakaHome: string): Promise<void> {
    const extensionPath = join(this.piHome, "extensions", "shaka.ts");
    await mkdir(join(this.piHome, "extensions"), { recursive: true });
    // Refuse to clobber a user-owned extension at the same path.
    // `uninstallExtension` is gated on the SHAKA_GENERATED_EXTENSION
    // marker, so an unconditional overwrite here would lose user data
    // permanently — install replaces, uninstall doesn't restore.
    const existing = Bun.file(extensionPath);
    if (await existing.exists()) {
      const content = await existing.text();
      if (!content.includes(EXTENSION_MARKER)) {
        throw new Error(
          `Refusing to overwrite non-Shaka Pi extension at ${extensionPath}. Move it aside and re-run \`shaka init --pi\`.`,
        );
      }
    }
    const template = await Bun.file(this.extensionTemplatePath).text();
    const placeholderAssignment = `const INSTALLED_SHAKA_HOME = ${JSON.stringify(SHAKA_HOME_PLACEHOLDER)};`;
    if (!template.includes(placeholderAssignment)) {
      throw new Error("Failed to inject install-time SHAKA_HOME into Pi extension template");
    }
    const content = template.replaceAll(
      placeholderAssignment,
      `const INSTALLED_SHAKA_HOME = ${JSON.stringify(shakaHome)};`,
    );
    if (content.includes(placeholderAssignment)) {
      throw new Error("Failed to inject install-time SHAKA_HOME into Pi extension template");
    }
    await Bun.write(extensionPath, content);
  }

  /**
   * Symlink every child of `sourceDirs` into `<piHome>/skills/` with the
   * `shaka-` prefix, and prune any `shaka-*` link from a previous install
   * whose source has since disappeared. Symmetric with the agent-skill
   * pruning at `installAgentSkills`.
   *
   * Sources are unioned because both source trees converge into one
   * `skillsDir`; pruning per-source would have one call delete the other's
   * links. The `shaka-agent-*` namespace is excluded — those are managed
   * separately by `installAgentSkills`.
   */
  private async syncPrefixedSkills(sourceDirs: readonly string[]): Promise<void> {
    const sources = await collectPrefixedSources(sourceDirs);
    assertNoBasenameCollisions(sources);
    const expected = new Set(sources.map(({ name }) => `${SHAKA_SKILL_PREFIX}${name}`));

    await mkdir(this.skillsDir, { recursive: true });
    await this.prunePrefixedSkills(expected);

    for (const { dir, name } of sources) {
      await installAssetSymlink(join(dir, name), this.skillsDir, `${SHAKA_SKILL_PREFIX}${name}`);
    }
  }

  private async prunePrefixedSkills(expected: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!isManagedPrefixedSkill(entry.name)) continue;
      if (expected.has(entry.name)) continue;
      const path = join(this.skillsDir, entry.name);
      // Only ever prune symlinks — `installAssetSymlink` is the sole creator
      // of the entries we manage. A real directory at this path is
      // off-script (manual placement, partial uninstall residue, etc.) and
      // belongs to the user. Mirrors `uninstallPrefixedSkills`.
      if (await isSymlink(path)) await unlink(path);
    }
  }

  /**
   * Pi has no native agent registry; surface each Shaka agent as a skill named
   * `shaka-agent-<name>` so it shows up in Pi's resource list (pi.md Phase 5).
   */
  private async installAgentSkills(agentsDir: string): Promise<void> {
    await mkdir(this.skillsDir, { recursive: true });

    const entries = (await directoryExists(agentsDir))
      ? await readdir(agentsDir, { withFileTypes: true })
      : [];
    const expected = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => `shaka-agent-${entry.name.replace(/\.md$/, "")}`),
    );

    // Prune stale Shaka-prefixed agent dirs from previous installs whose
    // source agent has since been renamed or removed. Scope is strictly
    // `shaka-agent-*`, so user-owned skills at this path are preserved.
    const installed = await readdir(this.skillsDir, { withFileTypes: true });
    for (const dir of installed) {
      if (!dir.isDirectory()) continue;
      if (!dir.name.startsWith("shaka-agent-")) continue;
      if (expected.has(dir.name)) continue;
      await rm(join(this.skillsDir, dir.name), { recursive: true, force: true });
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const agentName = entry.name.replace(/\.md$/, "");
      const skillDir = join(this.skillsDir, `shaka-agent-${agentName}`);
      await mkdir(skillDir, { recursive: true });
      const body = await Bun.file(join(agentsDir, entry.name)).text();
      await Bun.write(join(skillDir, "SKILL.md"), body);
    }
  }

  async installCommands(config: CommandInstallConfig): Promise<void> {
    await installPiCommands(config, this.piHome);
  }

  async uninstall(_config: InstallConfig): Promise<Result<void, Error>> {
    try {
      await this.uninstallExtension();
      await this.uninstallPrefixedSkills();
      await this.uninstallAgentSkills();
      await this.uninstallCommands();
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async uninstallCommands(): Promise<void> {
    await uninstallPiCommands(this.piHome);
  }

  /** Remove the extension only if it carries the Shaka marker (preserves user files at the same path). */
  private async uninstallExtension(): Promise<void> {
    const extensionPath = join(this.piHome, "extensions", "shaka.ts");
    const file = Bun.file(extensionPath);
    if (!(await file.exists())) return;
    const content = await file.text();
    if (!content.includes(EXTENSION_MARKER)) return;
    await rm(extensionPath, { force: true });
  }

  /**
   * Remove translated agent skills (real directories named `shaka-agent-*`).
   * Kept separate from `uninstallPrefixedSkills` because that helper only
   * removes symlinks — agents are real directories we wrote during install.
   */
  private async uninstallAgentSkills(): Promise<void> {
    if (!(await directoryExists(this.skillsDir))) return;
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith("shaka-agent-")) continue;
      if (!entry.isDirectory()) continue;
      await rm(join(this.skillsDir, entry.name), { recursive: true, force: true });
    }
  }

  /**
   * Remove every entry under <piHome>/skills/ whose name starts with `shaka-`
   * AND is a symlink. Real directories at the same path (which we never
   * install except via uninstallAgentSkills above) are left intact —
   * paranoia against an off-script install state.
   */
  private async uninstallPrefixedSkills(): Promise<void> {
    if (!(await directoryExists(this.skillsDir))) return;
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(SHAKA_SKILL_PREFIX)) continue;
      const path = join(this.skillsDir, entry.name);
      if (await isSymlink(path)) {
        await unlink(path);
      }
    }
  }

  async checkInstallation(config: InstallConfig): Promise<InstallationStatus> {
    const systemSkillsDir = join(config.shakaHome, "system", "skills");
    const installedSkillsDir = join(config.shakaHome, "skills");
    const skills = await this.checkPrefixedSkills(systemSkillsDir);
    const installedSkills = await this.checkPrefixedSkills(installedSkillsDir);
    const staleSkills =
      skills.ok && installedSkills.ok
        ? await this.checkStalePrefixedSkills([systemSkillsDir, installedSkillsDir])
        : { ok: true };

    return {
      hooks: await this.checkExtension(),
      agents: await this.checkAgentSkills(join(config.shakaHome, "system", "agents")),
      skills: skills.ok ? staleSkills : skills,
      installedSkills,
      commands: await checkPiCommands(config, this.piHome),
    };
  }

  /**
   * Verify each `<sourceDir>/<name>` has a `<skillsDir>/shaka-<name>`
   * symlink pointing back at it. Reuses the shared verifier so we catch
   * both "missing" and "points at the wrong target" — the latter happens
   * if a user (or partial uninstall) replaces a Shaka link with their own.
   */
  private async checkPrefixedSkills(sourceDir: string): Promise<{ ok: boolean; issue?: string }> {
    if (!(await directoryExists(sourceDir))) return { ok: true };

    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await verifyAssetSymlink(
        join(sourceDir, entry.name),
        this.skillsDir,
        `Pi skill (${entry.name})`,
        `${SHAKA_SKILL_PREFIX}${entry.name}`,
      );
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async checkStalePrefixedSkills(
    sourceDirs: readonly string[],
  ): Promise<{ ok: boolean; issue?: string }> {
    if (!(await directoryExists(this.skillsDir))) return { ok: true };
    const sources = await collectPrefixedSources(sourceDirs);
    const expected = new Set(sources.map(({ name }) => `${SHAKA_SKILL_PREFIX}${name}`));
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!isManagedPrefixedSkill(entry.name)) continue;
      if (expected.has(entry.name)) continue;
      const path = join(this.skillsDir, entry.name);
      if (await isSymlink(path)) {
        return { ok: false, issue: `stale Shaka-managed skill: ${entry.name}` };
      }
    }
    return { ok: true };
  }

  /**
   * Verify each `<agentsDir>/<name>.md` has a `<skillsDir>/shaka-agent-<name>/SKILL.md`
   * file. Agents are installed as real directories (not symlinks) because Pi
   * needs SKILL.md frontmatter, not the agent's raw markdown — see
   * `installAgentSkills`.
   */
  private async checkAgentSkills(agentsDir: string): Promise<{ ok: boolean; issue?: string }> {
    const expected = await this.checkExpectedAgentSkills(agentsDir);
    if (!expected.ok) return expected;
    return this.checkStaleAgentSkills(expected.names);
  }

  private async checkExpectedAgentSkills(
    agentsDir: string,
  ): Promise<{ ok: true; names: Set<string> } | { ok: false; issue: string }> {
    const expected = new Set<string>();
    if (!(await directoryExists(agentsDir))) return { ok: true, names: expected };

    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const agentName = entry.name.replace(/\.md$/, "");
      expected.add(`shaka-agent-${agentName}`);
      const skillFile = join(this.skillsDir, `shaka-agent-${agentName}`, "SKILL.md");
      if (!(await Bun.file(skillFile).exists())) {
        return {
          ok: false,
          issue: `missing agent skill for ${agentName} at ${skillFile}`,
        };
      }
    }

    return { ok: true, names: expected };
  }

  private async checkStaleAgentSkills(
    expected: ReadonlySet<string>,
  ): Promise<{ ok: boolean; issue?: string }> {
    if (!(await directoryExists(this.skillsDir))) return { ok: true };

    const installed = await readdir(this.skillsDir, { withFileTypes: true });
    for (const entry of installed) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("shaka-agent-")) continue;
      if (expected.has(entry.name)) continue;
      return {
        ok: false,
        issue: `stale Shaka-managed agent skill: ${entry.name}`,
      };
    }
    return { ok: true };
  }

  private async checkExtension(): Promise<{ ok: boolean; issue?: string }> {
    const extensionPath = join(this.piHome, "extensions", "shaka.ts");
    const file = Bun.file(extensionPath);
    if (!(await file.exists())) {
      return { ok: false, issue: `Missing ${extensionPath}` };
    }
    const content = await file.text();
    if (!content.includes(EXTENSION_MARKER)) {
      return {
        ok: false,
        issue: `Extension at ${extensionPath} is not Shaka-generated (missing ${EXTENSION_MARKER} marker)`,
      };
    }
    return { ok: true };
  }
}

async function collectPrefixedSources(
  sourceDirs: readonly string[],
): Promise<{ dir: string; name: string }[]> {
  const sources: { dir: string; name: string }[] = [];
  for (const dir of sourceDirs) {
    if (!(await directoryExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) sources.push({ dir, name: entry.name });
    }
  }
  return sources;
}

function isManagedPrefixedSkill(name: string): boolean {
  return name.startsWith(SHAKA_SKILL_PREFIX) && !name.startsWith("shaka-agent-");
}

/**
 * Both source trees converge into a single `shaka-<name>` namespace under
 * Pi's skills dir, so a basename collision would silently shadow one source
 * with the other and leave `checkInstallation` reporting drift on every run.
 * The right override surface is `customizations/skills/<name>`; raw collisions
 * here are misconfigurations, so surface them up front.
 */
function assertNoBasenameCollisions(sources: readonly { dir: string; name: string }[]): void {
  const seen = new Map<string, string>();
  for (const { dir, name } of sources) {
    const previous = seen.get(name);
    if (previous) {
      throw new Error(
        `Pi skill name collision: ${previous} and ${join(dir, name)} both map to ${SHAKA_SKILL_PREFIX}${name}`,
      );
    }
    seen.set(name, join(dir, name));
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}
