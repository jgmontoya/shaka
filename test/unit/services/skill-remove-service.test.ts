import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledSkill } from "../../../src/domain/skills-manifest";
import {
  addSkill,
  emptyManifest,
  loadManifest,
  saveManifest,
} from "../../../src/domain/skills-manifest";
import { linkSkillToProviders } from "../../../src/services/skill-linker";
import { removeSkill } from "../../../src/services/skill-remove-service";

const TEST_SKILL: InstalledSkill = {
  source: "https://github.com/user/repo",
  provider: "github",
  version: "abc123",
  subdirectory: null,
  installedAt: "2026-02-11T00:00:00.000Z",
};

describe("SkillRemoveService", () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;
  let testXdgConfigHome: string;

  beforeEach(async () => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    tempDir = join(tmpdir(), `shaka-test-remove-${Date.now()}`);
    testXdgConfigHome = join(tmpdir(), `shaka-test-remove-xdg-${Date.now()}`);
    process.env.XDG_CONFIG_HOME = testXdgConfigHome;
    await mkdir(join(tempDir, "skills"), { recursive: true });
    await mkdir(join(tempDir, "system", "skills"), { recursive: true });
    await mkdir(testXdgConfigHome, { recursive: true });
  });

  afterEach(async () => {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    await rm(tempDir, { recursive: true, force: true });
    await rm(testXdgConfigHome, { recursive: true, force: true });
  });

  async function installFakeSkill(name: string): Promise<void> {
    // Create skill directory
    const skillDir = join(tempDir, "skills", name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}`);

    // Add to manifest
    const manifest = addSkill(emptyManifest(), name, TEST_SKILL);
    await saveManifest(tempDir, manifest);
  }

  async function writeConfig(enabled: { claude: boolean; opencode: boolean }): Promise<void> {
    await writeFile(
      join(tempDir, "config.json"),
      JSON.stringify({
        version: "1",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: enabled.claude },
          opencode: { enabled: enabled.opencode },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      }),
    );
  }

  test("removes an installed skill", async () => {
    await installFakeSkill("MySkill");

    const result = await removeSkill(tempDir, "MySkill");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe(TEST_SKILL.source);
    }
  });

  test("removes skill directory from disk", async () => {
    await installFakeSkill("MySkill");

    await removeSkill(tempDir, "MySkill");

    const skillMd = Bun.file(join(tempDir, "skills", "MySkill", "SKILL.md"));
    expect(await skillMd.exists()).toBe(false);
  });

  test("removes skill from manifest", async () => {
    await installFakeSkill("MySkill");

    await removeSkill(tempDir, "MySkill");

    const manifest = await loadManifest(tempDir);
    expect(manifest.ok).toBe(true);
    if (manifest.ok) {
      expect(manifest.value.skills.MySkill).toBeUndefined();
    }
  });

  test("fails on system skill", async () => {
    // Create a system skill
    await mkdir(join(tempDir, "system", "skills", "Council"), { recursive: true });
    await writeFile(
      join(tempDir, "system", "skills", "Council", "SKILL.md"),
      "---\nname: Council\n---",
    );

    const result = await removeSkill(tempDir, "Council");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("built-in system skill");
    }
  });

  test("fails on unknown skill", async () => {
    const result = await removeSkill(tempDir, "NonExistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not installed");
    }
  });

  test("preserves other skills in manifest", async () => {
    // Install two skills
    const skillDirA = join(tempDir, "skills", "SkillA");
    const skillDirB = join(tempDir, "skills", "SkillB");
    await mkdir(skillDirA, { recursive: true });
    await mkdir(skillDirB, { recursive: true });
    await writeFile(join(skillDirA, "SKILL.md"), "---\nname: SkillA\n---");
    await writeFile(join(skillDirB, "SKILL.md"), "---\nname: SkillB\n---");

    let manifest = addSkill(emptyManifest(), "SkillA", TEST_SKILL);
    manifest = addSkill(manifest, "SkillB", { ...TEST_SKILL, source: "other/repo" });
    await saveManifest(tempDir, manifest);

    // Remove only SkillA
    await removeSkill(tempDir, "SkillA");

    const updated = await loadManifest(tempDir);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.skills.SkillA).toBeUndefined();
      expect(updated.value.skills.SkillB).toBeDefined();
    }
  });

  test("removes provider symlink when removing skill", async () => {
    await installFakeSkill("MySkill");
    await writeConfig({ claude: false, opencode: true });

    await linkSkillToProviders(tempDir, "MySkill");
    const providerSkillDir = join(testXdgConfigHome, "opencode", "skills", "MySkill");
    expect(await Bun.file(join(providerSkillDir, "SKILL.md")).exists()).toBe(true);

    const result = await removeSkill(tempDir, "MySkill");
    expect(result.ok).toBe(true);
    expect(await Bun.file(providerSkillDir).exists()).toBe(false);
  });
});
