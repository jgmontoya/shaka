import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installAssetSymlink,
  installPerSkillSymlinks,
  uninstallAssetSymlink,
  uninstallPerSkillSymlinks,
  verifyPerSkillSymlinks,
} from "../../../src/providers/asset-installer";

describe("asset-installer", () => {
  const testSourceDir = join(tmpdir(), "shaka-test-source");
  const testTargetDir = join(tmpdir(), "shaka-test-target");

  beforeEach(async () => {
    await rm(testSourceDir, { recursive: true, force: true });
    await rm(testTargetDir, { recursive: true, force: true });
    await mkdir(testSourceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testSourceDir, { recursive: true, force: true });
    await rm(testTargetDir, { recursive: true, force: true });
  });

  describe("installAssetSymlink", () => {
    test("creates symlink when target does not exist", async () => {
      await installAssetSymlink(testSourceDir, testTargetDir);

      const linkPath = `${testTargetDir}/shaka`;
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);

      const target = await readlink(linkPath);
      expect(target).toBe(testSourceDir);
    });

    test("creates target directory if it does not exist", async () => {
      const deepTargetDir = `${testTargetDir}/nested/path`;
      await installAssetSymlink(testSourceDir, deepTargetDir);

      const linkPath = `${deepTargetDir}/shaka`;
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
    });

    test("skips if source directory does not exist", async () => {
      await rm(testSourceDir, { recursive: true, force: true });

      await installAssetSymlink(testSourceDir, testTargetDir);

      // Target directory should not be created
      const targetExists = await Bun.file(testTargetDir).exists();
      expect(targetExists).toBe(false);
    });

    test("preserves existing real directory", async () => {
      // Create real directory with user content
      const linkPath = `${testTargetDir}/shaka`;
      await mkdir(linkPath, { recursive: true });
      await Bun.write(`${linkPath}/custom-agent.md`, "user content");

      await installAssetSymlink(testSourceDir, testTargetDir);

      // Should still be a real directory, not a symlink
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.isDirectory()).toBe(true);

      // User content preserved
      const content = await Bun.file(`${linkPath}/custom-agent.md`).text();
      expect(content).toBe("user content");
    });

    test("replaces symlink pointing to wrong target", async () => {
      // Create symlink pointing to wrong location (use platform-appropriate path)
      const wrongTarget = join(tmpdir(), "shaka-test-wrong-target");
      const linkPath = `${testTargetDir}/shaka`;
      await mkdir(testTargetDir, { recursive: true });
      await symlink(wrongTarget, linkPath, "junction");

      await installAssetSymlink(testSourceDir, testTargetDir);

      // Should now point to correct target
      const newTarget = await readlink(linkPath);
      expect(newTarget).toBe(testSourceDir);
    });

    test("leaves correct symlink unchanged", async () => {
      // Create correct symlink
      const linkPath = `${testTargetDir}/shaka`;
      await mkdir(testTargetDir, { recursive: true });
      await symlink(testSourceDir, linkPath, "junction");

      // Get original stats
      const originalStats = await lstat(linkPath);

      await installAssetSymlink(testSourceDir, testTargetDir);

      // Symlink should be unchanged (same inode)
      const newStats = await lstat(linkPath);
      expect(newStats.ino).toBe(originalStats.ino);
    });

    test("handles trailing slashes in paths via resolve()", async () => {
      // Create symlink without trailing slash
      const linkPath = `${testTargetDir}/shaka`;
      await mkdir(testTargetDir, { recursive: true });
      await symlink(testSourceDir, linkPath, "junction");

      // Install with trailing slash — should recognize as same path
      await installAssetSymlink(`${testSourceDir}/`, testTargetDir);

      // Symlink should still exist and be valid
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
    });
  });

  describe("uninstallAssetSymlink", () => {
    test("removes symlink pointing to source", async () => {
      // Create symlink
      const linkPath = join(testTargetDir, "shaka");
      await mkdir(testTargetDir, { recursive: true });
      await symlink(testSourceDir, linkPath, "junction");

      await uninstallAssetSymlink(testSourceDir, testTargetDir);

      // Symlink should be gone
      try {
        await lstat(linkPath);
        expect(false).toBe(true); // Should not reach here
      } catch (e: unknown) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    test("preserves symlink pointing elsewhere", async () => {
      // Create symlink pointing to different location (use platform-appropriate path)
      const otherTarget = join(tmpdir(), "shaka-test-other-location");
      const linkPath = join(testTargetDir, "shaka");
      await mkdir(testTargetDir, { recursive: true });
      await symlink(otherTarget, linkPath, "junction");

      await uninstallAssetSymlink(testSourceDir, testTargetDir);

      // Symlink should still exist
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(otherTarget);
    });

    test("preserves real directory", async () => {
      // Create real directory with user content
      const linkPath = `${testTargetDir}/shaka`;
      await mkdir(linkPath, { recursive: true });
      await Bun.write(`${linkPath}/custom.md`, "user content");

      await uninstallAssetSymlink(testSourceDir, testTargetDir);

      // Directory should still exist
      const stats = await lstat(linkPath);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    });

    test("handles non-existent symlink gracefully", async () => {
      // Should not throw
      await uninstallAssetSymlink(testSourceDir, testTargetDir);
    });
  });

  describe("installPerSkillSymlinks", () => {
    test("creates individual symlinks for each subdirectory", async () => {
      // Create skill subdirectories in source
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      await mkdir(join(testSourceDir, "red-team"), { recursive: true });
      await Bun.write(join(testSourceDir, "council", "SKILL.md"), "# council");
      await Bun.write(join(testSourceDir, "red-team", "SKILL.md"), "# red-team");

      await installPerSkillSymlinks(testSourceDir, testTargetDir);

      // Each skill should have its own symlink
      const councilLink = join(testTargetDir, "council");
      const redteamLink = join(testTargetDir, "red-team");

      expect((await lstat(councilLink)).isSymbolicLink()).toBe(true);
      expect((await lstat(redteamLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(councilLink)).toBe(join(testSourceDir, "council"));
      expect(await readlink(redteamLink)).toBe(join(testSourceDir, "red-team"));
    });

    test("skips files in source directory", async () => {
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      await Bun.write(join(testSourceDir, "README.md"), "readme");

      await installPerSkillSymlinks(testSourceDir, testTargetDir);

      // Only directory gets a symlink
      expect((await lstat(join(testTargetDir, "council"))).isSymbolicLink()).toBe(true);
      try {
        await lstat(join(testTargetDir, "README.md"));
        expect(false).toBe(true);
      } catch (e: unknown) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    test("skips if source directory does not exist", async () => {
      await rm(testSourceDir, { recursive: true, force: true });
      // Should not throw
      await installPerSkillSymlinks(testSourceDir, testTargetDir);
    });
  });

  describe("uninstallPerSkillSymlinks", () => {
    test("removes symlinks pointing into source directory", async () => {
      // Create per-skill symlinks
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      await mkdir(join(testSourceDir, "red-team"), { recursive: true });
      await installPerSkillSymlinks(testSourceDir, testTargetDir);

      await uninstallPerSkillSymlinks(testSourceDir, testTargetDir);

      // Both symlinks should be removed
      try {
        await lstat(join(testTargetDir, "council"));
        expect(false).toBe(true);
      } catch (e: unknown) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    test("preserves symlinks pointing elsewhere", async () => {
      // Create a per-skill symlink from shaka
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      await installPerSkillSymlinks(testSourceDir, testTargetDir);

      // Create a non-shaka symlink
      const otherSource = join(tmpdir(), "shaka-test-other-source");
      await mkdir(otherSource, { recursive: true });
      await symlink(otherSource, join(testTargetDir, "user-skill"), "junction");

      await uninstallPerSkillSymlinks(testSourceDir, testTargetDir);

      // Shaka symlink removed, other preserved
      try {
        await lstat(join(testTargetDir, "council"));
        expect(false).toBe(true);
      } catch (e: unknown) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
      expect((await lstat(join(testTargetDir, "user-skill"))).isSymbolicLink()).toBe(true);

      await rm(otherSource, { recursive: true, force: true });
    });

    test("handles non-existent target directory gracefully", async () => {
      await uninstallPerSkillSymlinks(testSourceDir, testTargetDir);
    });
  });

  describe("verifyPerSkillSymlinks", () => {
    test("returns ok when all skills have correct symlinks", async () => {
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      await mkdir(join(testSourceDir, "red-team"), { recursive: true });
      await installPerSkillSymlinks(testSourceDir, testTargetDir);

      const result = await verifyPerSkillSymlinks(testSourceDir, testTargetDir, "skills");
      expect(result.ok).toBe(true);
    });

    test("returns ok when source is empty", async () => {
      const result = await verifyPerSkillSymlinks(testSourceDir, testTargetDir, "skills");
      expect(result.ok).toBe(true);
    });

    test("returns ok when source does not exist", async () => {
      await rm(testSourceDir, { recursive: true, force: true });
      const result = await verifyPerSkillSymlinks(testSourceDir, testTargetDir, "skills");
      expect(result.ok).toBe(true);
    });

    test("returns not ok when symlink is missing", async () => {
      await mkdir(join(testSourceDir, "council"), { recursive: true });
      // Don't create the symlink

      const result = await verifyPerSkillSymlinks(testSourceDir, testTargetDir, "skills");
      expect(result.ok).toBe(false);
      expect(result.issue).toContain("council");
    });
  });
});
