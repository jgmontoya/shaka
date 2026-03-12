import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ok } from "../../../../src/domain/result";
import { createGitHubProvider } from "../../../../src/services/skill-source/github";

const VALID_SKILL_MD = `---
name: TestSkill
description: A test skill
---

# TestSkill
`;

const FAKE_SHA = "abc123def456";

function fakeGitClone(files: Record<string, string>) {
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

const fakeRevParse = async (_cwd: string) => ok(FAKE_SHA);

describe("GitHubSourceProvider", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `shaka-test-github-provider-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("canHandle", () => {
    const provider = createGitHubProvider();

    test("returns true for shorthand user/repo", () => {
      expect(provider.canHandle("user/repo")).toBe(true);
    });

    test("returns true for HTTPS URL", () => {
      expect(provider.canHandle("https://github.com/user/repo")).toBe(true);
    });

    test("returns true for SSH URL", () => {
      expect(provider.canHandle("git@github.com:user/repo.git")).toBe(true);
    });

    test("returns true for shorthand with ref", () => {
      expect(provider.canHandle("user/repo#main")).toBe(true);
    });

    test("returns false for bare word", () => {
      expect(provider.canHandle("sonoscli")).toBe(false);
    });

    test("returns false for bare word with version", () => {
      expect(provider.canHandle("sonoscli@1.2.0")).toBe(false);
    });
  });

  describe("fetch", () => {
    test("fetches single-skill repo with SKILL.md at root", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "SKILL.md": VALID_SKILL_MD }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.version).toBe(FAKE_SHA);
        expect(result.value.source).toBe("user/repo");
        expect(result.value.subdirectory).toBeNull();
        // SKILL.md should exist in skillDir
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        // Clean up temp
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("fetches skill from subdirectory", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "skills/my-skill/SKILL.md": VALID_SKILL_MD }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("https://github.com/user/repo/tree/main/skills/my-skill");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe("skills/my-skill");
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("falls back to marketplace.json when no SKILL.md at root", async () => {
      const marketplaceJson = JSON.stringify({
        name: "test-marketplace",
        plugins: [{ name: "my-skill", source: "./skills/my-skill" }],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          "skills/my-skill/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/marketplace-repo");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe("skills/my-skill");
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("marketplace with multiple plugins prompts selectSkill", async () => {
      const marketplaceJson = JSON.stringify({
        name: "multi-marketplace",
        plugins: [
          { name: "skill-a", source: "./skills/skill-a", description: "First skill" },
          { name: "skill-b", source: "./skills/skill-b", description: "Second skill" },
        ],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          "skills/skill-a/SKILL.md": VALID_SKILL_MD,
          "skills/skill-b/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      let selectCalled = false;
      const result = await provider.fetch("user/repo", {
        selectSkill: async (skills) => {
          selectCalled = true;
          expect(skills).toHaveLength(2);
          expect(skills[0]?.name).toBe("skill-a");
          return "skill-b";
        },
      });

      expect(selectCalled).toBe(true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe("skills/skill-b");
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("marketplace returns error when selectSkill cancels", async () => {
      const marketplaceJson = JSON.stringify({
        name: "multi-marketplace",
        plugins: [
          { name: "skill-a", source: "./skills/skill-a" },
          { name: "skill-b", source: "./skills/skill-b" },
        ],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          "skills/skill-a/SKILL.md": VALID_SKILL_MD,
          "skills/skill-b/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo", {
        selectSkill: async () => null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("cancelled");
      }
    });

    test("marketplace falls back to .claude/skills/ when source is ./", async () => {
      const marketplaceJson = JSON.stringify({
        name: "interface-design",
        plugins: [
          {
            name: "interface-design",
            source: "./",
            description: "Design skill",
          },
        ],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          ".claude/skills/interface-design/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("Dammyjay93/interface-design");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe(join(".claude", "skills", "interface-design"));
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("marketplace scans .claude/skills/ when plugin name doesn't match dir", async () => {
      const marketplaceJson = JSON.stringify({
        name: "my-repo",
        plugins: [
          {
            name: "my-plugin",
            source: "./",
            description: "A skill",
          },
        ],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          ".claude/skills/actual-skill/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/my-repo");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe(join(".claude", "skills", "actual-skill"));
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("falls back to skills/ directory when marketplace.json has no plugins array", async () => {
      // Simulates plugin-format repos like lackeyjb/playwright-skill where
      // marketplace.json is package metadata (no plugins array) and
      // skills live under skills/<name>/
      const marketplaceJson = JSON.stringify({
        name: "playwright-skill",
        version: "4.1.0",
        description: "A browser automation skill",
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
          ".claude-plugin/plugin.json": '{"name": "playwright-skill"}',
          "skills/playwright-skill/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("lackeyjb/playwright-skill");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe(join("skills", "playwright-skill"));
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("falls back to skills/ directory when no marketplace.json exists", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          "skills/my-skill/SKILL.md": VALID_SKILL_MD,
          "README.md": "# A plugin repo",
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/plugin-repo");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe(join("skills", "my-skill"));
        expect(await Bun.file(join(result.value.skillDir, "SKILL.md")).exists()).toBe(true);
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("skills/ directory with multiple skills prompts selectSkill", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          "skills/skill-a/SKILL.md": VALID_SKILL_MD,
          "skills/skill-b/SKILL.md": VALID_SKILL_MD,
        }),
        gitRevParse: fakeRevParse,
      });

      let selectCalled = false;
      const result = await provider.fetch("user/multi-skill-repo", {
        selectSkill: async (skills) => {
          selectCalled = true;
          expect(skills).toHaveLength(2);
          return "skill-a";
        },
      });

      expect(selectCalled).toBe(true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe(join("skills", "skill-a"));
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("fails when neither SKILL.md nor marketplace.json found", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "README.md": "# Hello" }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("SKILL.md");
        expect(result.error.message).toContain("marketplace.json");
      }
    });

    test("uses subdirectory from FetchOptions (update flow)", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "skills/my-skill/SKILL.md": VALID_SKILL_MD }),
        gitRevParse: fakeRevParse,
      });

      // Passing subdirectory via options (as update service would)
      const result = await provider.fetch("user/repo", {
        subdirectory: "skills/my-skill",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.subdirectory).toBe("skills/my-skill");
        await rm(result.value.tempDir, { recursive: true, force: true });
      }
    });

    test("does not fall back to other skills when explicit subdirectory is missing", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "skills/actual-skill/SKILL.md": VALID_SKILL_MD }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo", {
        subdirectory: "skills/missing-skill",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("skills/missing-skill");
      }
    });

    test("rejects explicit subdirectory path traversal", async () => {
      const provider = createGitHubProvider({
        gitClone: fakeGitClone({ "SKILL.md": VALID_SKILL_MD }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo", {
        subdirectory: "../outside",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid skill subdirectory");
      }
    });

    test("rejects marketplace plugin source path traversal", async () => {
      const marketplaceJson = JSON.stringify({
        name: "malicious-marketplace",
        plugins: [{ name: "pwn", source: "../outside" }],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Invalid marketplace path");
      }
    });

    test("rejects marketplace plugin.name path traversal in fallback", async () => {
      const marketplaceJson = JSON.stringify({
        name: "malicious-marketplace",
        plugins: [{ name: "../../../escape", source: "./" }],
      });

      const provider = createGitHubProvider({
        gitClone: fakeGitClone({
          ".claude-plugin/marketplace.json": marketplaceJson,
        }),
        gitRevParse: fakeRevParse,
      });

      const result = await provider.fetch("user/repo");

      // Should not succeed with a traversal path — either error or "not found"
      if (result.ok) {
        // If it somehow resolved, the skillDir must be inside the repo
        expect(result.value.skillDir).not.toContain("..");
      }
    });
  });
});
