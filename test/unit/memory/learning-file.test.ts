import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAtomically, replaceFileAtomically } from "../../../src/memory/learning-file";

describe.skipIf(process.platform === "win32")("atomic learning files", () => {
  test("keeps created and replaced content private under a permissive umask", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shaka-learning-file-mode-"));
    const existingPath = join(directory, "learnings.md");
    const createdPath = join(directory, ".learning-intent.json");
    const previousUmask = process.umask(0o022);

    try {
      await Bun.write(existingPath, "private source", { mode: 0o600 });

      await replaceFileAtomically(existingPath, "private replacement");
      await createFileAtomically(createdPath, "private intent");

      expect((await lstat(existingPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(createdPath)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
