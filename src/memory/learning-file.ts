/** Shared filesystem identity checks for learnings storage. */

import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const PRIVATE_FILE_MODE = 0o600;

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

function temporaryPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.tmp.${process.pid}.${randomUUID()}`);
}

async function writePrivateTemporaryFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Atomically replace a file with complete UTF-8 content. The caller owns serialization. */
export async function replaceFileAtomically(filePath: string, content: string): Promise<void> {
  const tmpPath = temporaryPath(filePath);
  try {
    await writePrivateTemporaryFile(tmpPath, content);
    await rename(tmpPath, filePath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Publish immutable UTF-8 content without replacing an existing destination.
 * A hard link makes the final name visible atomically and fails closed on EEXIST.
 */
export async function createFileAtomically(
  filePath: string,
  content: string,
): Promise<"created" | "exists"> {
  const tmpPath = temporaryPath(filePath);
  try {
    await writePrivateTemporaryFile(tmpPath, content);
    try {
      await link(tmpPath, filePath);
      return "created";
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) return "exists";
      throw error;
    }
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
