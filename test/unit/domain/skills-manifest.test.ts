import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InstalledSkill,
  type SkillsManifest,
  addSkill,
  emptyManifest,
  loadManifest,
  removeSkill,
  saveManifest,
} from "../../../src/domain/skills-manifest";

const TEST_SKILL: InstalledSkill = {
  source: "https://github.com/user/repo",
  provider: "github",
  version: "abc123",
  subdirectory: null,
  installedAt: "2026-02-11T00:00:00.000Z",
};

describe("SkillsManifest", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `shaka-test-manifest-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("emptyManifest", () => {
    test("returns manifest with version 1 and no skills", () => {
      const manifest = emptyManifest();
      expect(manifest.version).toBe(1);
      expect(manifest.skills).toEqual({});
    });
  });

  describe("loadManifest", () => {
    test("returns empty manifest when file does not exist", async () => {
      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.version).toBe(1);
        expect(result.value.skills).toEqual({});
      }
    });

    test("loads existing manifest", async () => {
      const manifest: SkillsManifest = {
        version: 1,
        skills: { "my-skill": TEST_SKILL },
      };
      await Bun.write(join(tempDir, "skills.json"), JSON.stringify(manifest));

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills["my-skill"]).toEqual(TEST_SKILL);
      }
    });

    test("returns error for unsupported version", async () => {
      await Bun.write(join(tempDir, "skills.json"), JSON.stringify({ version: 99, skills: {} }));

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported skills manifest version");
      }
    });

    test("returns error for invalid JSON", async () => {
      await Bun.write(join(tempDir, "skills.json"), "not json");

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to read skills manifest");
      }
    });

    test("returns error for non-object content", async () => {
      await Bun.write(join(tempDir, "skills.json"), JSON.stringify("a string"));

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid skills manifest");
      }
    });

    test("returns error when skills field has invalid shape", async () => {
      await Bun.write(join(tempDir, "skills.json"), JSON.stringify({ version: 1, skills: [] }));

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("expected skills object");
      }
    });

    test("returns error when installed skill entry has invalid field types", async () => {
      await Bun.write(
        join(tempDir, "skills.json"),
        JSON.stringify({
          version: 1,
          skills: {
            "my-skill": {
              source: "user/repo",
              provider: "github",
              version: 123,
              subdirectory: null,
              installedAt: "2026-02-11T00:00:00.000Z",
            },
          },
        }),
      );

      const result = await loadManifest(tempDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("invalid version");
      }
    });
  });

  describe("saveManifest", () => {
    test("writes manifest to disk", async () => {
      const manifest = addSkill(emptyManifest(), "my-skill", TEST_SKILL);

      const result = await saveManifest(tempDir, manifest);
      expect(result.ok).toBe(true);

      const loaded = await loadManifest(tempDir);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value).toEqual(manifest);
      }
    });

    test("overwrites existing manifest", async () => {
      const first = addSkill(emptyManifest(), "skill-a", TEST_SKILL);
      await saveManifest(tempDir, first);

      const second = addSkill(emptyManifest(), "skill-b", TEST_SKILL);
      await saveManifest(tempDir, second);

      const loaded = await loadManifest(tempDir);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.skills["skill-a"]).toBeUndefined();
        expect(loaded.value.skills["skill-b"]).toEqual(TEST_SKILL);
      }
    });
  });

  describe("addSkill", () => {
    test("adds a skill to empty manifest", () => {
      const manifest = addSkill(emptyManifest(), "my-skill", TEST_SKILL);
      expect(manifest.skills["my-skill"]).toEqual(TEST_SKILL);
    });

    test("adds a second skill without removing the first", () => {
      let manifest = addSkill(emptyManifest(), "skill-a", TEST_SKILL);
      manifest = addSkill(manifest, "skill-b", {
        ...TEST_SKILL,
        source: "https://github.com/other/repo",
      });
      expect(Object.keys(manifest.skills)).toHaveLength(2);
      expect(manifest.skills["skill-a"]).toEqual(TEST_SKILL);
    });

    test("replaces skill with same name", () => {
      const updated: InstalledSkill = {
        ...TEST_SKILL,
        version: "def456",
      };
      let manifest = addSkill(emptyManifest(), "my-skill", TEST_SKILL);
      manifest = addSkill(manifest, "my-skill", updated);
      expect(manifest.skills["my-skill"]!.version).toBe("def456");
    });

    test("does not mutate original manifest", () => {
      const original = emptyManifest();
      addSkill(original, "my-skill", TEST_SKILL);
      expect(Object.keys(original.skills)).toHaveLength(0);
    });
  });

  describe("removeSkill", () => {
    test("removes an existing skill", () => {
      const manifest = addSkill(emptyManifest(), "my-skill", TEST_SKILL);
      const result = removeSkill(manifest, "my-skill");
      expect(result.skills["my-skill"]).toBeUndefined();
    });

    test("no-op when skill does not exist", () => {
      const manifest = emptyManifest();
      const result = removeSkill(manifest, "nonexistent");
      expect(result).toEqual(emptyManifest());
    });

    test("preserves other skills", () => {
      let manifest = addSkill(emptyManifest(), "skill-a", TEST_SKILL);
      manifest = addSkill(manifest, "skill-b", TEST_SKILL);
      const result = removeSkill(manifest, "skill-a");
      expect(result.skills["skill-a"]).toBeUndefined();
      expect(result.skills["skill-b"]).toEqual(TEST_SKILL);
    });

    test("does not mutate original manifest", () => {
      const manifest = addSkill(emptyManifest(), "my-skill", TEST_SKILL);
      removeSkill(manifest, "my-skill");
      expect(manifest.skills["my-skill"]).toEqual(TEST_SKILL);
    });
  });
});
