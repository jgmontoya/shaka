/**
 * Command manifest I/O.
 *
 * Tracks which commands Shaka installed to provider directories.
 * Used during clean-then-install to remove orphaned commands.
 */

import { join } from "node:path";
import { validateCommandName } from "./command-name";

const MANIFEST_FILE = "commands-manifest.json";

export interface CommandManifest {
  global: string[];
  scoped: Record<string, string[]>;
}

function emptyManifest(): CommandManifest {
  return { global: [], scoped: {} };
}

function readCommandNames(value: unknown, label: string, options?: { strict?: boolean }): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    if (options?.strict) {
      throw new Error(`Invalid command manifest ${label}: expected array`);
    }
    return [];
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Invalid command manifest ${label}[${index}]: expected command name string`);
    }
    const error = validateCommandName(item);
    if (error) {
      throw new Error(`Invalid command manifest ${label}[${index}]: ${error}`);
    }
    return item;
  });
}

function readScopedCommands(
  value: unknown,
  options?: { strict?: boolean },
): Record<string, string[]> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (options?.strict) {
      throw new Error("Invalid command manifest scoped: expected object");
    }
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([cwd, names]) => [
      cwd,
      readCommandNames(names, `scoped[${JSON.stringify(cwd)}]`, options),
    ]),
  );
}

export function assertValidCommandManifest(manifest: CommandManifest): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid command manifest: expected object");
  }
  const raw = manifest as unknown as Record<string, unknown>;
  readCommandNames(raw.global, "global", { strict: true });
  readScopedCommands(raw.scoped, { strict: true });
}

/** Read manifest from shakaHome. Returns empty manifest if file doesn't exist. */
export async function readManifest(shakaHome: string): Promise<CommandManifest> {
  const file = Bun.file(join(shakaHome, MANIFEST_FILE));
  if (!(await file.exists())) return emptyManifest();

  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return emptyManifest();
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyManifest();

  const obj = raw as Record<string, unknown>;

  return {
    global: readCommandNames(obj.global, "global", { strict: true }),
    scoped: readScopedCommands(obj.scoped, { strict: true }),
  };
}

/** Write manifest to shakaHome. Overwrites existing. */
export async function writeManifest(shakaHome: string, manifest: CommandManifest): Promise<void> {
  await Bun.write(join(shakaHome, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}
