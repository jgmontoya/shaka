import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ok } from "../../../src/domain/result";
import {
  type InstalledSkill,
  addSkill,
  emptyManifest,
  loadManifest,
  saveManifest,
} from "../../../src/domain/skills-manifest";
import { updateAllSkills, updateSkill } from "../../../src/services/skill-update-service";
import { createGitHubProvider } from "../../../src/services/skill-source/github";

const VALID_SKILL_MD = `---
name: TestSkill
description: A test skill
---

# TestSkill
`;

const ORIGINAL_SHA = "aaa111";
const UPDATED_SHA = "bbb222";

const TEST_SKILL: InstalledSkill = {
  source: "user/repo",
  provider: "github",
  version: ORIGINAL_SHA,
  subdirectory: null,
  installedAt: "2026-02-11T00:00:00.000Z",
};

function fakeGitClone(skillMd: string = VALID_SKILL_MD) {
  return async (_url: string, dest: string, _ref: string | null) => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "SKILL.md"), skillMd);
    return ok(undefined);
  };
}

/** Fake git clone that writes extra files alongside SKILL.md. */
function fakeGitCloneWithFiles(files: Record<string, string>) {
  return async (_url: string, dest: string, _ref: string | null) => {
    await mkdir(dest, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(dest, path);
      const dir = dirname(fullPath);
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content);
    }
    return ok(undefined);
  };
}

/** Create a GitHub provider with mocked git for testing. */
function testProvider(revParseSha: string = UPDATED_SHA, gitClone = fakeGitClone()) {
  return createGitHubProvider({
    gitClone,
    gitRevParse: async () => ok(revParseSha),
  });
}

describe("SkillUpdateService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `shaka-test-update-${Date.now()}`);
    await mkdir(join(tempDir, "skills"), { recursive: true });
    await mkdir(join(tempDir, "system", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function installFakeSkill(name: string, skill: InstalledSkill = TEST_SKILL): Promise<void> {
    const skillDir = join(tempDir, "skills", name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), VALID_SKILL_MD);

    const manifest = addSkill(emptyManifest(), name, skill);
    await saveManifest(tempDir, manifest);
  }

  describe("updateSkill", () => {
    test("updates skill with new commit", async () => {
      await installFakeSkill("TestSkill");

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.previousVersion).toBe(ORIGINAL_SHA);
        expect(result.value.newVersion).toBe(UPDATED_SHA);
        expect(result.value.upToDate).toBe(false);
      }
    });

    test("reports up-to-date when commit matches", async () => {
      await installFakeSkill("TestSkill");

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(ORIGINAL_SHA),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.upToDate).toBe(true);
      }
    });

    test("updates manifest with new commit SHA", async () => {
      await installFakeSkill("TestSkill");

      await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA),
      });

      const manifest = await loadManifest(tempDir);
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        expect(manifest.value.skills.TestSkill?.version).toBe(UPDATED_SHA);
      }
    });

    test("preserves original installedAt timestamp after update", async () => {
      await installFakeSkill("TestSkill");

      await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA),
      });

      const manifest = await loadManifest(tempDir);
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        expect(manifest.value.skills.TestSkill?.installedAt).toBe(TEST_SKILL.installedAt);
      }
    });

    test("does not update manifest when up-to-date", async () => {
      await installFakeSkill("TestSkill");

      await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(ORIGINAL_SHA),
      });

      const manifest = await loadManifest(tempDir);
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        expect(manifest.value.skills.TestSkill?.version).toBe(ORIGINAL_SHA);
      }
    });

    test("fails when skill not installed", async () => {
      const result = await updateSkill(tempDir, "NonExistent", {
        provider: testProvider(UPDATED_SHA),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not installed");
      }
    });

    test("rejects update when upstream skill was renamed", async () => {
      await installFakeSkill("TestSkill");

      const renamedMd = `---\nname: RenamedSkill\ndescription: A renamed skill\n---\n\n# RenamedSkill\n`;
      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA, fakeGitClone(renamedMd)),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("renamed upstream");
        expect(result.error.message).toContain("RenamedSkill");
      }
    });

    test("replaces skill files on disk", async () => {
      await installFakeSkill("TestSkill");

      const updatedMd = `---\nname: TestSkill\ndescription: Updated\n---\n# Updated`;
      await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA, fakeGitClone(updatedMd)),
      });

      const content = await Bun.file(join(tempDir, "skills", "TestSkill", "SKILL.md")).text();
      expect(content).toContain("Updated");
    });

    test("fails when updated version has invalid SKILL.md", async () => {
      await installFakeSkill("TestSkill");

      const badClone = async (_url: string, dest: string, _ref: string | null) => {
        await mkdir(dest, { recursive: true });
        // No SKILL.md written
        return ok(undefined);
      };

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA, badClone),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("SKILL.md");
      }
    });

    test("returns security warnings but still updates", async () => {
      await installFakeSkill("TestSkill");

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(
          UPDATED_SHA,
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "hook.sh": "#!/bin/bash\necho pwned",
          }),
        ),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.upToDate).toBe(false);
        expect(result.value.warnings).toBeDefined();
        expect(result.value.warnings?.length).toBeGreaterThan(0);
      }
    });

    test("returns no warnings for clean updates", async () => {
      await installFakeSkill("TestSkill");

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(UPDATED_SHA),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.warnings).toBeUndefined();
      }
    });

    test("does not deploy _backup directory into installed skill", async () => {
      await installFakeSkill("TestSkill");

      const result = await updateSkill(tempDir, "TestSkill", {
        provider: testProvider(
          UPDATED_SHA,
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.md": "hello",
          }),
        ),
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(join(tempDir, "skills", "TestSkill", "_backup")).exists()).toBe(false);
    });
  });

  describe("updateAllSkills", () => {
    test("updates all installed skills", async () => {
      const SECOND_SKILL_MD = `---\nname: SecondSkill\ndescription: A second skill\n---\n\n# SecondSkill\n`;

      const skillDirA = join(tempDir, "skills", "TestSkill");
      const skillDirB = join(tempDir, "skills", "SecondSkill");
      await mkdir(skillDirA, { recursive: true });
      await mkdir(skillDirB, { recursive: true });
      await writeFile(join(skillDirA, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(skillDirB, "SKILL.md"), SECOND_SKILL_MD);

      let manifest = addSkill(emptyManifest(), "TestSkill", TEST_SKILL);
      manifest = addSkill(manifest, "SecondSkill", { ...TEST_SKILL, source: "other/repo" });
      await saveManifest(tempDir, manifest);

      // Provider returns correct name per call (insertion order: TestSkill, SecondSkill)
      let callIdx = 0;
      const mds = [VALID_SKILL_MD, SECOND_SKILL_MD];
      const multiProvider = createGitHubProvider({
        gitClone: async (_url: string, dest: string, _ref: string | null) => {
          await mkdir(dest, { recursive: true });
          await writeFile(join(dest, "SKILL.md"), mds[callIdx++] ?? VALID_SKILL_MD);
          return ok(undefined);
        },
        gitRevParse: async () => ok(UPDATED_SHA),
      });

      const result = await updateAllSkills(tempDir, { provider: multiProvider });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.results).toHaveLength(2);
        expect(result.value.results.every((r) => r.newVersion === UPDATED_SHA)).toBe(true);
        expect(result.value.failures).toHaveLength(0);
      }
    });

    test("returns empty results when no skills installed", async () => {
      const result = await updateAllSkills(tempDir, {
        provider: testProvider(UPDATED_SHA),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.results).toHaveLength(0);
        expect(result.value.failures).toHaveLength(0);
      }
    });

    test("collects failures without losing successful results", async () => {
      // Install two skills: TestSkill (will succeed) and FailSkill (will fail)
      const skillDirA = join(tempDir, "skills", "TestSkill");
      const skillDirB = join(tempDir, "skills", "FailSkill");
      await mkdir(skillDirA, { recursive: true });
      await mkdir(skillDirB, { recursive: true });
      await writeFile(join(skillDirA, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(skillDirB, "SKILL.md"), `---\nname: FailSkill\n---`);

      let manifest = addSkill(emptyManifest(), "TestSkill", TEST_SKILL);
      manifest = addSkill(manifest, "FailSkill", { ...TEST_SKILL, source: "other/repo" });
      await saveManifest(tempDir, manifest);

      // Provider that succeeds for TestSkill but returns no SKILL.md for FailSkill
      let callCount = 0;
      const mixedProvider = createGitHubProvider({
        gitClone: async (_url: string, dest: string, _ref: string | null) => {
          callCount++;
          await mkdir(dest, { recursive: true });
          if (callCount === 1) {
            await writeFile(join(dest, "SKILL.md"), VALID_SKILL_MD);
          }
          // Second call: no SKILL.md → validation failure
          return ok(undefined);
        },
        gitRevParse: async () => ok(UPDATED_SHA),
      });

      const result = await updateAllSkills(tempDir, { provider: mixedProvider });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.results).toHaveLength(1);
        expect(result.value.results[0]?.name).toBe("TestSkill");
        expect(result.value.failures).toHaveLength(1);
        expect(result.value.failures[0]?.name).toBe("FailSkill");
      }
    });
  });
});
