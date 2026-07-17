/**
 * opencode provider configuration.
 * Creates in-process plugin in ~/.config/opencode/plugins/.
 *
 * opencode discovers plugins from two locations:
 *   1. .opencode/plugins/ in the current working directory (project-local)
 *   2. ~/.config/opencode/plugins/ (global)
 *
 * Shaka installs to the global path so the plugin works from any directory.
 *
 * Hooks are discovered from ${shakaHome}/system/hooks/*.ts and ${shakaHome}/customizations/hooks/*.ts
 * The generated plugin calls hooks via subprocess to maintain compatibility.
 */

import { mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "../../domain/result";
import {
  installAssetSymlink,
  installPerSkillSymlinks,
  uninstallAssetSymlink,
  uninstallPerSkillSymlinks,
  verifyAssetSymlink,
  verifyPerSkillSymlinks,
} from "../asset-installer";
import { discoverAllHooks } from "../hook-discovery";
import { OPENCODE_PERMISSION_DEFAULTS, hasExistingOpencodePermissions } from "../permissions";
import { buildToolManifests } from "../tool-manifest";
import type {
  CommandInstallConfig,
  InstallConfig,
  InstallationStatus,
  PermissionMode,
  ProviderConfigurer,
} from "../types";
import {
  checkOpencodeCommands,
  installOpencodeCommands,
  uninstallOpencodeCommands,
} from "./commands";
import { renderOpencodePlugin } from "./plugin-template";
import { validateOpencodePluginSyntax } from "./plugin-validation";

/** Resolve the global opencode config directory (XDG-compliant). */
function defaultOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
}

function tempPluginPath(pluginsDir: string): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(pluginsDir, `.shaka-${process.pid}-${Date.now()}-${nonce}.tmp.ts`);
}

async function writeValidatedPlugin(
  pluginsDir: string,
  pluginPath: string,
  pluginContent: string,
  validateSyntax: typeof validateOpencodePluginSyntax,
): Promise<Result<void, Error>> {
  const tempPath = tempPluginPath(pluginsDir);
  await Bun.write(tempPath, pluginContent);
  let installed = false;
  try {
    const validationResult = await validateSyntax(tempPath);
    if (!validationResult.ok) return validationResult;

    await rename(tempPath, pluginPath);
    installed = true;
    return ok(undefined);
  } finally {
    if (!installed) {
      await unlink(tempPath).catch(() => {});
    }
  }
}

export class OpencodeProviderConfigurer implements ProviderConfigurer {
  readonly name = "opencode" as const;
  readonly label = "opencode";
  readonly skillsDir: string;
  readonly commands = {
    install: (config: CommandInstallConfig) => this.installCommands(config),
  };
  private readonly opencodeConfigDir: string;
  private readonly validatePluginSyntax: typeof validateOpencodePluginSyntax;

  constructor(options?: {
    opencodeConfigDir?: string;
    validatePluginSyntax?: typeof validateOpencodePluginSyntax;
  }) {
    this.opencodeConfigDir = options?.opencodeConfigDir ?? defaultOpencodeConfigDir();
    this.validatePluginSyntax = options?.validatePluginSyntax ?? validateOpencodePluginSyntax;
    this.skillsDir = join(this.opencodeConfigDir, "skills");
  }

  isInstalled(): boolean {
    return Bun.which("opencode") !== null;
  }

  async install(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      const manifests = await buildToolManifests(config.shakaHome);
      const hooks = await discoverAllHooks(config.shakaHome);
      const pluginContent = renderOpencodePlugin(config, hooks, manifests);

      const pluginsDir = join(this.opencodeConfigDir, "plugins");
      await mkdir(pluginsDir, { recursive: true });
      const pluginPath = join(pluginsDir, "shaka.ts");
      const pluginResult = await writeValidatedPlugin(
        pluginsDir,
        pluginPath,
        pluginContent,
        this.validatePluginSyntax,
      );
      if (!pluginResult.ok) return pluginResult;

      // Install agents from defaults/system/agents/
      await installAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.opencodeConfigDir, "agents"),
      );

      // Clean up legacy single-directory symlink (shaka → system/skills/) if present
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.opencodeConfigDir, "skills"),
      );

      // System skills: per-skill symlinks so providers discover each as a direct child
      await installPerSkillSymlinks(
        join(config.shakaHome, "system", "skills"),
        join(this.opencodeConfigDir, "skills"),
      );

      // Installed third-party skills: per-skill symlinks
      const skillsTarget = join(this.opencodeConfigDir, "skills");
      await installPerSkillSymlinks(join(config.shakaHome, "skills"), skillsTarget);

      await this.applyPermissions(config.permissionMode);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private async applyPermissions(mode?: PermissionMode): Promise<void> {
    if (mode === "skip") return;

    const configPath = join(this.opencodeConfigDir, "opencode.json");
    const file = Bun.file(configPath);

    let config: Record<string, unknown> = {};
    if (await file.exists()) {
      config = (await file.json()) as Record<string, unknown>;
    }

    const hasExisting = hasExistingOpencodePermissions(config);

    // "merge" (default): apply defaults only if no permissions exist yet.
    // opencode's simple model (edit/bash) doesn't support union-merge.
    if ((mode ?? "merge") === "merge" && hasExisting) return;

    // "apply" or "merge" with no existing → set defaults
    config.permission = { ...OPENCODE_PERMISSION_DEFAULTS };
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  async uninstall(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      const pluginPath = join(this.opencodeConfigDir, "plugins", "shaka.ts");
      const pluginFile = Bun.file(pluginPath);
      if (await pluginFile.exists()) {
        await unlink(pluginPath);
      }

      // Remove agents and skills installed by shaka
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.opencodeConfigDir, "agents"),
      );
      // Clean up legacy single-directory symlink if present
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.opencodeConfigDir, "skills"),
      );
      // Remove per-skill symlinks for system skills
      await uninstallPerSkillSymlinks(
        join(config.shakaHome, "system", "skills"),
        join(this.opencodeConfigDir, "skills"),
      );
      // Remove installed third-party skill symlinks
      const skillsTarget = join(this.opencodeConfigDir, "skills");
      await uninstallPerSkillSymlinks(join(config.shakaHome, "skills"), skillsTarget);

      // Remove commands
      await this.uninstallCommands(config);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async checkInstallation(config: InstallConfig): Promise<InstallationStatus> {
    const hooks = await this.checkHooks();
    const agents = await verifyAssetSymlink(
      join(config.shakaHome, "system", "agents"),
      join(this.opencodeConfigDir, "agents"),
      "agents",
    );
    const skills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "system", "skills"),
      join(this.opencodeConfigDir, "skills"),
      "system skills",
    );
    const installedSkills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "skills"),
      join(this.opencodeConfigDir, "skills"),
      "installed skills",
    );
    const commands = await this.checkCommands(config);

    return { hooks, agents, skills, installedSkills, commands };
  }

  private async checkHooks(): Promise<{ ok: boolean; issue?: string }> {
    const pluginPath = join(this.opencodeConfigDir, "plugins", "shaka.ts");
    const pluginFile = Bun.file(pluginPath);
    if (!(await pluginFile.exists())) {
      return { ok: false, issue: "shaka.ts plugin not found" };
    }
    return { ok: true };
  }

  async installCommands(config: CommandInstallConfig): Promise<void> {
    await installOpencodeCommands(config, this.opencodeConfigDir);
  }

  private async uninstallCommands(config: InstallConfig): Promise<void> {
    await uninstallOpencodeCommands(config, this.opencodeConfigDir);
  }

  private async checkCommands(config: InstallConfig): Promise<{ ok: boolean; issue?: string }> {
    return checkOpencodeCommands(config, this.opencodeConfigDir);
  }
}
