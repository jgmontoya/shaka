/**
 * Shared path utilities for discovery modules.
 * Extracted from command-discovery.ts for reuse by workflow-discovery.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve ~ or ~/ prefix to homedir in a path. */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Normalize cwd: absent/"*" → undefined, string → [resolved], string[] → [resolved...]. */
export function normalizeCwd(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "*") return undefined;
  if (typeof value === "string") return [expandTilde(value)];
  if (Array.isArray(value)) {
    const paths = value.filter((v): v is string => typeof v === "string" && v !== "*");
    return paths.length > 0 ? paths.map(expandTilde) : undefined;
  }
  return undefined;
}
