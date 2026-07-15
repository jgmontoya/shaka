import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSkill } from "../../../src/services/skills";

describe("loadSkill", () => {
  let savedShakaHome: string | undefined;
  let testDir: string;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    testDir = await mkdtemp(join(tmpdir(), "shaka-test-skills-"));
    process.env.SHAKA_HOME = testDir;
  });

  afterEach(async () => {
    if (savedShakaHome === undefined) {
      delete process.env.SHAKA_HOME;
    } else {
      process.env.SHAKA_HOME = savedShakaHome;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  test("returns customizations/ body when both customizations/ and system/ exist", async () => {
    const customDir = join(testDir, "customizations", "skills", "autoresearch");
    const systemDir = join(testDir, "system", "skills", "autoresearch");
    await mkdir(customDir, { recursive: true });
    await mkdir(systemDir, { recursive: true });
    await Bun.write(join(customDir, "SKILL.md"), "CUSTOM BODY");
    await Bun.write(join(systemDir, "SKILL.md"), "SYSTEM BODY");

    const body = await loadSkill("autoresearch");

    expect(body).toBe("CUSTOM BODY");
  });

  test("falls back to system/ when only system/ exists", async () => {
    const systemDir = join(testDir, "system", "skills", "autoresearch-setup");
    await mkdir(systemDir, { recursive: true });
    await Bun.write(join(systemDir, "SKILL.md"), "SYSTEM BODY");

    const body = await loadSkill("autoresearch-setup");

    expect(body).toBe("SYSTEM BODY");
  });

  test("returns empty string when neither path exists", async () => {
    const body = await loadSkill("NonExistent");

    expect(body).toBe("");
  });

  test("resolves shipped autoresearch-setup skill with expected markers", async () => {
    // Point SHAKA_HOME at the repo's defaults/ so loadSkill resolves the
    // committed SKILL.md — verifies the file exists and has stable shape.
    const defaultsDir = resolve(import.meta.dir, "..", "..", "..", "defaults");
    process.env.SHAKA_HOME = defaultsDir;

    const body = await loadSkill("autoresearch-setup");

    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("Output contract");
    expect(body).toContain("Required spec structure");
  });

  test("ships explicit benchmark-integrity guidance for autoresearch", async () => {
    const defaultsDir = resolve(import.meta.dir, "..", "..", "..", "defaults");
    process.env.SHAKA_HOME = defaultsDir;

    const body = await loadSkill("autoresearch");

    expect(body).toContain("Protect benchmark integrity");
    expect(body).toContain("special-case benchmark fixtures");
    expect(body).toContain("documented product contract");
  });
});
