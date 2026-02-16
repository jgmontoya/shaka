/**
 * Claude Code provider configuration.
 * Installs hooks in ~/.claude/settings.json, agents in ~/.claude/agents/,
 * and skills in ~/.claude/skills/.
 *
 * Hooks are discovered from ${shakaHome}/system/hooks/*.ts and ${shakaHome}/customizations/hooks/*.ts
 * Agents are discovered from ${shakaHome}/system/agents/*.md
 * Skills are discovered from ${shakaHome}/system/skills/
 * Each hook declares its trigger event via: TRIGGER: EventName
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "../../domain/result";
import { installAssetSymlink, uninstallAssetSymlink, verifyAssetSymlink } from "../asset-installer";
import {
  type DiscoveredHook,
  type HookEvent,
  SHAKA_TO_CLAUDE_EVENT,
  discoverAllHooks,
} from "../hook-discovery";
import { CLAUDE_PERMISSION_DEFAULTS, mergeClaudePermissions } from "../permissions";
import type {
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
function isShakaHookEntry(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some((h) => {
    const cmd = h.command.replace(/\\/g, "/");
    return cmd.includes("/system/hooks/") || cmd.includes("/customizations/hooks/");
  });
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
    command: `bun run ${path}`,
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
  private readonly claudeHome: string;
  private readonly runCommand: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

  constructor(options?: {
    claudeHome?: string;
    runCommand?: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
  }) {
    this.claudeHome = options?.claudeHome ?? join(homedir(), ".claude");
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

      // Install skills from defaults/system/skills/
      await installAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );

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
      await uninstallAssetSymlink(
        join(config.shakaHome, "system", "skills"),
        join(this.claudeHome, "skills"),
      );

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
    const skills = await verifyAssetSymlink(
      join(config.shakaHome, "system", "skills"),
      join(this.claudeHome, "skills"),
      "skills",
    );

    return { hooks, agents, skills };
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
}
