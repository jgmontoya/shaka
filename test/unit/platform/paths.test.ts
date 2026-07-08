import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readSymlinkTarget,
  removeLink,
  resolveFromModule,
  shellQuotePosix,
  whichOnCurrentPath,
} from "../../../src/platform/paths";

describe("platform/paths", () => {
  describe("whichOnCurrentPath", () => {
    test.skipIf(process.platform === "win32")("uses runtime PATH changes", () => {
      const originalPath = process.env.PATH;

      try {
        process.env.PATH = "";

        expect(whichOnCurrentPath("sh")).toBeNull();
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
      }
    });
  });

  describe("resolveFromModule", () => {
    test("resolves relative path from module URL", () => {
      const result = resolveFromModule(import.meta.url, "./fixtures");
      expect(result).toContain("test");
      expect(result).toContain("fixtures");
    });

    test("resolves parent directory traversal", () => {
      const result = resolveFromModule(import.meta.url, "../..");
      // Should resolve to test/ directory
      expect(result).toContain("test");
    });

    test("returns a valid filesystem path (no leading /C: on Windows)", () => {
      const result = resolveFromModule(import.meta.url, ".");
      // On Windows, should not start with /C:
      // On Unix, should start with /
      if (process.platform === "win32") {
        expect(result).not.toMatch(/^\/[A-Z]:/);
        expect(result).toMatch(/^[A-Z]:\\/);
      } else {
        expect(result).toMatch(/^\//);
      }
    });

    test("matches fileURLToPath behavior for known URL", () => {
      const base = pathToFileURL(join("/", "fake", "module.ts")).href;
      const result = resolveFromModule(base, "./sibling.ts");
      expect(result).toBe(join("/", "fake", "sibling.ts"));
    });
  });

  describe("removeLink", () => {
    const testDir = join(tmpdir(), "shaka-test-removeLink");
    const target = join(testDir, "target");
    const link = join(testDir, "link");

    beforeEach(async () => {
      await rm(testDir, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    test("removes a symlink/junction", async () => {
      await symlink(target, link, "junction");
      expect(await readSymlinkTarget(link)).not.toBeNull();

      await removeLink(link);

      expect(await readSymlinkTarget(link)).toBeNull();
    });

    test("does not remove the target directory", async () => {
      await Bun.write(join(target, "file.txt"), "keep me");
      await symlink(target, link, "junction");

      await removeLink(link);

      // Target and its contents are untouched
      const stats = await lstat(target);
      expect(stats.isDirectory()).toBe(true);
      expect(await Bun.file(join(target, "file.txt")).text()).toBe("keep me");
    });

    test("throws when path does not exist", async () => {
      await expect(removeLink(join(testDir, "nonexistent"))).rejects.toThrow();
    });
  });

  describe("shellQuotePosix", () => {
    test("wraps a plain path in single quotes", () => {
      expect(shellQuotePosix("/tmp/foo")).toBe("'/tmp/foo'");
    });

    test("preserves spaces inside the quoted form (no word-splitting risk)", () => {
      expect(shellQuotePosix("/Users/jane doe/.config")).toBe("'/Users/jane doe/.config'");
    });

    test("escapes embedded single quotes via the canonical '\\'' sequence", () => {
      // POSIX-canonical: close quotes, escape one ', re-open quotes.
      // `it's` becomes `it'\''s`, wrapped: `'it'\''s'`.
      expect(shellQuotePosix("it's")).toBe("'it'\\''s'");
    });

    test("renders shell-active syntax inert ($VAR, $(cmd), backticks)", () => {
      // Single-quoted strings never expand. The literal characters survive.
      const evil = "/tmp/$(rm -rf ~)/`whoami`/$HOME";
      const quoted = shellQuotePosix(evil);
      // The output is `'…'` with the dangerous content verbatim inside.
      expect(quoted).toBe(`'${evil}'`);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    });
  });
});
