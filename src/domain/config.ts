/**
 * Shaka configuration types and utilities.
 *
 * The source of truth for default config is defaults/config.json.
 * This file defines the TypeScript interface and validation.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "./result";

export interface ShakaConfig {
  readonly version: string;
  readonly reasoning: {
    readonly enabled: boolean;
  };
  readonly permissions: {
    readonly managed: boolean;
  };
  readonly providers: {
    readonly claude: {
      readonly enabled: boolean;
      readonly summarization_model?: string;
    };
    readonly opencode: {
      readonly enabled: boolean;
      readonly summarization_model?: string;
    };
  };
  readonly assistant: {
    readonly name: string;
  };
  readonly principal: {
    readonly name: string;
  };
}

export function validateConfig(config: unknown): Result<ShakaConfig, Error> {
  if (!config || typeof config !== "object") {
    return err(new Error("Config must be an object"));
  }

  const c = config as Record<string, unknown>;

  if (typeof c.version !== "string") {
    return err(new Error("Config must have version string"));
  }

  if (!c.reasoning || typeof c.reasoning !== "object") {
    return err(new Error("Config must have reasoning section"));
  }

  if (!c.permissions || typeof c.permissions !== "object") {
    return err(new Error("Config must have permissions section"));
  }

  if (!c.providers || typeof c.providers !== "object") {
    return err(new Error("Config must have providers section"));
  }

  if (!c.assistant || typeof c.assistant !== "object") {
    return err(new Error("Config must have assistant section"));
  }

  if (!c.principal || typeof c.principal !== "object") {
    return err(new Error("Config must have principal section"));
  }

  return ok(config as ShakaConfig);
}

export interface EnvVars {
  SHAKA_HOME?: string;
  XDG_CONFIG_HOME?: string;
  HOME?: string;
  USERPROFILE?: string;
}

export function resolveShakaHome(env?: EnvVars): string {
  const e = env ?? process.env;

  // 1. Explicit SHAKA_HOME
  if (e.SHAKA_HOME) {
    return e.SHAKA_HOME;
  }

  // 2. XDG_CONFIG_HOME/shaka
  if (e.XDG_CONFIG_HOME) {
    return join(e.XDG_CONFIG_HOME, "shaka");
  }

  // 3. HOME or USERPROFILE + .config/shaka
  const home = e.HOME || e.USERPROFILE;
  if (home) {
    return join(home, ".config", "shaka");
  }

  // 4. os.homedir() fallback (never throws)
  return join(homedir(), ".config", "shaka");
}

/**
 * Load and validate config from SHAKA_HOME/config.json.
 * Returns the config if valid, or null if file doesn't exist or is invalid.
 */
export async function loadConfig(shakaHome?: string): Promise<ShakaConfig | null> {
  const home = shakaHome ?? resolveShakaHome();
  const configPath = join(home, "config.json");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    const raw = await file.json();
    const result = validateConfig(raw);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

/**
 * Check if running as a subagent (spawned by main agent).
 * Works with both Claude Code and opencode.
 */
export function isSubagent(env: NodeJS.ProcessEnv = process.env): boolean {
  // Claude Code: task agents set CLAUDE_AGENT_TYPE or run in .claude/Agents/
  if (env.CLAUDE_AGENT_TYPE !== undefined) return true;
  if (env.CLAUDE_PROJECT_DIR?.replace(/\\/g, "/").includes("/.claude/Agents/")) return true;

  // opencode: check for subagent indicators
  if (env.OPENCODE_SUBAGENT === "true") return true;
  if (env.OPENCODE_AGENT_ID !== undefined) return true;

  return false;
}

/**
 * Get assistant name from config, with fallback.
 */
export async function getAssistantName(shakaHome?: string): Promise<string> {
  const config = await loadConfig(shakaHome);
  return config?.assistant?.name ?? "Shaka";
}

/**
 * Get principal (user) name from config, with fallback.
 */
export async function getPrincipalName(shakaHome?: string): Promise<string> {
  const config = await loadConfig(shakaHome);
  return config?.principal?.name ?? "User";
}

/**
 * Check if Shaka is managing provider permissions.
 * Defaults to true when config is null (pre-init state).
 */
export function isPermissionsManaged(config: ShakaConfig | null): boolean {
  return config?.permissions.managed !== false;
}

/**
 * Get the model to use for session summarization for a given provider.
 *
 * Per-provider config (providers.claude.summarization_model, etc.):
 *   claude: defaults to "haiku" (cheap/fast)
 *   opencode: defaults to "auto" (use whatever model is configured)
 *
 * - "auto": use whatever model the provider already has configured
 * - "haiku": use Claude Haiku (Claude CLI alias)
 * - "openrouter/anthropic/claude-haiku-4.5": explicit provider/model for opencode
 *
 * Returns undefined when "auto" so inference skips the --model flag entirely.
 */
export async function getSummarizationModel(
  provider: "claude" | "opencode",
  shakaHome?: string,
): Promise<string | undefined> {
  const defaults = { claude: "haiku", opencode: "auto" };
  const config = await loadConfig(shakaHome);
  const model = config?.providers?.[provider]?.summarization_model ?? defaults[provider];
  return model === "auto" ? undefined : model;
}

/**
 * Load a file from SHAKA_HOME with customization override support.
 *
 * For system/ paths: checks customizations/ first, then falls back to system/.
 * For other paths: loads directly.
 *
 * @returns File contents if found, null otherwise
 */
export async function loadShakaFile(
  relativePath: string,
  shakaHome?: string,
): Promise<string | null> {
  const home = shakaHome ?? resolveShakaHome();

  // For system files, check customization override first
  // relativePath uses forward slashes by convention (not OS-native separators)
  if (relativePath.startsWith("system/")) {
    const basename = relativePath.replace("system/", "");
    const customPath = join(home, "customizations", basename);
    const customFile = Bun.file(customPath);
    if (await customFile.exists()) {
      return customFile.text();
    }
  }

  // Load from path as-is
  const fullPath = join(home, relativePath);
  const file = Bun.file(fullPath);
  if (await file.exists()) {
    return file.text();
  }

  return null;
}

/**
 * Ensure config.json has all expected fields.
 * Backfills missing fields with defaults. Called from reload, doctor --fix, update.
 * Returns true if the config was modified.
 */
export async function ensureConfigComplete(shakaHome: string): Promise<boolean> {
  const configPath = join(shakaHome, "config.json");
  const file = Bun.file(configPath);

  if (!(await file.exists())) return false;

  const config = (await file.json()) as Record<string, unknown>;
  let changed = false;

  if (config.permissions === undefined) {
    config.permissions = { managed: true };
    changed = true;
  }

  if (changed) {
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  return changed;
}
