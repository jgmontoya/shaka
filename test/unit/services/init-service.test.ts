import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../../../src/domain/result";
import { ok } from "../../../src/domain/result";
import { resolveFromModule } from "../../../src/platform/paths";
import { InitService } from "../../../src/services/init-service";

describe("InitService", () => {
  const testHome = join(tmpdir(), "shaka-test-init");
  const defaultsPath = resolveFromModule(import.meta.url, "../../../defaults");

  // Mock bun link — always succeeds, never runs real bun link
  const mockBunLink = async (): Promise<Result<void, Error>> => ok(undefined);

  function createService(overrides: Record<string, unknown> = {}) {
    return new InitService({
      shakaHome: testHome,
      defaultsPath,
      detectProviders: async () => ({ claude: true, opencode: false }),
      runBunLink: mockBunLink,
      ...overrides,
    });
  }

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  describe("createDirectories", () => {
    test("creates user-owned directories (not system/)", async () => {
      const service = createService();

      const result = await service.createDirectories();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain(testHome);
        expect(result.value).toContain(join(testHome, "user"));
        expect(result.value).toContain(join(testHome, "memory"));
        expect(result.value).toContain(join(testHome, "customizations"));
        // system/ is NOT created here — it's a symlink
        expect(result.value).not.toContain(join(testHome, "system"));
        expect(result.value).not.toContain(join(testHome, "system", "hooks"));
      }
    });

    test("is idempotent", async () => {
      const service = createService();

      const result1 = await service.createDirectories();
      const result2 = await service.createDirectories();

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    });
  });

  describe("linkSystem", () => {
    test("creates symlink to defaults/system", async () => {
      const service = createService();
      await service.createDirectories();

      const result = await service.linkSystem();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]).toContain("→");
      }

      // Verify it's actually a symlink
      const stats = await lstat(join(testHome, "system"));
      expect(stats.isSymbolicLink()).toBe(true);

      // Verify target is correct
      const target = await readlink(join(testHome, "system"));
      expect(target).toBe(join(defaultsPath, "system"));
    });

    test("is idempotent — correct symlink is no-op", async () => {
      const service = createService();
      await service.createDirectories();

      await service.linkSystem();
      const result = await service.linkSystem();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // No symlinks created on second run
        expect(result.value.length).toBe(0);
      }
    });

    test("replaces symlink with wrong target", async () => {
      const service = createService();
      await service.createDirectories();

      // Create symlink to wrong target (use platform-appropriate path)
      await symlink(
        join(tmpdir(), "shaka-test-wrong-target"),
        join(testHome, "system"),
        "junction",
      );

      const result = await service.linkSystem();

      expect(result.ok).toBe(true);
      const target = await readlink(join(testHome, "system"));
      expect(target).toBe(join(defaultsPath, "system"));
    });

    test("errors if system/ is a real directory", async () => {
      const service = createService();
      await service.createDirectories();

      // Create real directory
      await mkdir(join(testHome, "system"), { recursive: true });

      const result = await service.linkSystem();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("exists as a real directory");
      }
    });
  });

  describe("copyUserTemplates", () => {
    test("copies all user templates on fresh install", async () => {
      const service = createService();
      await service.createDirectories();

      const result = await service.copyUserTemplates();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(0);
        // Should include the default user templates (rendered from .eta)
        expect(result.value.some((f) => f.endsWith("user.md"))).toBe(true);
        expect(result.value.some((f) => f.endsWith("assistant.md"))).toBe(true);
      }
    });

    test("renders .eta templates with default names when no personalization", async () => {
      const service = createService();
      await service.createDirectories();

      await service.copyUserTemplates();

      const userContent = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(userContent).toContain("**Name:** Chief");
      expect(userContent).not.toContain("<%=");

      const assistantContent = await Bun.file(join(testHome, "user", "assistant.md")).text();
      expect(assistantContent).toContain("**Name:** Shaka");
      expect(assistantContent).not.toContain("<%=");
    });

    test("renders .eta templates with personalized names", async () => {
      const service = createService();
      await service.createDirectories();

      await service.copyUserTemplates({
        principalName: "Master Bruce",
        assistantName: "Alfred",
      });

      const userContent = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(userContent).toContain("**Name:** Master Bruce");

      const assistantContent = await Bun.file(join(testHome, "user", "assistant.md")).text();
      expect(assistantContent).toContain("**Name:** Alfred");
      // Verify name substitution in examples too
      expect(assistantContent).toContain("Alfred found the issue");
      expect(assistantContent).toContain("When speaking to Master Bruce");
    });

    test("writes .md output files not .eta files", async () => {
      const service = createService();
      await service.createDirectories();

      await service.copyUserTemplates();

      // Output should be .md, not .eta
      expect(await Bun.file(join(testHome, "user", "user.md")).exists()).toBe(true);
      expect(await Bun.file(join(testHome, "user", "assistant.md")).exists()).toBe(true);
      expect(await Bun.file(join(testHome, "user", "user.md.eta")).exists()).toBe(false);
      expect(await Bun.file(join(testHome, "user", "assistant.md.eta")).exists()).toBe(false);
    });

    test("does not overwrite existing user files", async () => {
      const service = createService();
      await service.createDirectories();

      // Create an existing user file
      const customContent = "# My custom about me";
      await Bun.write(join(testHome, "user", "user.md"), customContent);

      const result = await service.copyUserTemplates();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // user.md should NOT be in the list of created files
        expect(result.value.some((f) => f.endsWith("user.md"))).toBe(false);
        // But other templates should be copied
        expect(result.value.some((f) => f.endsWith("assistant.md"))).toBe(true);
      }

      // Verify existing file was NOT overwritten
      const content = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(content).toBe(customContent);
    });

    test("copies new templates added in future versions", async () => {
      const service = createService();
      await service.createDirectories();

      // Simulate existing installation with some user files
      await Bun.write(join(testHome, "user", "user.md"), "existing");
      await Bun.write(join(testHome, "user", "goals.md"), "existing");

      const result = await service.copyUserTemplates();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only files that didn't exist should be copied
        expect(result.value.some((f) => f.endsWith("user.md"))).toBe(false);
        expect(result.value.some((f) => f.endsWith("goals.md"))).toBe(false);
        // New templates should be copied
        expect(result.value.some((f) => f.endsWith("assistant.md"))).toBe(true);
        expect(result.value.some((f) => f.endsWith("tech-stack.md"))).toBe(true);
      }
    });
  });

  describe("copyDefaultConfig", () => {
    test("creates config.json if not exists", async () => {
      const service = createService();
      await service.createDirectories();

      const result = await service.copyDefaultConfig();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain(join(testHome, "config.json"));
      }

      const content = await Bun.file(join(testHome, "config.json")).json();
      expect(content.version).toBe("0.7.1");
    });

    test("creates config.json with personalized names", async () => {
      const service = createService();
      await service.createDirectories();

      const result = await service.copyDefaultConfig({
        principalName: "Master Bruce",
        assistantName: "Alfred",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain(join(testHome, "config.json"));
      }

      const content = await Bun.file(join(testHome, "config.json")).json();
      expect(content.principal.name).toBe("Master Bruce");
      expect(content.assistant.name).toBe("Alfred");
    });

    test("does not overwrite existing config.json", async () => {
      const service = createService();
      await service.createDirectories();

      const existingContent = '{"version": "custom"}';
      await Bun.write(join(testHome, "config.json"), existingContent);

      const result = await service.copyDefaultConfig();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toContain(join(testHome, "config.json"));
      }

      const content = await Bun.file(join(testHome, "config.json")).text();
      expect(content).toBe(existingContent);
    });

    test("updates names in existing config.json when personalization provided", async () => {
      const service = createService();
      await service.createDirectories();

      await Bun.write(
        join(testHome, "config.json"),
        '{"version":"0.1.0","principal":{"name":"Old"},"assistant":{"name":"Old"}}',
      );

      const result = await service.copyDefaultConfig({
        principalName: "New",
        assistantName: "New",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Not listed as created (file already existed)
        expect(result.value).not.toContain(join(testHome, "config.json"));
      }

      const content = await Bun.file(join(testHome, "config.json")).json();
      expect(content.principal.name).toBe("New");
      expect(content.assistant.name).toBe("New");
    });
  });

  describe("linkLibrary", () => {
    test("calls bun link twice — register then link shaka", async () => {
      const calls: Array<{ cwd: string; args: string[] }> = [];
      const trackingBunLink = async (cwd: string, args: string[]): Promise<Result<void, Error>> => {
        calls.push({ cwd, args });
        return ok(undefined);
      };

      const service = createService({ runBunLink: trackingBunLink });
      const result = await service.linkLibrary();

      expect(result.ok).toBe(true);
      expect(calls.length).toBe(2);

      // First call: bun link (register globally) — from repo root
      expect(calls[0]?.args).toEqual([]);

      // Second call: bun link shaka (link at shakaHome)
      expect(calls[1]?.cwd).toBe(testHome);
      expect(calls[1]?.args).toEqual(["shaka"]);
    });
  });

  describe("init", () => {
    test("returns error when no providers detected", async () => {
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false }),
      });

      const result = await service.init();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No AI providers detected");
      }
    });

    test("succeeds with full flow on fresh install", async () => {
      const service = createService();

      const result = await service.init();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.detected).toBe(true);
        expect(result.value.providers.claude.installed).toBe(true);
        expect(result.value.currentVersion).toBe("0.7.1");
        expect(result.value.directories.length).toBeGreaterThan(0);
        expect(result.value.files.length).toBeGreaterThan(0);
      }

      // Verify system symlink exists
      const stats = await lstat(join(testHome, "system"));
      expect(stats.isSymbolicLink()).toBe(true);

      // Verify user templates were copied
      expect(await Bun.file(join(testHome, "user", "user.md")).exists()).toBe(true);

      // Verify config was copied
      expect(await Bun.file(join(testHome, "config.json")).exists()).toBe(true);
    });

    test("is idempotent — re-init succeeds", async () => {
      const service = createService();

      await service.init();
      const result = await service.init();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.currentVersion).toBe("0.7.1");
      }
    });

    test("respects providers array — installs only selected", async () => {
      const service = createService({
        detectProviders: async () => ({ claude: true, opencode: true }),
      });

      const result = await service.init({ providers: ["claude"] });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.installed).toBe(true);
        expect(result.value.providers.opencode.installed).toBe(false);
      }
    });

    test("skips unavailable providers in selection", async () => {
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: true }),
      });

      const result = await service.init({ providers: ["claude", "opencode"] });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // claude requested but not detected — skipped
        expect(result.value.providers.claude.installed).toBe(false);
        // opencode requested and detected — installed
        expect(result.value.providers.opencode.installed).toBe(true);
      }
    });

    test("returns error if all selected providers are unavailable", async () => {
      const service = createService({
        detectProviders: async () => ({ claude: false, opencode: false }),
      });

      const result = await service.init({ providers: ["claude"] });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No AI providers detected");
      }
    });

    test("installs all detected when no providers specified", async () => {
      const service = createService({
        detectProviders: async () => ({ claude: true, opencode: true }),
      });

      const result = await service.init();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.providers.claude.installed).toBe(true);
        expect(result.value.providers.opencode.installed).toBe(true);
      }
    });

    test("preserves user files on re-init", async () => {
      const service = createService();

      // First init
      await service.init();

      // User customizes a file
      await Bun.write(join(testHome, "user", "user.md"), "# Custom content");
      await Bun.write(join(testHome, "config.json"), '{"version":"0.3.0","custom":true}');

      // Re-init
      const result = await service.init();

      expect(result.ok).toBe(true);

      // User file preserved
      const aboutMe = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(aboutMe).toBe("# Custom content");

      // Config preserved
      const config = await Bun.file(join(testHome, "config.json")).json();
      expect(config.custom).toBe(true);
    });

    test("init with personalization renders templates and config with names", async () => {
      const service = createService();

      const result = await service.init({
        personalization: {
          principalName: "Master Bruce",
          assistantName: "Alfred",
        },
      });

      expect(result.ok).toBe(true);

      // User templates rendered with names
      const userContent = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(userContent).toContain("**Name:** Master Bruce");

      const assistantContent = await Bun.file(join(testHome, "user", "assistant.md")).text();
      expect(assistantContent).toContain("**Name:** Alfred");

      // Config has personalized names
      const config = await Bun.file(join(testHome, "config.json")).json();
      expect(config.principal.name).toBe("Master Bruce");
      expect(config.assistant.name).toBe("Alfred");
    });

    test("init without personalization uses default names", async () => {
      const service = createService();

      const result = await service.init();

      expect(result.ok).toBe(true);

      // User templates rendered with defaults
      const userContent = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(userContent).toContain("**Name:** Chief");

      const assistantContent = await Bun.file(join(testHome, "user", "assistant.md")).text();
      expect(assistantContent).toContain("**Name:** Shaka");

      // Config has default names
      const config = await Bun.file(join(testHome, "config.json")).json();
      expect(config.principal.name).toBe("Chief");
      expect(config.assistant.name).toBe("Shaka");
    });

    test("re-init with personalization updates names but preserves user files", async () => {
      const service = createService();

      // First init with personalization
      await service.init({
        personalization: {
          principalName: "Master Bruce",
          assistantName: "Alfred",
        },
      });

      // Verify initial state
      const initialConfig = await Bun.file(join(testHome, "config.json")).json();
      expect(initialConfig.principal.name).toBe("Master Bruce");

      // Re-init with different names — config names should update
      const result = await service.init({
        personalization: { principalName: "Other", assistantName: "Bot" },
      });

      expect(result.ok).toBe(true);

      // Config names updated
      const config = await Bun.file(join(testHome, "config.json")).json();
      expect(config.principal.name).toBe("Other");
      expect(config.assistant.name).toBe("Bot");

      // User templates preserved from first init (not overwritten)
      const userContent = await Bun.file(join(testHome, "user", "user.md")).text();
      expect(userContent).toContain("**Name:** Master Bruce");
    });
  });
});
