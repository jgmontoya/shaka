/**
 * Shared utilities for the memory module.
 */

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
