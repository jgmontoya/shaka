import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../../src/domain/result";
import { ok } from "../../../src/domain/result";
import { resolveFromModule } from "../../../src/platform/paths";
import { getProviderNames } from "../../../src/providers/registry";
import type { ProviderConfigurer, ProviderName } from "../../../src/providers/types";
import { InitService } from "../../../src/services/init-service";
import type { DetectedProviders } from "../../../src/services/provider-detection";
import { UninstallService, type UninstallResult } from "../../../src/services/uninstall-service";

describe("UninstallService", () => {
  const testHome = join(tmpdir(), "shaka-test-uninstall");
  const defaultsPath = resolveFromModule(import.meta.url, "../../../defaults");

  const mockBunLink = async (): Promise<Result<void, Error>> => ok(undefined);

  /** Set up a fully initialized shaka home for testing uninstall. */
  async function setupInitializedHome(
    providers: DetectedProviders = {
      claude: true,
      opencode: false,
      codex: false,
      pi: false,
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
      detectProviders?: () => Promise<DetectedProviders>;
      createProvider?: (name: ProviderName) => ProviderConfigurer;
    } = {},
  ) {
    return new UninstallService({
      shakaHome: testHome,
      detectProviders:
        overrides.detectProviders ??
        (async () => ({ claude: false, opencode: false, codex: false, pi: false })),
      createProvider: overrides.createProvider,
    });
  }

  function fakeProvider(name: ProviderName, uninstalled: ProviderName[]): ProviderConfigurer {
    return {
      name,
      label: name,
      skillsDir: join(testHome, "fake-provider-skills", name),
      commands: { install: async () => {} },
      isInstalled: () => true,
      install: async () => ok(undefined),
      installCommands: async () => {},
      uninstall: async () => {
        uninstalled.push(name);
        return ok(undefined);
      },
      checkInstallation: async () => ({
        hooks: { ok: true },
        agents: { ok: true },
        skills: { ok: true },
        commands: { ok: true },
        installedSkills: { ok: true },
      }),
      unregisterMcpServer: async () => ok(undefined),
    };
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
    test("preserves config.json", async () => {
      await setupInitializedHome();
      const service = createService();

      // Verify file exists before
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);

      const removed = await service.removeFrameworkFiles();

      expect(removed).not.toContain(join(testHome, "config.json"));

      // Verify user config survives framework cleanup.
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
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
    test("removes config.json, user/, customizations/, memory/", async () => {
      await setupInitializedHome();
      // Add some user content
      await writeFile(join(testHome, "user", "user.md"), "custom content");

      const service = createService();
      const removed = await service.removeUserData();

      expect(removed).toContain(join(testHome, "user"));
      expect(removed).toContain(join(testHome, "customizations"));
      expect(removed).toContain(join(testHome, "memory"));
      expect(removed).toContain(join(testHome, "config.json"));
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
    test("removes framework files but keeps user data and config by default", async () => {
      await setupInitializedHome();
      const service = createService();

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Framework items removed
        expect(result.value.removed).toContain(join(testHome, "system"));
        expect(result.value.removed).not.toContain(join(testHome, "config.json"));

        // User dirs still exist
        const userStats = await lstat(join(testHome, "user"));
        expect(userStats.isDirectory()).toBe(true);
        expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
      }
    });

    test("keeps custom data and installed skills across uninstall then re-init", async () => {
      await setupInitializedHome();

      await Bun.write(join(testHome, "user", "user.md"), "# Customized user context");
      await mkdir(join(testHome, "customizations", "hooks"), { recursive: true });
      await Bun.write(
        join(testHome, "customizations", "hooks", "session-start.ts"),
        "export default async function customHook() {}",
      );
      await mkdir(join(testHome, "customizations", "skills", "personal"), { recursive: true });
      await Bun.write(
        join(testHome, "customizations", "skills", "personal", "SKILL.md"),
        "# Personal skill override",
      );
      await mkdir(join(testHome, "skills", "third-party"), { recursive: true });
      await Bun.write(join(testHome, "skills", "third-party", "SKILL.md"), "# Third-party skill");
      await Bun.write(
        join(testHome, "skills.json"),
        JSON.stringify({ skills: [{ name: "third-party", source: "local" }] }),
      );
      await mkdir(join(testHome, "memory", "rollups", "project-a"), { recursive: true });
      await mkdir(join(testHome, "memory", "sessions"), { recursive: true });
      await mkdir(join(testHome, "memory", "knowledge", "project-a"), { recursive: true });
      await Bun.write(join(testHome, "memory", "learnings.md"), "- durable learning");
      await Bun.write(join(testHome, "memory", "rollups", "project-a", "daily.md"), "# Rollup");
      await Bun.write(join(testHome, "memory", "sessions", "session.md"), "# Session summary");
      await Bun.write(join(testHome, "memory", "knowledge", "project-a", "index.md"), "# Knowledge");

      const service = createService();
      const uninstallResult = await service.uninstall({ deleteUserData: false });

      expect(uninstallResult.ok).toBe(true);
      if (!uninstallResult.ok) throw uninstallResult.error;
      expect(uninstallResult.value.removed).toContain(join(testHome, "system"));
      expect(uninstallResult.value.removed).not.toContain(join(testHome, "config.json"));
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);

      const reinstallResult = await setupInitializedHome();

      expect(reinstallResult.files).not.toContain(join(testHome, "user", "user.md"));
      expect(await Bun.file(join(testHome, "user", "user.md")).text()).toBe(
        "# Customized user context",
      );
      expect(
        await Bun.file(join(testHome, "customizations", "hooks", "session-start.ts")).text(),
      ).toBe("export default async function customHook() {}");
      expect(
        await Bun.file(join(testHome, "customizations", "skills", "personal", "SKILL.md")).text(),
      ).toBe("# Personal skill override");
      expect(await Bun.file(join(testHome, "skills", "third-party", "SKILL.md")).text()).toBe(
        "# Third-party skill",
      );
      expect(await Bun.file(join(testHome, "skills.json")).json()).toEqual({
        skills: [{ name: "third-party", source: "local" }],
      });
      expect(await Bun.file(join(testHome, "memory", "learnings.md")).text()).toBe(
        "- durable learning",
      );
      expect(await Bun.file(join(testHome, "memory", "rollups", "project-a", "daily.md")).text())
        .toBe("# Rollup");
      expect(await Bun.file(join(testHome, "memory", "sessions", "session.md")).text()).toBe(
        "# Session summary",
      );
      expect(
        await Bun.file(join(testHome, "memory", "knowledge", "project-a", "index.md")).text(),
      ).toBe("# Knowledge");
      const systemStats = await lstat(join(testHome, "system"));
      expect(systemStats.isSymbolicLink()).toBe(true);
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
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
        expect(result.value.removed).toContain(join(testHome, "config.json"));

        // shakaHome itself should be removed (now empty)
        expect(result.value.removed).toContain(testHome);
      }
    });

    test("reports provider uninstall status", async () => {
      await setupInitializedHome({ claude: true, opencode: false, codex: false, pi: false });
      // No actual provider installed in test env, so detection returns false
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false, codex: false, pi: false }),
      });

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.detected).toBe(false);
        expect(result.value.providers.opencode.detected).toBe(false);
      }
    });

    test("only:[<provider>] uninstalls just that provider and preserves framework files", async () => {
      // Per-provider uninstall is "remove Shaka from this provider", not
      // "uninstall Shaka itself" — the system/ symlink, config.json, and
      // shakaHome stay so the user can keep using Shaka with their other
      // providers.
      await setupInitializedHome({ claude: true, opencode: true, codex: false, pi: true });
      const uninstalled: ProviderName[] = [];
      const service = createService({
        detectProviders: async () => ({
          claude: true,
          opencode: true,
          codex: false,
          pi: true,
        }),
        createProvider: (name) => fakeProvider(name, uninstalled),
      });

      const result = await service.uninstall({ deleteUserData: false, only: ["pi"] });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.pi.uninstalled).toBe(true);
        expect(result.value.providers.claude.uninstalled).toBe(false);
        expect(result.value.providers.opencode.uninstalled).toBe(false);
        expect(uninstalled).toEqual(["pi"]);
        // Framework + user data untouched.
        expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
        const systemStats = await lstat(join(testHome, "system"));
        expect(systemStats.isSymbolicLink()).toBe(true);
        const userStats = await lstat(join(testHome, "user"));
        expect(userStats.isDirectory()).toBe(true);
      }
    });

    test("returns an error when only is combined with deleteUserData", async () => {
      // The two options contradict each other: per-provider scope means
      // "leave the user's Shaka install alone." Failing fast beats
      // half-applying a confusing combination.
      await setupInitializedHome({ claude: true, opencode: false, codex: false, pi: false });
      const service = createService({
        detectProviders: async () => ({
          claude: true,
          opencode: false,
          codex: false,
          pi: false,
        }),
      });

      const result = await service.uninstall({ deleteUserData: true, only: ["claude"] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/per-provider|only|cannot/i);
      }
    });

    test("only:[] is treated as 'no scope' — falls back to full teardown", async () => {
      // An empty array is truthy. Without normalization, `only:[]` would
      // build an empty Set, skip every provider in the loop, and then early-
      // return before framework cleanup — a silent no-op uninstall. Callers
      // that derive `only` from CLI flags (filter().filter() on a no-flag
      // invocation) shouldn't accidentally trigger that branch.
      await setupInitializedHome();
      const service = createService();

      const result = await service.uninstall({ deleteUserData: false, only: [] });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Framework files were removed → full-teardown path ran.
        expect(result.value.removed).toContain(join(testHome, "system"));
        expect(result.value.removed).not.toContain(join(testHome, "config.json"));
        expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
      }
    });

    test("scoped uninstall returns err when the named provider's uninstall fails", async () => {
      // CLI exits non-zero only on err(...) — returning ok({errors:[...]})
      // makes `shaka uninstall --pi` print success and exit 0 even when
      // Pi's uninstall failed. False-positive UX for users + automation.
      // Subclass the service to inject a failing uninstallProviders
      // result (the real `uninstall(scoped)` calls it once and decides
      // ok-vs-err from there).
      class FailingService extends UninstallService {
        override async uninstallProviders(): Promise<UninstallResult["providers"]> {
          return {
            claude: { detected: false, uninstalled: false },
            opencode: { detected: false, uninstalled: false },
            codex: { detected: false, uninstalled: false },
            pi: { detected: true, uninstalled: false },
          };
        }
      }
      const service = new FailingService({
        shakaHome: testHome,
        detectProviders: async () => ({
          claude: false,
          opencode: false,
          codex: false,
          pi: true,
        }),
      });

      const result = await service.uninstall({ deleteUserData: false, only: ["pi"] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("pi");
    });

    test("only:[a, b] uninstalls every named provider and leaves the rest untouched", async () => {
      // Mirrors `init`'s combinable flags: `--claude --pi` should clean up
      // both without touching opencode or codex.
      await setupInitializedHome({ claude: true, opencode: true, codex: true, pi: true });
      const uninstalled: ProviderName[] = [];
      const service = createService({
        detectProviders: async () => ({
          claude: true,
          opencode: true,
          codex: true,
          pi: true,
        }),
        createProvider: (name) => fakeProvider(name, uninstalled),
      });

      const result = await service.uninstall({
        deleteUserData: false,
        only: ["claude", "pi"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.uninstalled).toBe(true);
        expect(result.value.providers.pi.uninstalled).toBe(true);
        expect(result.value.providers.opencode.uninstalled).toBe(false);
        expect(result.value.providers.codex.uninstalled).toBe(false);
        expect(uninstalled).toEqual(["claude", "pi"]);
      }
    });

    test("full uninstall continues framework cleanup when one provider uninstall throws", async () => {
      await setupInitializedHome({ claude: true, opencode: true, codex: false, pi: false });
      const uninstalled: ProviderName[] = [];
      const service = createService({
        detectProviders: async () => ({
          claude: true,
          opencode: true,
          codex: false,
          pi: false,
        }),
        createProvider: (name) => {
          const provider = fakeProvider(name, uninstalled);
          if (name === "claude") {
            return {
              ...provider,
              uninstall: async () => {
                throw new Error("claude uninstall exploded");
              },
            };
          }
          return provider;
        },
      });

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.uninstalled).toBe(false);
        expect(result.value.providers.opencode.uninstalled).toBe(true);
        expect(result.value.errors.join("\n")).toContain("claude uninstall exploded");
        expect(result.value.removed).toContain(join(testHome, "system"));
        expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
        expect(uninstalled).toEqual(["opencode"]);
      }
    });

    test("full uninstall reports unregister failures without aborting later cleanup", async () => {
      await setupInitializedHome({ claude: true, opencode: true, codex: false, pi: false });
      const uninstalled: ProviderName[] = [];
      const service = createService({
        detectProviders: async () => ({
          claude: true,
          opencode: true,
          codex: false,
          pi: false,
        }),
        createProvider: (name) => {
          const provider = fakeProvider(name, uninstalled);
          if (name === "claude") {
            return {
              ...provider,
              unregisterMcpServer: async () => {
                throw new Error("mcp remove failed");
              },
            };
          }
          return provider;
        },
      });

      const result = await service.uninstall({ deleteUserData: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.uninstalled).toBe(false);
        expect(result.value.providers.opencode.uninstalled).toBe(true);
        expect(result.value.errors.join("\n")).toContain("mcp remove failed");
        expect(result.value.removed).not.toContain(join(testHome, "config.json"));
        expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
        expect(uninstalled).toEqual(["claude", "opencode"]);
      }
    });

    test("providers result has an entry for every registered provider", async () => {
      await setupInitializedHome({ claude: true, opencode: false, codex: false, pi: false });
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false, codex: false, pi: false }),
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
