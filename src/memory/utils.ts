/**
 * Shared utilities for the memory module.
 */

import { isAbsolute, relative } from "node:path";

/**
 * Hash a session ID to 8 hex chars for deterministic identification.
 * Uses SHA-256 so the output is provider-agnostic — works regardless of
 * whether the input is a UUID (Claude) or ses_-prefixed ID (opencode).
 */
export function hashSessionId(sessionId: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(sessionId);
  return hasher.digest("hex").slice(0, 8);
}

/**
 * Hash arbitrary content to 16 hex chars using SHA-256.
 * Used for content-change detection in manifest tracking.
 */
export function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Check if two paths have an ancestor/descendant relationship (or are equal).
 * Used for CWD matching in rollups and knowledge compilation.
 */
export function isPathRelated(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
