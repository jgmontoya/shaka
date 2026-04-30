/**
 * Cross-platform path utilities.
 *
 * The `new URL(..., import.meta.url).pathname` pattern produces invalid paths
 * on Windows (e.g., `/C:/Users/...` instead of `C:\Users\...`).
 * `fileURLToPath()` handles this correctly on all platforms.
 */

import { readlink, rm, rmdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Resolve a relative path from a module's location.
 * Use instead of `new URL(relative, import.meta.url).pathname`.
 *
 * @param base - The module's `import.meta.url`
 * @param relative - Relative path from the module (e.g., "../../defaults")
 */
export function resolveFromModule(base: string, relative: string): string {
  return fileURLToPath(new URL(relative, base));
}

/**
 * Read the target of a symlink or Windows junction.
 * Returns the target path, or null if the path is not a symlink/junction.
 *
 * On Bun/Windows, `lstat().isSymbolicLink()` returns false for junctions.
 * `readlink()` works for both symlinks and junctions, making it the
 * reliable cross-platform way to detect symlink-like entries.
 */
export async function readSymlinkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

/**
 * Remove a symlink or Windows junction.
 *
 * Plain `rm()` fails on Windows junctions because Bun treats them as
 * directories, not symlinks. `rmdir()` correctly removes the junction
 * reparse point without following it into the target.
 */
export async function removeLink(path: string): Promise<void> {
  if (process.platform === "win32") {
    await rmdir(path);
  } else {
    await rm(path);
  }
}

/**
 * Quote a string for safe inclusion in a POSIX shell command. Uses single
 * quotes (which never expand) with the canonical `'\''` escape for any
 * embedded single quote. Use this whenever a path or argument is being
 * baked into a shell-parsed `command` string (Claude `settings.json`
 * hooks, Codex `hooks.json`, etc.) — double-quoted forms still expand
 * `$VAR`, `$(...)`, and backticks, which is a shell-injection vector for
 * crafted hook paths.
 */
export function shellQuotePosix(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}
