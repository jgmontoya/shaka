/** Shared filesystem identity checks for learnings storage. */

import { lstat } from "node:fs/promises";

export type LearningFileStatus =
  | { readonly kind: "missing" }
  | { readonly kind: "regular" }
  | { readonly kind: "invalid"; readonly message: string };

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

/** Inspect the path itself without following symbolic links. */
export async function inspectLearningFileStatus(filePath: string): Promise<LearningFileStatus> {
  try {
    const fileStats = await lstat(filePath);
    return fileStats.isFile()
      ? { kind: "regular" }
      : { kind: "invalid", message: "Learning storage path must be a regular file." };
  } catch (error) {
    return hasErrorCode(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "invalid", message: "Learning storage path could not be inspected." };
  }
}
