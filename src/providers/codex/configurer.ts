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

import { mkdir, rename, unlink } from "node:fs/promises";
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

interface CodexHookHandler {
  command?: unknown;
}

interface CodexHookEntry {
  hooks: CodexHookHandler[];
  matcher?: unknown;
}

interface CodexHooksConfig {
  hooks: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShakaHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (command.includes("shaka-hook-wrapper") || command.includes("shaka-session-debounce"))
  );
}

function parseHookEntries(event: string, value: unknown): CodexHookEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Codex hooks.json event ${JSON.stringify(event)} must contain an array`);
  }

  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.hooks) ||
      !entry.hooks.every((hook) => isRecord(hook))
    ) {
      throw new Error(`Codex hooks.json event ${JSON.stringify(event)} contains an invalid entry`);
    }
    return { ...entry, hooks: entry.hooks } as CodexHookEntry;
  });
}

function withoutShakaHooks(hooks: Record<string, unknown>): Record<string, CodexHookEntry[]> {
  const cleaned: Record<string, CodexHookEntry[]> = {};

  for (const [event, value] of Object.entries(hooks)) {
    const entries = parseHookEntries(event, value)
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((hook) => !isShakaHookCommand(hook.command)),
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (entries.length > 0) cleaned[event] = entries;
  }

  return cleaned;
}

async function loadHooksConfig(hooksPath: string): Promise<CodexHooksConfig> {
  const file = Bun.file(hooksPath);
  if (!(await file.exists())) return { hooks: {} };

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update invalid Codex hooks.json: ${cause}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Cannot update invalid Codex hooks.json: expected an object");
  }
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    throw new Error("Cannot update invalid Codex hooks.json: hooks must be an object");
  }

  return {
    ...parsed,
    hooks: withoutShakaHooks((parsed.hooks as Record<string, unknown> | undefined) ?? {}),
  };
}

function mergeHooksConfig(
  existing: CodexHooksConfig,
  generated: { hooks: Record<string, CodexHookEntry[]> },
): CodexHooksConfig {
  const hooks = { ...existing.hooks };
  for (const [event, entries] of Object.entries(generated.hooks)) {
    hooks[event] = [...(hooks[event] ?? []), ...entries];
  }
  return { ...existing, hooks };
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const tempPath = `${path}.shaka-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await Bun.write(tempPath, content);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

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

      const hooksPath = join(this.codexHome, "hooks.json");
      const wrapperPath = join(this.codexHome, "shaka-hook-wrapper.ts");
      const debouncePath =
        sessionEndHooks.length > 0 ? join(this.codexHome, "shaka-session-debounce.ts") : null;
      const hooksJson = mergeHooksConfig(
        await loadHooksConfig(hooksPath),
        renderCodexHooksJson(discoveredHooks, wrapperPath, debouncePath),
      );

      // 3. Generate hook wrapper script (includes marker deletion for UserPromptSubmit)
      await writeAtomically(
        wrapperPath,
        renderCodexWrapper(config.shakaHome, sessionEndHooks.length > 0),
      );

      // 4. Generate debounce scripts if session.end hooks exist
      if (debouncePath) {
        const workerPath = join(this.codexHome, "shaka-debounce-worker.ts");
        await writeAtomically(debouncePath, renderCodexDebounce(config.shakaHome, workerPath));
        await writeAtomically(
          workerPath,
          renderCodexDebounceWorker(config.shakaHome, sessionEndHooks),
        );
      }

      // 5. Write hooks.json
      await writeAtomically(hooksPath, JSON.stringify(hooksJson, null, 2));

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
   * Shaka hooks are identified by their generated wrapper or debounce command.
   * If only Shaka hooks existed, the file is deleted entirely.
   */
  private async removeShakaHooks(hooksPath: string): Promise<void> {
    const file = Bun.file(hooksPath);
    if (!(await file.exists())) return;

    const config = await loadHooksConfig(hooksPath);
    const hasOtherConfig = Object.keys(config).some((key) => key !== "hooks");

    if (Object.keys(config.hooks).length === 0 && !hasOtherConfig) {
      await unlink(hooksPath);
    } else {
      await writeAtomically(hooksPath, JSON.stringify(config, null, 2));
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
