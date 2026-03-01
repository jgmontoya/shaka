/**
 * Command discovery for slash commands.
 * Scans system/commands/ and customizations/commands/ for .md files,
 * validates them, and returns discovered commands + errors.
 *
 * Follows the same override pattern as hooks: customizations take
 * precedence over system by filename match.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../domain/frontmatter";
import { normalizeCwd } from "../domain/paths";

/** Valid command name: lowercase alphanumeric with hyphens, no leading/trailing hyphens, max 64 chars. */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = new Set(["shaka"]);
const KNOWN_PROVIDERS = new Set(["claude", "opencode"]);

/** Overridable command fields (used in providers block). */
export interface CommandFields {
  description: string;
  argumentHint?: string;
  model?: string;
  subtask?: boolean;
  userInvocable?: boolean;
}

export interface DiscoveredCommand extends CommandFields {
  name: string;
  cwd?: string[];
  providers?: {
    claude?: Partial<CommandFields>;
    opencode?: Partial<CommandFields>;
  };
  body: string;
  sourcePath: string;
}

export interface CommandError {
  name: string;
  sourcePath: string;
  error: string;
}

export interface DiscoveryResult {
  commands: DiscoveredCommand[];
  errors: CommandError[];
}

/** Discover commands from system/ and customizations/, with override and disabled filtering. */
export async function discoverCommands(
  shakaHome: string,
  disabled?: string[],
): Promise<DiscoveryResult> {
  const merged = await mergeCommandFiles(shakaHome);
  const disabledSet = new Set(disabled ?? []);
  const commands: DiscoveredCommand[] = [];
  const errors: CommandError[] = [];

  for (const { filename, dir } of merged) {
    const name = nameFromFilename(filename);
    if (disabledSet.has(name)) continue;

    const result = await parseCommandFile(name, join(dir, filename));
    if ("error" in result) {
      errors.push(result);
    } else {
      commands.push(result);
    }
  }

  return { commands, errors };
}

/** Merge system and customization command files, with customization override. */
async function mergeCommandFiles(
  shakaHome: string,
): Promise<Array<{ filename: string; dir: string }>> {
  const systemDir = join(shakaHome, "system", "commands");
  const customDir = join(shakaHome, "customizations", "commands");

  const systemFiles = await listCommandFiles(systemDir);
  const customFiles = await listCommandFiles(customDir);

  const customNames = new Set(customFiles.map((f) => nameFromFilename(f)));
  const merged: Array<{ filename: string; dir: string }> = [];

  for (const f of systemFiles) {
    if (!customNames.has(nameFromFilename(f))) {
      merged.push({ filename: f, dir: systemDir });
    }
  }
  for (const f of customFiles) {
    merged.push({ filename: f, dir: customDir });
  }

  return merged;
}

/** Parse and validate a single command file. Returns the command or an error. */
async function parseCommandFile(
  name: string,
  sourcePath: string,
): Promise<DiscoveredCommand | CommandError> {
  const nameError = validateName(name);
  if (nameError) return { name, sourcePath, error: nameError };

  let raw: string;
  try {
    raw = await Bun.file(sourcePath).text();
  } catch {
    return { name, sourcePath, error: "Failed to read command file" };
  }
  const parsed = parseFrontmatter(raw);

  if (!parsed) {
    const hasDelimiters = raw.trimStart().startsWith("---");
    return {
      name,
      sourcePath,
      error: hasDelimiters
        ? "Invalid YAML frontmatter"
        : "No frontmatter found — command files require --- delimiters",
    };
  }

  const { frontmatter, body } = parsed;
  const description = frontmatter.description;
  if (typeof description !== "string" || !description.trim()) {
    return { name, sourcePath, error: "Missing required field: description" };
  }

  const cwd = normalizeCwd(frontmatter.cwd);
  const providers = parseProviders(frontmatter.providers);
  if (typeof providers === "string") {
    return { name, sourcePath, error: providers };
  }

  return {
    name,
    description: description.trim(),
    argumentHint: asOptionalString(frontmatter["argument-hint"]),
    model: asOptionalString(frontmatter.model),
    subtask: asOptionalBoolean(frontmatter.subtask),
    userInvocable: asOptionalBoolean(frontmatter["user-invocable"]),
    cwd,
    providers,
    body,
    sourcePath,
  };
}

function nameFromFilename(filename: string): string {
  return filename.replace(/\.md$/, "");
}

function validateName(name: string): string | null {
  if (RESERVED_NAMES.has(name)) {
    return `Reserved command name "${name}" — collides with Shaka's skills directory`;
  }
  if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    return `Invalid command name "${name}" — must match [a-z0-9], no leading/trailing hyphens, max 64 chars`;
  }
  return null;
}

async function listCommandFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** Parse providers block. Returns parsed object, undefined, or error string. */
function parseProviders(value: unknown): DiscoveredCommand["providers"] | undefined | string {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_PROVIDERS.has(key)) {
      return `Unknown provider "${key}" in providers block — expected: ${[...KNOWN_PROVIDERS].join(", ")}`;
    }
  }

  const result: NonNullable<DiscoveredCommand["providers"]> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const overrides = obj[provider];
    if (!overrides || typeof overrides !== "object") continue;
    result[provider as "claude" | "opencode"] = parseFieldOverrides(
      overrides as Record<string, unknown>,
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Parse field overrides from a provider block. */
function parseFieldOverrides(obj: Record<string, unknown>): Partial<CommandFields> {
  const fields: Partial<CommandFields> = {};
  if (typeof obj.description === "string") fields.description = obj.description;
  if (typeof obj["argument-hint"] === "string") fields.argumentHint = obj["argument-hint"];
  if (typeof obj.model === "string") fields.model = obj.model;
  if (typeof obj.subtask === "boolean") fields.subtask = obj.subtask;
  if (typeof obj["user-invocable"] === "boolean") fields.userInvocable = obj["user-invocable"];
  return fields;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
