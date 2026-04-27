import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../../src/domain/result";
import { ok } from "../../../src/domain/result";
import { resolveFromModule } from "../../../src/platform/paths";
import { getProviderNames } from "../../../src/providers/registry";
import { InitService } from "../../../src/services/init-service";
import { UninstallService } from "../../../src/services/uninstall-service";

describe("UninstallService", () => {
  const testHome = join(tmpdir(), "shaka-test-uninstall");
  const defaultsPath = resolveFromModule(import.meta.url, "../../../defaults");

  const mockBunLink = async (): Promise<Result<void, Error>> => ok(undefined);

  /** Set up a fully initialized shaka home for testing uninstall. */
  async function setupInitializedHome(
    providers: { claude: boolean; opencode: boolean; codex: boolean } = {
      claude: true,
      opencode: false,
      codex: false,
    },
  ) {
    const initService = new InitService({
      shakaHome: testHome,
      defaultsPath,
      detectProviders: async () => providers,
      runBunLink: mockBunLink,
    });
    const result = await initService.init();
    if (!result.ok) throw new Error(`Init failed: ${result.error.message}`);
    return result.value;
  }

  function createService(
    overrides: {
      detectProviders?: () => Promise<{ claude: boolean; opencode: boolean; codex: boolean }>;
    } = {},
  ) {
    return new UninstallService({
      shakaHome: testHome,
      detectProviders:
        overrides.detectProviders ??
        (async () => ({ claude: false, opencode: false, codex: false })),
    });
  }

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  describe("removeSystemLink", () => {
    test("removes system/ symlink", async () => {
      await setupInitializedHome();
      const service = createService();

      const result = await service.removeSystemLink();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(true);

      // Verify symlink is gone
      try {
        await lstat(join(testHome, "system"));
        throw new Error("system/ should not exist");
      } catch (e: unknown) {
        expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    test("does not remove real directory", async () => {
      await mkdir(join(testHome, "system"), { recursive: true });
      const service = createService();

      const result = await service.removeSystemLink();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);

      // Real directory still exists
      const stats = await lstat(join(testHome, "system"));
      expect(stats.isDirectory()).toBe(true);
    });

    test("returns false when nothing exists", async () => {
      await mkdir(testHome, { recursive: true });
      const service = createService();

      const result = await service.removeSystemLink();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(false);
    });
  });

  describe("removeFrameworkFiles", () => {
    test("removes config.json", async () => {
      await setupInitializedHome();
      const service = createService();

      // Verify file exists before
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);

      const removed = await service.removeFrameworkFiles();

      expect(removed).toContain(join(testHome, "config.json"));

      // Verify file is gone
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(false);
    });

    test("removes commands-manifest.json", async () => {
      await setupInitializedHome();
      // Create a manifest file
      await Bun.write(
        join(testHome, "commands-manifest.json"),
        JSON.stringify({ global: ["commit"] }),
      );
      const service = createService();

      const removed = await service.removeFrameworkFiles();

      expect(removed).toContain(join(testHome, "commands-manifest.json"));
      expect(await Bun.file(join(testHome, "commands-manifest.json")).exists()).toBe(false);
    });

    test("handles missing files gracefully", async () => {
      await mkdir(testHome, { recursive: true });
      const service = createService();

      const removed = await service.removeFrameworkFiles();

      expect(removed).toEqual([]);
    });
  });

  describe("removeUserData", () => {
    test("removes user/, customizations/, memory/", async () => {
      await setupInitializedHome();
      // Add some user content
      await writeFile(join(testHome, "user", "user.md"), "custom content");

      const service = createService();
      const removed = await service.removeUserData();

      expect(removed).toContain(join(testHome, "user"));
      expect(removed).toContain(join(testHome, "customizations"));
      expect(removed).toContain(join(testHome, "memory"));
    });

    test("handles missing directories gracefully", async () => {
      await mkdir(testHome, { recursive: true });
      const service = createService();

      const removed = await service.removeUserData();

      expect(removed).toEqual([]);
    });
  });

  describe("removeShakaHomeIfEmpty", () => {
    test("removes empty shakaHome", async () => {
      await mkdir(testHome, { recursive: true });
      const service = createService();

      const removed = await service.removeShakaHomeIfEmpty();

      expect(removed).toBe(true);
    });

    test("keeps non-empty shakaHome", async () => {
      await mkdir(testHome, { recursive: true });
      await writeFile(join(testHome, "leftover.txt"), "data");
      const service = createService();

      const removed = await service.removeShakaHomeIfEmpty();

      expect(removed).toBe(false);
    });
  });

  describe("uninstall", () => {
    test("removes framework files but keeps user data by default", async () => {
      await setupInitializedHome();
      const service = createService();

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Framework items removed
        expect(result.value.removed).toContain(join(testHome, "system"));
        expect(result.value.removed).toContain(join(testHome, "config.json"));

        // User dirs still exist
        const userStats = await lstat(join(testHome, "user"));
        expect(userStats.isDirectory()).toBe(true);
      }
    });

    test("removes everything when deleteUserData is true", async () => {
      await setupInitializedHome();
      const service = createService();

      const result = await service.uninstall({ deleteUserData: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.removed).toContain(join(testHome, "user"));
        expect(result.value.removed).toContain(join(testHome, "customizations"));
        expect(result.value.removed).toContain(join(testHome, "memory"));

        // shakaHome itself should be removed (now empty)
        expect(result.value.removed).toContain(testHome);
      }
    });

    test("reports provider uninstall status", async () => {
      await setupInitializedHome({ claude: true, opencode: false, codex: false });
      // No actual provider installed in test env, so detection returns false
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false, codex: false }),
      });

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.detected).toBe(false);
        expect(result.value.providers.opencode.detected).toBe(false);
      }
    });

    test("providers result has an entry for every registered provider", async () => {
      await setupInitializedHome({ claude: true, opencode: false, codex: false });
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false, codex: false }),
      });

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const names = getProviderNames();
        for (const name of names) {
          expect(result.value.providers[name]).toBeDefined();
          expect(typeof result.value.providers[name].detected).toBe("boolean");
          expect(typeof result.value.providers[name].uninstalled).toBe("boolean");
        }
      }
    });
  });
});
