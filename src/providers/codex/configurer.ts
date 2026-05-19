/**
 * Codex provider configuration.
 *
 * Codex CLI uses subprocess hooks (JSON stdin/stdout) like Claude Code.
 * Installs hooks in ~/.codex/hooks.json, generates a wrapper script for
 * context injection and subagent detection, symlinks agents and skills.
 *
 * Hooks are discovered from ${shakaHome}/system/hooks/*.ts and ${shakaHome}/customizations/hooks/*.ts
 * Each hook declares its trigger event via: TRIGGER: EventName
 */

import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "../../domain/result";
import {
  installAssetSymlink,
  installPerSkillSymlinks,
  uninstallAssetSymlink,
  uninstallPerSkillSymlinks,
  verifyPerSkillSymlinks,
} from "../asset-installer";
import { discoverAllHooks } from "../hook-discovery";
import type {
  CommandInstallConfig,
  InstallConfig,
  InstallationStatus,
  ProviderConfigurer,
} from "../types";
import { checkAgentTomls, generateAgentTomls, removeAgentTomls } from "./agents";
import {
  type CodexCommandRunner,
  defaultRunCommand,
  enableHooksFeature,
  registerCodexMcpServer,
  unregisterCodexMcpServer,
} from "./cli";
import { checkCodexCommands, installCodexCommands, uninstallCodexCommands } from "./commands";
import {
  renderCodexDebounce,
  renderCodexDebounceWorker,
  renderCodexHooksJson,
  renderCodexWrapper,
} from "./runtime-templates";

export class CodexProviderConfigurer implements ProviderConfigurer {
  readonly name = "codex" as const;
  readonly label = "Codex";
  readonly skillsDir: string;
  readonly commands = {
    install: (config: CommandInstallConfig) => this.installCommands(config),
  };
  private readonly codexHome: string;
  private readonly runCommand: CodexCommandRunner;

  constructor(options?: {
    codexHome?: string;
    skillsDir?: string;
    runCommand?: CodexCommandRunner;
  }) {
    this.codexHome = options?.codexHome ?? join(homedir(), ".codex");
    // Codex uses ~/.agents/skills/ for user-level skills
    this.skillsDir = options?.skillsDir ?? join(homedir(), ".agents", "skills");
    this.runCommand = options?.runCommand ?? defaultRunCommand;
  }

  isInstalled(): boolean {
    return Bun.which("codex") !== null;
  }

  async install(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      // 1. Enable hooks feature flag
      await enableHooksFeature(this.runCommand);

      // 2. Discover hooks and separate session.end for debounce
      await mkdir(this.codexHome, { recursive: true });
      const discoveredHooks = await discoverAllHooks(config.shakaHome);
      const sessionEndHooks = discoveredHooks.filter((h) => h.event === "session.end");

      // 3. Generate hook wrapper script (includes marker deletion for UserPromptSubmit)
      const wrapperPath = join(this.codexHome, "shaka-hook-wrapper.ts");
      await Bun.write(
        wrapperPath,
        renderCodexWrapper(config.shakaHome, sessionEndHooks.length > 0),
      );

      // 4. Generate debounce scripts if session.end hooks exist
      let debouncePath: string | null = null;
      if (sessionEndHooks.length > 0) {
        debouncePath = join(this.codexHome, "shaka-session-debounce.ts");
        const workerPath = join(this.codexHome, "shaka-debounce-worker.ts");
        await Bun.write(debouncePath, renderCodexDebounce(config.shakaHome, workerPath));
        await Bun.write(workerPath, renderCodexDebounceWorker(config.shakaHome, sessionEndHooks));
      }

      // 5. Write hooks.json
      const hooksJson = renderCodexHooksJson(discoveredHooks, wrapperPath, debouncePath);
      await Bun.write(join(this.codexHome, "hooks.json"), JSON.stringify(hooksJson, null, 2));

      // 6. Install agent symlinks (kept for backward compat)
      await installAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.codexHome, "agents"),
      );

      // 7. Generate agent TOML files (Codex agents use TOML, not Markdown)
      await generateAgentTomls(config.shakaHome, this.codexHome);

      // 8. Install skill symlinks (per-skill so providers discover each as a direct child)
      await installPerSkillSymlinks(join(config.shakaHome, "system", "skills"), this.skillsDir);

      // Installed third-party skills: per-skill symlinks
      await installPerSkillSymlinks(join(config.shakaHome, "skills"), this.skillsDir);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Install commands as Codex skills to the provider's skillsDir. */
  async installCommands(config: CommandInstallConfig): Promise<void> {
    await installCodexCommands(config, this.skillsDir);
  }

  private async uninstallCommands(config: InstallConfig): Promise<void> {
    await uninstallCodexCommands(config, this.skillsDir);
  }

  async uninstall(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      // Remove hooks.json
      const hooksPath = join(this.codexHome, "hooks.json");
      await this.removeShakaHooks(hooksPath);

      // Remove wrapper script
      const wrapperPath = join(this.codexHome, "shaka-hook-wrapper.ts");
      if (await Bun.file(wrapperPath).exists()) {
        await unlink(wrapperPath);
      }

      // Remove debounce scripts
      const debouncePath = join(this.codexHome, "shaka-session-debounce.ts");
      if (await Bun.file(debouncePath).exists()) {
        await unlink(debouncePath);
      }
      const debounceWorkerPath = join(this.codexHome, "shaka-debounce-worker.ts");
      if (await Bun.file(debounceWorkerPath).exists()) {
        await unlink(debounceWorkerPath);
      }

      // Remove agent symlinks
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.codexHome, "agents"),
      );

      // Remove generated agent TOML files (only those matching source agents)
      await removeAgentTomls(config.shakaHome, this.codexHome);

      // Remove compiled command skills (installed to skillsDir by installCommands)
      await this.uninstallCommands(config);

      // Remove system skill symlinks
      await uninstallPerSkillSymlinks(join(config.shakaHome, "system", "skills"), this.skillsDir);

      // Remove installed third-party skill symlinks
      await uninstallPerSkillSymlinks(join(config.shakaHome, "skills"), this.skillsDir);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async checkInstallation(config: InstallConfig): Promise<InstallationStatus> {
    const hooks = await this.checkHooks();
    // Agent check: verify TOML files exist for non-hidden agents
    const agents = await checkAgentTomls(config.shakaHome, this.codexHome);
    const skills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "system", "skills"),
      this.skillsDir,
      "system skills",
    );
    const installedSkills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "skills"),
      this.skillsDir,
      "installed skills",
    );
    const commands = await checkCodexCommands(config, this.skillsDir);

    return { hooks, agents, skills, installedSkills, commands };
  }

  /**
   * Remove Shaka-managed hooks from hooks.json, preserving user-added hooks.
   * Shaka hooks are identified by their command containing "shaka" in the path.
   * If only Shaka hooks existed, the file is deleted entirely.
   */
  private async removeShakaHooks(hooksPath: string): Promise<void> {
    const file = Bun.file(hooksPath);
    if (!(await file.exists())) return;

    let config: { hooks: Record<string, unknown[]> };
    try {
      config = (await file.json()) as typeof config;
    } catch {
      await unlink(hooksPath);
      return;
    }

    if (!config.hooks) {
      await unlink(hooksPath);
      return;
    }

    // Filter each event's hook list, keeping only non-shaka entries
    const cleaned: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(config.hooks)) {
      const kept = (entries as Array<{ hooks?: Array<{ command?: string }> }>).filter((entry) => {
        const commands = entry.hooks ?? [];
        // Shaka hooks reference the wrapper or debounce scripts in ~/.codex/
        return !commands.some(
          (h) =>
            h.command?.includes("shaka-hook-wrapper") ||
            h.command?.includes("shaka-session-debounce"),
        );
      });
      if (kept.length > 0) {
        cleaned[event] = kept;
      }
    }

    if (Object.keys(cleaned).length === 0) {
      await unlink(hooksPath);
    } else {
      await Bun.write(hooksPath, JSON.stringify({ hooks: cleaned }, null, 2));
    }
  }

  private async checkHooks(): Promise<{ ok: boolean; issue?: string }> {
    // Check hooks.json exists and is valid
    const hooksPath = join(this.codexHome, "hooks.json");
    const hooksFile = Bun.file(hooksPath);

    if (!(await hooksFile.exists())) {
      return { ok: false, issue: "hooks.json not found" };
    }

    try {
      const hooksJson = (await hooksFile.json()) as Record<string, unknown>;
      if (!hooksJson.hooks || typeof hooksJson.hooks !== "object") {
        return { ok: false, issue: "hooks.json missing hooks key" };
      }
    } catch {
      return { ok: false, issue: "Failed to parse hooks.json" };
    }

    // Check wrapper script exists
    const wrapperPath = join(this.codexHome, "shaka-hook-wrapper.ts");
    if (!(await Bun.file(wrapperPath).exists())) {
      return { ok: false, issue: "shaka-hook-wrapper.ts not found" };
    }

    return { ok: true };
  }

  /**
   * Register the Shaka MCP server with Codex.
   * Uses `codex mcp add` for correct config format.
   * Idempotent — re-adding the same name overwrites the existing entry.
   */
  async registerMcpServer(): Promise<Result<void, Error>> {
    return registerCodexMcpServer(this.runCommand);
  }

  /**
   * Unregister the Shaka MCP server from Codex.
   */
  async unregisterMcpServer(): Promise<Result<void, Error>> {
    return unregisterCodexMcpServer(this.runCommand);
  }
}
