/**
 * Claude Code provider configuration.
 * Installs hooks in ~/.claude/settings.json, agents in ~/.claude/agents/,
 * skills in ~/.claude/skills/, and commands in ~/.claude/skills/.
 *
 * Hooks are discovered from ${shakaHome}/system/hooks/*.ts and ${shakaHome}/customizations/hooks/*.ts
 * Agents are discovered from ${shakaHome}/system/agents/*.md
 * Skills are discovered from ${shakaHome}/system/skills/
 * Each hook declares its trigger event via: TRIGGER: EventName
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../domain/config";
import { type Result, err, ok } from "../../domain/result";
import { shellQuotePosix } from "../../platform/paths";
import {
  installAssetSymlink,
  installPerSkillSymlinks,
  uninstallAssetSymlink,
  uninstallPerSkillSymlinks,
  verifyAssetSymlink,
  verifyPerSkillSymlinks,
} from "../asset-installer";
import { compileForClaude } from "../command-compiler";
import { type DiscoveredCommand, discoverCommands } from "../command-discovery";
import { type CommandManifest, readManifest } from "../command-manifest";
import {
  type DiscoveredHook,
  type HookEvent,
  SHAKA_TO_CLAUDE_EVENT,
  discoverAllHooks,
} from "../hook-discovery";
import { CLAUDE_PERMISSION_DEFAULTS, mergeClaudePermissions } from "../permissions";
import type {
  CommandInstallConfig,
  InstallConfig,
  InstallationStatus,
  PermissionMode,
  ProviderConfigurer,
} from "../types";

/** Default command runner using Bun.spawn. */
async function defaultRunCommand(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr: stderr.trim() };
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    command: string;
  }>;
}

interface ClaudeSettings {
  hooks?: {
    [key: string]: ClaudeHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Check if a hook entry was installed by Shaka.
 * Identifies Shaka hooks by their command path containing the shaka hooks directory.
 */
function isShakaHookCommand(command: string): boolean {
  const cmd = command.replace(/\\/g, "/");
  return cmd.includes("/system/hooks/") || cmd.includes("/customizations/hooks/");
}

/** Append --provider <name> to all Shaka hook commands in event entries. */
function appendProviderArg(eventHooks: ClaudeHookEntry[], provider: string): void {
  for (const entry of eventHooks) {
    for (const hook of entry.hooks) {
      if (isShakaHookCommand(hook.command)) {
        hook.command += ` --provider ${provider}`;
      }
    }
  }
}

function isShakaHookEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some((h) => isShakaHookCommand(h.command));
}

/**
 * Register hooks for a specific matcher, replacing any existing hooks for that matcher.
 * When matcher is empty, the entry has no matcher field (fires for all events).
 */
function registerHooksForMatcher(
  eventHooks: ClaudeHookEntry[],
  matcher: string,
  hookPaths: string[],
): void {
  if (hookPaths.length === 0) return;

  const hookCommands = hookPaths.map((path) => ({
    type: "command",
    // Claude parses `command` as a shell string. Single-quote the path
    // so neither spaces in $HOME (e.g. /Users/jane doe/) nor shell-active
    // syntax inside the path ($VAR, $(cmd), backticks) gets interpreted
    // — `'\''` is the canonical POSIX way to embed a literal single
    // quote inside single quotes. Hook paths shouldn't contain these in
    // practice, but defending against them is one helper away.
    command: `bun ${shellQuotePosix(path)}`,
  }));

  const existingEntry = eventHooks.find((h) => (matcher ? h.matcher === matcher : !h.matcher));
  if (existingEntry) {
    existingEntry.hooks = hookCommands;
  } else {
    const entry: ClaudeHookEntry = { hooks: hookCommands };
    if (matcher) entry.matcher = matcher;
    eventHooks.push(entry);
  }
}

/**
 * Register hooks with tool-specific matchers (e.g., Bash, Edit).
 * Groups hooks by matcher, then registers each group.
 */
function registerHooksWithMatchers(eventHooks: ClaudeHookEntry[], hooks: DiscoveredHook[]): void {
  // Group hooks by matcher
  const hooksByMatcher = new Map<string, string[]>();
  for (const hook of hooks) {
    for (const matcher of hook.matchers ?? []) {
      const paths = hooksByMatcher.get(matcher) ?? [];
      paths.push(hook.path);
      hooksByMatcher.set(matcher, paths);
    }
  }

  // Register each matcher's hooks
  for (const [matcher, paths] of hooksByMatcher) {
    registerHooksForMatcher(eventHooks, matcher, paths);
  }
}

/**
 * Register hooks without tool-specific matchers.
 * Uses empty matcher ("") to match all events — Claude Code treats
 * empty matcher as "match everything" for any event type.
 */
function registerHooksWithoutMatchers(
  eventHooks: ClaudeHookEntry[],
  hooks: DiscoveredHook[],
): void {
  const paths = hooks.map((h) => h.path);
  registerHooksForMatcher(eventHooks, "", paths);
}

/**
 * Group hooks by their event type.
 */
function groupHooksByEvent(hooks: DiscoveredHook[]): Map<HookEvent, DiscoveredHook[]> {
  const hooksByEvent = new Map<HookEvent, DiscoveredHook[]>();

  for (const hook of hooks) {
    const existing = hooksByEvent.get(hook.event) ?? [];
    existing.push(hook);
    hooksByEvent.set(hook.event, existing);
  }

  return hooksByEvent;
}

export class ClaudeProviderConfigurer implements ProviderConfigurer {
  readonly name = "claude" as const;
  readonly label = "Claude Code";
  readonly skillsDir: string;
  private readonly claudeHome: string;
  private readonly runCommand: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

  constructor(options?: {
    claudeHome?: string;
    runCommand?: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
  }) {
    this.claudeHome = options?.claudeHome ?? join(homedir(), ".claude");
    this.skillsDir = join(this.claudeHome, "skills");
    this.runCommand = options?.runCommand ?? defaultRunCommand;
  }

  isInstalled(): boolean {
    return Bun.which("claude") !== null;
  }

  async install(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      const settings = await this.loadSettings();
      if (!settings.hooks) {
        settings.hooks = {};
      }

      // Remove existing shaka hooks before re-registering (ensures removed hooks are cleaned up)
      for (const eventName of Object.keys(settings.hooks)) {
        const eventHooks = settings.hooks[eventName];
        if (Array.isArray(eventHooks)) {
          settings.hooks[eventName] = eventHooks.filter((h) => !isShakaHookEntry(h));
        }
      }

      const discoveredHooks = await discoverAllHooks(config.shakaHome);
      const hooksByEvent = groupHooksByEvent(discoveredHooks);
      this.registerAllHooks(settings, hooksByEvent);

      this.applyPermissions(settings, config.permissionMode);

      await this.saveSettings(settings);

      // Install agents from defaults/system/agents/
      await installAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.claudeHome, "agents"),
      );

      // Clean up legacy single-directory symlink (shaka → system/skills/) if present
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );

      // System skills: per-skill symlinks so providers discover each as a direct child
      await installPerSkillSymlinks(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );

      // Installed third-party skills: per-skill symlinks
      const skillsTarget = join(this.claudeHome, "skills");
      await installPerSkillSymlinks(join(config.shakaHome, "skills"), skillsTarget);

      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /**
   * Register the Shaka MCP server with Claude Code.
   * Uses `claude mcp add` for correct config format and scope handling.
   * Idempotent — re-adding the same name overwrites the existing entry.
   */
  async registerMcpServer(): Promise<Result<void, Error>> {
    try {
      const { exitCode, stderr } = await this.runCommand([
        "claude",
        "mcp",
        "add",
        "shaka",
        "-s",
        "user",
        "--",
        "shaka",
        "mcp",
        "serve",
      ]);
      if (exitCode !== 0) {
        return err(new Error(`claude mcp add failed (exit ${exitCode}): ${stderr}`));
      }
      return ok(undefined);
    } catch (e) {
      return err(
        new Error(`Failed to register MCP server: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * Unregister the Shaka MCP server from Claude Code.
   */
  async unregisterMcpServer(): Promise<Result<void, Error>> {
    try {
      const { exitCode, stderr } = await this.runCommand([
        "claude",
        "mcp",
        "remove",
        "shaka",
        "-s",
        "user",
      ]);
      // Exit code non-zero is OK if server doesn't exist
      if (exitCode !== 0 && !stderr.includes("not found")) {
        return err(new Error(`claude mcp remove failed (exit ${exitCode}): ${stderr}`));
      }
      return ok(undefined);
    } catch (e) {
      return err(
        new Error(`Failed to unregister MCP server: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  private applyPermissions(settings: ClaudeSettings, mode?: PermissionMode): void {
    if (mode === "skip") return;

    if (mode === "apply") {
      settings.permissions = {
        allow: [...CLAUDE_PERMISSION_DEFAULTS.allow],
        deny: [...CLAUDE_PERMISSION_DEFAULTS.deny],
        ask: [...CLAUDE_PERMISSION_DEFAULTS.ask],
      };
      return;
    }

    // Default and explicit "merge": union-dedupe defaults into existing
    const existing = (settings.permissions ?? {}) as Record<string, string[]>;
    settings.permissions = mergeClaudePermissions({
      allow: existing.allow,
      deny: existing.deny,
      ask: existing.ask,
    });
  }

  private async loadSettings(): Promise<ClaudeSettings> {
    const settingsPath = join(this.claudeHome, "settings.json");
    const file = Bun.file(settingsPath);

    if (await file.exists()) {
      return (await file.json()) as ClaudeSettings;
    }
    return {};
  }

  private async saveSettings(settings: ClaudeSettings): Promise<void> {
    const settingsPath = join(this.claudeHome, "settings.json");
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
  }

  private registerAllHooks(
    settings: ClaudeSettings,
    hooksByEvent: Map<HookEvent, DiscoveredHook[]>,
  ): void {
    const hooks = settings.hooks ?? {};
    settings.hooks = hooks;

    for (const [shakaEvent, discoveredHooks] of hooksByEvent) {
      const claudeEvent = SHAKA_TO_CLAUDE_EVENT[shakaEvent];

      if (!Array.isArray(hooks[claudeEvent])) {
        hooks[claudeEvent] = [];
      }

      const eventHooks = hooks[claudeEvent] as ClaudeHookEntry[];
      const hooksWithMatchers = discoveredHooks.filter((h) => h.matchers && h.matchers.length > 0);
      const hooksWithoutMatchers = discoveredHooks.filter(
        (h) => !h.matchers || h.matchers.length === 0,
      );

      registerHooksWithMatchers(eventHooks, hooksWithMatchers);
      registerHooksWithoutMatchers(eventHooks, hooksWithoutMatchers);

      // session.end hooks get --provider claude so the worker uses the right transcript parser
      if (shakaEvent === "session.end") {
        appendProviderArg(eventHooks, "claude");
      }
    }
  }

  async uninstall(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      const settingsPath = join(this.claudeHome, "settings.json");
      const file = Bun.file(settingsPath);

      if (await file.exists()) {
        const settings = (await file.json()) as ClaudeSettings;

        if (settings.hooks) {
          for (const eventName of Object.keys(settings.hooks)) {
            const eventHooks = settings.hooks[eventName];
            if (Array.isArray(eventHooks)) {
              settings.hooks[eventName] = eventHooks.filter((h) => !isShakaHookEntry(h));
            }
          }
        }

        await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
      }

      // Remove agents and skills installed by shaka
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "agents"),
        join(this.claudeHome, "agents"),
      );
      // Clean up legacy single-directory symlink if present
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );
      // Remove per-skill symlinks for system skills
      await uninstallPerSkillSymlinks(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );
      // Remove installed third-party skill symlinks
      const skillsTarget = join(this.claudeHome, "skills");
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
      join(this.claudeHome, "agents"),
      "agents",
    );
    const skills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "system", "skills"),
      join(this.claudeHome, "skills"),
      "system skills",
    );
    const installedSkills = await verifyPerSkillSymlinks(
      join(config.shakaHome, "skills"),
      join(this.claudeHome, "skills"),
      "installed skills",
    );
    const commands = await this.checkCommands(config);

    return { hooks, agents, skills, installedSkills, commands };
  }

  private async checkHooks(): Promise<{ ok: boolean; issue?: string }> {
    const settingsPath = join(this.claudeHome, "settings.json");
    const file = Bun.file(settingsPath);

    if (!(await file.exists())) {
      return { ok: false, issue: "settings.json not found" };
    }

    try {
      const settings = (await file.json()) as ClaudeSettings;
      const issue = this.findHookIssue(settings);
      return issue ? { ok: false, issue } : { ok: true };
    } catch {
      return { ok: false, issue: "Failed to parse settings.json" };
    }
  }

  private findHookIssue(settings: ClaudeSettings): string | null {
    if (!settings.hooks || typeof settings.hooks !== "object") {
      return "No hooks configured";
    }

    const hasShakaHook = Object.values(settings.hooks).some(
      (eventHooks) => Array.isArray(eventHooks) && eventHooks.some((h) => isShakaHookEntry(h)),
    );

    return hasShakaHook ? null : "No Shaka hooks configured";
  }

  async installCommands(config: CommandInstallConfig): Promise<void> {
    const { commands, manifest } = config;
    const globalSkillsDir = join(this.claudeHome, "skills");

    // Clean previous global commands
    for (const name of manifest.global) {
      await rm(join(globalSkillsDir, name), { recursive: true, force: true });
    }
    // Clean previous scoped commands
    for (const [cwdPath, names] of Object.entries(manifest.scoped)) {
      for (const name of names) {
        await rm(join(cwdPath, ".claude", "skills", name), { recursive: true, force: true });
      }
    }

    const manifestGlobalSet = new Set(manifest.global);

    for (const cmd of commands) {
      if (cmd.cwd) {
        await this.installScopedSkill(cmd, manifest);
      } else {
        await this.installGlobalSkill(cmd, globalSkillsDir, manifestGlobalSet);
      }
    }
  }

  private async installGlobalSkill(
    cmd: DiscoveredCommand,
    skillsDir: string,
    manifestSet: Set<string>,
  ): Promise<void> {
    const targetPath = join(skillsDir, cmd.name);
    if (!manifestSet.has(cmd.name) && (await Bun.file(join(targetPath, "SKILL.md")).exists())) {
      console.error(
        `  ⚠ Skipped "${cmd.name}" — pre-existing skill found at ${targetPath}/\n    To let Shaka manage it, remove the existing skill first, then run shaka reload.`,
      );
      return;
    }

    const compiled = compileForClaude(cmd, skillsDir);
    await mkdir(join(skillsDir, cmd.name), { recursive: true });
    await Bun.write(compiled.path, compiled.content);
  }

  private async installScopedSkill(
    cmd: DiscoveredCommand,
    manifest: CommandManifest,
  ): Promise<void> {
    for (const cwdPath of cmd.cwd ?? []) {
      const dirExists = await stat(cwdPath)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirExists) {
        console.error(`  ⚠ Skipped "${cmd.name}" at ${cwdPath} — directory does not exist`);
        continue;
      }

      const skillsDir = join(cwdPath, ".claude", "skills");
      const targetPath = join(skillsDir, cmd.name);
      const previousScoped = new Set(manifest.scoped[cwdPath] ?? []);

      if (
        !previousScoped.has(cmd.name) &&
        (await Bun.file(join(targetPath, "SKILL.md")).exists())
      ) {
        console.error(
          `  ⚠ Skipped "${cmd.name}" — pre-existing skill found at ${targetPath}/\n    To let Shaka manage it, remove the existing skill first, then run shaka reload.`,
        );
        continue;
      }

      const compiled = compileForClaude(cmd, skillsDir);
      await mkdir(join(skillsDir, cmd.name), { recursive: true });
      await Bun.write(compiled.path, compiled.content);

      console.log(`  ℹ Installed "${cmd.name}" to ${targetPath}/`);
      console.log(
        `    These are generated files. Consider adding .claude/skills/${cmd.name}/ to .gitignore`,
      );
    }
  }

  private async uninstallCommands(config: InstallConfig): Promise<void> {
    const skillsDir = join(this.claudeHome, "skills");
    const manifest = await readManifest(config.shakaHome);

    for (const name of manifest.global) {
      await rm(join(skillsDir, name), { recursive: true, force: true });
    }
    for (const [cwdPath, names] of Object.entries(manifest.scoped)) {
      for (const name of names) {
        await rm(join(cwdPath, ".claude", "skills", name), { recursive: true, force: true });
      }
    }
  }

  private async checkCommands(config: InstallConfig): Promise<{ ok: boolean; issue?: string }> {
    const manifest = await readManifest(config.shakaHome);
    const shakaConfig = await loadConfig(config.shakaHome);
    const { commands } = await discoverCommands(config.shakaHome, shakaConfig?.commands?.disabled);

    const isEmpty =
      commands.length === 0 &&
      manifest.global.length === 0 &&
      Object.keys(manifest.scoped).length === 0;
    if (isEmpty) return { ok: true };

    // Scoped commands are excluded — their target directories may not exist yet
    const manifestGlobal = new Set(manifest.global);
    const missing = commands.filter((c) => !c.cwd && !manifestGlobal.has(c.name));
    if (missing.length > 0) {
      return {
        ok: false,
        issue: `${missing.length} command(s) not installed (run shaka reload)`,
      };
    }

    return { ok: true };
  }
}
