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

import { mkdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../domain/config";
import { type Result, err, ok } from "../../domain/result";
import {
  installAssetSymlink,
  installPerSkillSymlinks,
  uninstallAssetSymlink,
  uninstallPerSkillSymlinks,
  verifyAssetSymlink,
  verifyPerSkillSymlinks,
} from "../asset-installer";
import { compileForOpencode } from "../command-compiler";
import { type DiscoveredCommand, discoverCommands } from "../command-discovery";
import { type CommandManifest, readManifest } from "../command-manifest";
import { type DiscoveredHook, discoverAllHooks } from "../hook-discovery";
import { OPENCODE_PERMISSION_DEFAULTS, hasExistingOpencodePermissions } from "../permissions";
import type {
  CommandInstallConfig,
  InstallConfig,
  InstallationStatus,
  PermissionMode,
  ProviderConfigurer,
} from "../types";

/** Resolve the global opencode config directory (XDG-compliant). */
function defaultOpencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
}

export class OpencodeProviderConfigurer implements ProviderConfigurer {
  readonly name = "opencode" as const;
  readonly label = "opencode";
  readonly skillsDir: string;
  private readonly opencodeConfigDir: string;

  constructor(options?: { opencodeConfigDir?: string }) {
    this.opencodeConfigDir = options?.opencodeConfigDir ?? defaultOpencodeConfigDir();
    this.skillsDir = join(this.opencodeConfigDir, "skills");
  }

  isInstalled(): boolean {
    return Bun.which("opencode") !== null;
  }

  async install(config: InstallConfig): Promise<Result<void, Error>> {
    try {
      const pluginsDir = join(this.opencodeConfigDir, "plugins");
      await mkdir(pluginsDir, { recursive: true });

      // Discover hooks from system/ and customizations/
      const hooks = await discoverAllHooks(config.shakaHome);

      // Generate plugin
      const pluginPath = join(pluginsDir, "shaka.ts");
      const pluginContent = this.generatePluginContent(config, hooks);
      await Bun.write(pluginPath, pluginContent);

      // Validate generated plugin compiles
      const validationResult = await this.validatePluginSyntax(pluginPath);
      if (!validationResult.ok) {
        await unlink(pluginPath);
        return validationResult;
      }

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

  private async validatePluginSyntax(pluginPath: string): Promise<Result<void, Error>> {
    const result = await Bun.build({
      entrypoints: [pluginPath],
      throw: false,
    });

    if (!result.success) {
      const errors = result.logs
        .filter((log) => log.level === "error")
        .map((log) => log.message)
        .join("\n");
      return err(new Error(`Generated plugin has syntax errors:\n${errors}`));
    }

    return ok(undefined);
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

  private generatePluginContent(config: InstallConfig, hooks: DiscoveredHook[]): string {
    // Group hooks by Shaka canonical event names
    const sessionStartHooks = hooks.filter((h) => h.event === "session.start");
    const sessionEndHooks = hooks.filter((h) => h.event === "session.end");
    const userPromptHooks = hooks.filter((h) => h.event === "prompt.submit");
    const preToolHooks = hooks.filter((h) => h.event === "tool.before");
    const postToolHooks = hooks.filter((h) => h.event === "tool.after");

    // Build matcher map for tool hooks: { hookPath: matchers[] | null }
    const toolHookMatchers = preToolHooks.map((h) => ({
      path: h.path,
      matchers: h.matchers ?? null,
    }));

    return `/**
 * Shaka plugin for opencode.
 * Auto-generated - do not edit manually.
 *
 * Discovered hooks:
${hooks.map((h) => ` *   - ${h.filename} (${h.event}${h.matchers ? `, matchers: ${h.matchers.join(", ")}` : ""})`).join("\n")}
 */

const SHAKA_HOME = ${JSON.stringify(config.shakaHome)};
const IDLE_SUMMARY_DELAY = 15_000;

interface ClaudeHookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface ClaudeHookOutput {
  continue?: boolean;
  decision?: "ask";
  message?: string;
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

interface ToolHookConfig {
  path: string;
  matchers: string[] | null;
}

const TOOL_HOOKS: ToolHookConfig[] = ${JSON.stringify(toolHookMatchers, null, 2)};

/**
 * Normalize opencode tool names/args to Claude Code format.
 * opencode uses lowercase tool names and camelCase args;
 * Claude Code hooks expect PascalCase names and snake_case args.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

const ARGS_KEY_MAP: Record<string, Record<string, string>> = {
  read: { filePath: "file_path" },
  write: { filePath: "file_path", content: "content" },
  edit: { filePath: "file_path" },
  bash: { command: "command" },
};

function normalizeToolName(opencodeName: string): string {
  return TOOL_NAME_MAP[opencodeName] || opencodeName;
}

function normalizeArgs(opencodeTool: string, args: Record<string, unknown>): Record<string, unknown> {
  const keyMap = ARGS_KEY_MAP[opencodeTool];
  if (!keyMap) return args;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[keyMap[key] || key] = value;
  }
  return normalized;
}

/**
 * Run a hook script and capture its output.
 * Returns { exitCode, output } for proper handling.
 */
async function runHookRaw(hookPath: string, input: unknown = {}): Promise<{ exitCode: number; output: ClaudeHookOutput | null; rawOutput: string }> {
  try {
    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    // Try to parse as JSON; hooks may output plain text instead
    let output: ClaudeHookOutput | null = null;
    try {
      output = JSON.parse(stdout.trim()) as ClaudeHookOutput;
    } catch {
      // Not JSON — plain text output, available via rawOutput
    }

    return { exitCode, output, rawOutput: stdout.trim() };
  } catch (error) {
    console.error(\`[shaka] Error running hook \${hookPath}:\`, error);
    return { exitCode: 1, output: null, rawOutput: "" };
  }
}

/**
 * Check if a hook should run for a given tool.
 * Hooks without matchers run for all tools.
 * Hooks with matchers only run for matching tools.
 */
function shouldRunForTool(hook: ToolHookConfig, toolName: string): boolean {
  if (!hook.matchers) return true;
  return hook.matchers.includes(toolName);
}

/**
 * Shaka plugin entry point.
 * opencode calls this function once at load time;
 * it must return a Hooks object.
 */
export const ShakaPlugin = async (ctx: { directory: string; [key: string]: unknown }) => {
  // Session start context (loaded once at plugin init)
  let sessionContext: string | null = null;
  let sessionId = \`opencode-\${Date.now()}\`;
${sessionEndHooks.length > 0 ? "  let idleTimer: Timer | null = null;" : ""}

${
  sessionStartHooks.length > 0
    ? `
  // Load session context from SessionStart hooks
  const sessionHooks = ${JSON.stringify(sessionStartHooks.map((h) => h.path))};
  const contextParts: string[] = [];

  for (const hookPath of sessionHooks) {
    const { output, rawOutput } = await runHookRaw(hookPath);
    if (output?.hookSpecificOutput?.additionalContext) {
      contextParts.push(output.hookSpecificOutput.additionalContext);
    } else if (rawOutput) {
      contextParts.push(rawOutput);
    }
  }

  sessionContext = contextParts.join("\\n\\n");
  if (sessionContext) {
    console.error("[shaka] Session context loaded");
  }
`
    : "  // No SessionStart hooks discovered"
}

  return {
${
  userPromptHooks.length > 0 || sessionStartHooks.length > 0
    ? `
    // Context injection
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; [key: string]: unknown },
      output: { system: string[] }
    ) => {
      // Add session context if available
      if (sessionContext) {
        output.system.push(sessionContext);
      }

      ${
        userPromptHooks.length > 0
          ? `
      // Run UserPromptSubmit hooks
      const hooks = ${JSON.stringify(userPromptHooks.map((h) => h.path))};
      for (const hookPath of hooks) {
        const { output: hookOutput, rawOutput } = await runHookRaw(hookPath, input);
        if (hookOutput?.hookSpecificOutput?.additionalContext) {
          output.system.push(hookOutput.hookSpecificOutput.additionalContext);
        } else if (rawOutput) {
          output.system.push(rawOutput);
        }
      }
      `
          : ""
      }
    },
`
    : ""
}

${
  preToolHooks.length > 0
    ? `
    // Tool execution hooks with matcher filtering and format normalization
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      const claudeToolName = normalizeToolName(input.tool);
      const claudeArgs = normalizeArgs(input.tool, output.args);

      // Normalize opencode format → Claude Code format
      const claudeInput: ClaudeHookInput = {
        session_id: input.sessionID || sessionId,
        tool_name: claudeToolName,
        tool_input: claudeArgs,
      };

      for (const hook of TOOL_HOOKS) {
        // Filter by matcher (using normalized Claude Code tool name)
        if (!shouldRunForTool(hook, claudeToolName)) continue;

        const { exitCode, output: hookOutput } = await runHookRaw(hook.path, claudeInput);

        // Handle Claude Code output format → opencode format
        // exit(2) = hard block — throw to abort tool execution
        if (exitCode === 2) {
          throw new Error("[SHAKA SECURITY] Operation blocked by security policy");
        }

        // { decision: "ask" } = confirm (log warning, let opencode's permission system handle)
        if (hookOutput?.decision === "ask") {
          console.error(\`[SHAKA SECURITY] Warning: \${hookOutput.message || "Operation flagged for review"}\`);
          // Don't abort - let opencode's native permission system prompt if configured
        }

        // { continue: true } = allow, keep going
        // null/error = fail open, keep going
      }
    },
`
    : ""
}

${
  postToolHooks.length > 0
    ? `
    // Post-tool execution hooks
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      const claudeToolName = normalizeToolName(input.tool);
      const claudeArgs = normalizeArgs(input.tool, output.args);

      const claudeInput: ClaudeHookInput = {
        session_id: input.sessionID || sessionId,
        tool_name: claudeToolName,
        tool_input: claudeArgs,
      };

      const postToolHookPaths = ${JSON.stringify(postToolHooks.map((h) => h.path))};
      for (const hookPath of postToolHookPaths) {
        await runHookRaw(hookPath, claudeInput);
      }
    },
`
    : ""
}

${
  sessionEndHooks.length > 0
    ? `
    // Catch-all event handler for session lifecycle
    // session.created: capture session ID, cancel pending timer
    // session.idle: start debounce timer — run session-end hooks after IDLE_SUMMARY_DELAY
    // session.status:busy: cancel timer — user is still active
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info as { id?: string } | undefined;
        sessionId = info?.id ?? sessionId;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }

      if (event.type === "session.status") {
        const status = event.properties?.status as { type?: string } | undefined;
        if (status?.type === "busy" && idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
          // Timer cancelled — user resumed activity
        }
      }

      if (event.type === "session.idle") {
        // Cancel any previous timer (multiple idles can fire)
        if (idleTimer) clearTimeout(idleTimer);

        // Start debounce timer — if user stays idle, run session-end hooks
        idleTimer = setTimeout(async () => {
          idleTimer = null;

          const sessionEndHookPaths = ${JSON.stringify(sessionEndHooks.map((h) => h.path))};
          for (const hookPath of sessionEndHookPaths) {
            try {
              await runHookRaw(hookPath, {
                session_id: sessionId,
                reason: "idle",
                cwd: ctx.directory,
                provider: "opencode",
              });
            } catch (e) {
              console.error(\`[shaka] Session-end hook error: \${e instanceof Error ? e.message : String(e)}\`);
            }
          }
        }, IDLE_SUMMARY_DELAY);
      }
    },
`
    : ""
}
  };
};
`;
  }

  async installCommands(config: CommandInstallConfig): Promise<void> {
    const { commands, manifest } = config;
    const globalCommandsDir = join(this.opencodeConfigDir, "commands");
    await mkdir(globalCommandsDir, { recursive: true });

    // Clean previous global commands
    for (const name of manifest.global) {
      await rm(join(globalCommandsDir, `${name}.md`), { force: true });
    }
    // Clean previous scoped commands
    for (const [cwdPath, names] of Object.entries(manifest.scoped)) {
      for (const name of names) {
        await rm(join(cwdPath, ".opencode", "commands", `${name}.md`), { force: true });
      }
    }

    const manifestGlobalSet = new Set(manifest.global);

    for (const cmd of commands) {
      if (cmd.cwd) {
        await this.installScopedCommand(cmd, manifest);
      } else {
        await this.installGlobalCommand(cmd, globalCommandsDir, manifestGlobalSet);
      }
    }
  }

  private async installGlobalCommand(
    cmd: DiscoveredCommand,
    commandsDir: string,
    manifestSet: Set<string>,
  ): Promise<void> {
    const targetPath = join(commandsDir, `${cmd.name}.md`);
    if (!manifestSet.has(cmd.name) && (await Bun.file(targetPath).exists())) {
      console.error(
        `  ⚠ Skipped "${cmd.name}" — pre-existing command found at ${targetPath}\n    To let Shaka manage it, remove the existing command first, then run shaka reload.`,
      );
      return;
    }

    const compiled = compileForOpencode(cmd, commandsDir);
    await Bun.write(compiled.path, compiled.content);
  }

  private async installScopedCommand(
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

      const commandsDir = join(cwdPath, ".opencode", "commands");
      const targetPath = join(commandsDir, `${cmd.name}.md`);
      const previousScoped = new Set(manifest.scoped[cwdPath] ?? []);

      if (!previousScoped.has(cmd.name) && (await Bun.file(targetPath).exists())) {
        console.error(
          `  ⚠ Skipped "${cmd.name}" — pre-existing command found at ${targetPath}\n    To let Shaka manage it, remove the existing command first, then run shaka reload.`,
        );
        continue;
      }

      const compiled = compileForOpencode(cmd, commandsDir);
      await mkdir(commandsDir, { recursive: true });
      await Bun.write(compiled.path, compiled.content);

      console.log(`  ℹ Installed "${cmd.name}" to ${targetPath}`);
      console.log(
        `    These are generated files. Consider adding .opencode/commands/${cmd.name}.md to .gitignore`,
      );
    }
  }

  private async uninstallCommands(config: InstallConfig): Promise<void> {
    const commandsDir = join(this.opencodeConfigDir, "commands");
    const manifest = await readManifest(config.shakaHome);

    for (const name of manifest.global) {
      await rm(join(commandsDir, `${name}.md`), { force: true });
    }
    for (const [cwdPath, names] of Object.entries(manifest.scoped)) {
      for (const name of names) {
        await rm(join(cwdPath, ".opencode", "commands", `${name}.md`), { force: true });
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
