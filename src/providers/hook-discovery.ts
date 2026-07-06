/**
 * Hook discovery utilities.
 * Shared between Claude and opencode configurers.
 *
 * Hooks declare their trigger events by exporting a TRIGGER constant:
 *   export const TRIGGER = ["session.start"] as const;
 *   export const TRIGGER = ["session.start", "prompt.submit"] as const;
 *
 * Event names are Shaka's canonical names (provider-agnostic).
 * Provider configurers map these to provider-specific event names.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Shaka's canonical hook event names.
 * These are provider-agnostic — conversion happens in provider configurers.
 */
export const HOOK_EVENTS = [
  "session.start",
  "session.end",
  "prompt.submit",
  "tool.before",
  "tool.after",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface DiscoveredHook {
  /** Filename (e.g., "session-start.ts") */
  filename: string;
  /** Event name from exported TRIGGER constant */
  event: HookEvent;
  /** Full path to the hook file */
  path: string;
  /** Tool matchers for tool.before/tool.after events (e.g., ["Bash", "Edit"]) */
  matchers?: string[];
}

interface ParsedHook {
  events: HookEvent[];
  matchers?: string[];
}

/**
 * Parse a hook file to extract its trigger events and optional matchers.
 * Imports the file and reads the exported TRIGGER and MATCHER arrays.
 *
 * TRIGGER: Which events to listen for (e.g., ["tool.before"])
 * MATCHER: For tool events, which tools to filter (e.g., ["Bash", "Edit", "Write", "Read"])
 *
 * A file without a TRIGGER export is not a hook and yields no events.
 * A file that fails to import throws — swallowing that error once let an
 * install wire zero hooks across every provider and report success.
 */
export async function parseHookTrigger(filePath: string): Promise<ParsedHook> {
  // Add cache-busting to ensure fresh import (important for tests and hot-reload)
  // Use file:// URL so import() works on Windows (bare paths like C:\... fail)
  const fileUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;

  let module: Record<string, unknown>;
  try {
    module = await import(fileUrl);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Hook file failed to load: ${filePath}\n  ${cause}`);
  }

  const trigger = module.TRIGGER;
  const matcher = module.MATCHER;

  if (!Array.isArray(trigger)) {
    return { events: [] };
  }

  const events = trigger.filter(
    (t): t is HookEvent => typeof t === "string" && HOOK_EVENTS.includes(t as HookEvent),
  );

  // Parse matchers if present (for tool.before/tool.after filtering)
  const matchers = Array.isArray(matcher)
    ? matcher.filter((m): m is string => typeof m === "string")
    : undefined;

  return { events, matchers };
}

/**
 * Discover all hooks in a directory.
 * Returns hooks that have a valid TRIGGER export.
 * Hooks with multiple triggers create multiple entries.
 * A missing directory yields no hooks; a hook file that fails to load throws.
 */
export async function discoverHooks(hooksDir: string): Promise<DiscoveredHook[]> {
  let entries: string[];
  try {
    entries = await readdir(hooksDir);
  } catch {
    // Directory doesn't exist yet - that's ok during init
    return [];
  }

  const hooks: DiscoveredHook[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;

    const filePath = join(hooksDir, entry);
    const { events, matchers } = await parseHookTrigger(filePath);

    for (const event of events) {
      hooks.push({
        filename: entry,
        event,
        path: filePath,
        matchers,
      });
    }
  }

  return hooks;
}

/**
 * Discover hooks from both system/hooks/ and customizations/hooks/ directories.
 * Customization hooks override system hooks with the same filename.
 * Additional hooks in customizations/ (no system counterpart) are appended.
 *
 * Throws when system hook files exist but none parse as hooks: installing an
 * empty hook set would strip every provider's wiring, so refuse instead.
 */
export async function discoverAllHooks(shakaHome: string): Promise<DiscoveredHook[]> {
  const systemDir = join(shakaHome, "system", "hooks");
  const systemHooks = await discoverHooks(systemDir);
  if (systemHooks.length === 0 && (await hasHookFiles(systemDir))) {
    throw new Error(
      `No hooks discovered in ${systemDir} despite hook files being present — refusing to install an empty hook set`,
    );
  }

  const customHooks = await discoverHooks(join(shakaHome, "customizations", "hooks"));

  // Customization filenames that override system counterparts
  const overridden = new Set(customHooks.map((h) => h.filename));
  const filtered = systemHooks.filter((h) => !overridden.has(h.filename));

  return [...filtered, ...customHooks];
}

async function hasHookFiles(hooksDir: string): Promise<boolean> {
  try {
    const entries = await readdir(hooksDir);
    return entries.some((entry) => entry.endsWith(".ts"));
  } catch {
    return false;
  }
}

/**
 * Map Shaka event names to Claude Code event names.
 * Used by Claude configurer when writing to settings.json.
 */
export const SHAKA_TO_CLAUDE_EVENT: Record<HookEvent, string> = {
  "session.start": "SessionStart",
  "session.end": "SessionEnd",
  "prompt.submit": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

/**
 * Map Shaka event names to Codex CLI event names.
 * Used by Codex configurer when writing to hooks.json.
 */
export const SHAKA_TO_CODEX_EVENT: Record<HookEvent, string | null> = {
  "session.start": "SessionStart",
  "session.end": null, // Handled specially by Codex configurer (Stop debounce script, Phase 2)
  "prompt.submit": "UserPromptSubmit",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

/**
 * Map Shaka event names to opencode plugin hooks.
 * Used by opencode configurer when generating the plugin.
 * null means no direct equivalent — handled specially.
 */
export const SHAKA_TO_OPENCODE_HOOK: Record<HookEvent, string | null> = {
  "session.start": null, // No direct equivalent - handled at plugin load
  "session.end": null, // No direct equivalent - handled via session.idle in catch-all event handler
  "prompt.submit": "experimental.chat.system.transform",
  "tool.before": "tool.execute.before",
  "tool.after": "tool.execute.after",
};
