import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexCommands } from "../../../../src/providers/codex/commands";

describe("installCodexCommands", () => {
  test("rejects invalid manifest command names before cleanup can escape skillsDir", async () => {
    const root = join(
      tmpdir(),
      `shaka-codex-commands-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const skillsDir = join(root, "skills");
    const outsideDir = join(root, "outside");
    try {
      await mkdir(skillsDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await Bun.write(join(outsideDir, "sentinel.txt"), "keep me");

      await expect(
        installCodexCommands(
          { commands: [], manifest: { global: ["../outside"], scoped: {} } },
          skillsDir,
        ),
      ).rejects.toThrow("Invalid command manifest");

      expect(await Bun.file(join(outsideDir, "sentinel.txt")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
