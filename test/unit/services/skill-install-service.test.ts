import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ok } from "../../../src/domain/result";
import { loadManifest } from "../../../src/domain/skills-manifest";
import { validateSkillStructure } from "../../../src/services/skill-pipeline";
import {
  type SecurityReport,
  installSkill,
  runSecurityChecks,
  scanForExecutableContent,
} from "../../../src/services/skill-install-service";
import { createGitHubProvider } from "../../../src/services/skill-source/github";

const VALID_SKILL_MD = `---
name: TestSkill
description: A test skill
key: test-skill
---

# TestSkill

Some content here.
`;

const NO_NAME_SKILL_MD = `---
description: Missing name
---

# Oops
`;

/** Fake git clone that writes a SKILL.md into the dest directory. */
function fakeGitClone(skillMd: string = VALID_SKILL_MD) {
  return async (_url: string, dest: string, _ref: string | null) => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "SKILL.md"), skillMd);
    return ok(undefined);
  };
}

/** Fake git clone that writes files into a subdirectory. */
function fakeGitCloneWithSubdir(subdir: string, skillMd: string = VALID_SKILL_MD) {
  return async (_url: string, dest: string, _ref: string | null) => {
    await mkdir(join(dest, subdir), { recursive: true });
    await writeFile(join(dest, subdir, "SKILL.md"), skillMd);
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

const FAKE_SHA = "abc123def456";
const fakeRevParse = async (_cwd: string) => ok(FAKE_SHA);

/** Create a GitHub provider with mocked git for testing. */
function testProvider(gitClone = fakeGitClone()) {
  return createGitHubProvider({ gitClone, gitRevParse: fakeRevParse });
}

describe("SkillInstallService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `shaka-test-install-${Date.now()}`);
    await mkdir(join(tempDir, "skills"), { recursive: true });
    await mkdir(join(tempDir, "system", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("installSkill", () => {
    test("installs a valid skill from shorthand URL", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("TestSkill");
        expect(result.value.skill.source).toBe("user/repo");
        expect(result.value.skill.version).toBe(FAKE_SHA);
      }
    });

    test("installs skill and updates manifest", async () => {
      await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      const manifest = await loadManifest(tempDir);
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        expect(manifest.value.skills.TestSkill).toBeDefined();
        expect(manifest.value.skills.TestSkill?.source).toBe("user/repo");
      }
    });

    test("copies SKILL.md to skills/<name>/", async () => {
      await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      const skillMd = Bun.file(join(tempDir, "skills", "TestSkill", "SKILL.md"));
      expect(await skillMd.exists()).toBe(true);
    });

    test("does not copy nested .git directories into installed skills", async () => {
      await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "nested/.git/config": "[core]\nrepositoryformatversion = 0",
            "nested/notes.md": "hello",
          }),
        ),
      });

      expect(
        await Bun.file(join(tempDir, "skills", "TestSkill", "nested", ".git", "config")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(join(tempDir, "skills", "TestSkill", "nested", "notes.md")).exists(),
      ).toBe(true);
    });

    test("handles subdirectory in URL", async () => {
      const result = await installSkill(
        tempDir,
        "https://github.com/user/repo/tree/main/skills/my-skill",
        {
          provider: testProvider(fakeGitCloneWithSubdir("skills/my-skill")),
        },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("TestSkill");
      }
    });

    test("fails on missing SKILL.md", async () => {
      const emptyClone = async (_url: string, dest: string, _ref: string | null) => {
        await mkdir(dest, { recursive: true });
        return ok(undefined);
      };

      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(emptyClone),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("SKILL.md");
      }
    });

    test("fails on SKILL.md without name field", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(fakeGitClone(NO_NAME_SKILL_MD)),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('"name" field');
      }
    });

    test("fails on system skill name collision", async () => {
      // Create a system skill with the same name
      await mkdir(join(tempDir, "system", "skills", "TestSkill"), { recursive: true });
      await writeFile(join(tempDir, "system", "skills", "TestSkill", "SKILL.md"), VALID_SKILL_MD);

      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("conflicts with a built-in system skill");
      }
    });

    test("fails on already-installed skill", async () => {
      // Install once
      await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      // Install again
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("already installed");
      }
    });

    test("fails fast when skills manifest is unreadable", async () => {
      await writeFile(join(tempDir, "skills.json"), "{invalid json");

      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to read skills manifest");
      }
      expect(await Bun.file(join(tempDir, "skills", "TestSkill", "SKILL.md")).exists()).toBe(false);
    });

    test("does not leave temp directory in shakaHome", async () => {
      await installSkill(tempDir, "user/repo", {
        provider: testProvider(),
      });

      // Temp dir is in OS tmpdir, not in shakaHome
      const tmpDir = join(tempDir, ".tmp");
      const exists = await stat(tmpDir).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });

  describe("security checks", () => {
    test("allows text-only skills without callback", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.txt": "notes",
            "config.yaml": "key: value",
          }),
        ),
      });

      expect(result.ok).toBe(true);
    });

    test("rejects executable files by default (no callback)", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "setup.sh": "#!/bin/bash\necho hi",
          }),
        ),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Security checks failed");
      }
    });

    test("rejects HTML comments in markdown by default", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.md": "Some text\n<!-- hidden instructions -->",
          }),
        ),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Security checks failed");
      }
    });

    test("rejects URLs in markdown by default", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "guide.md": "Visit https://evil.com for more info",
          }),
        ),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Security checks failed");
      }
    });

    test("rejects invisible unicode characters in markdown by default", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.md": "Normal text\u200Bhidden instructions",
          }),
        ),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Security checks failed");
      }
    });

    test("installs with --yolo despite failed checks", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "hook.ts": "console.log('hi')",
            "notes.md": "<!-- hidden -->\u200Bhttps://evil.com",
          }),
        ),
        yolo: true,
      });

      expect(result.ok).toBe(true);
    });

    test("calls onSecurityCheck with report when checks pass", async () => {
      let reportArg: SecurityReport | undefined;
      let nameArg: string | undefined;

      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.txt": "safe content",
          }),
        ),
        onSecurityCheck: async (report, name) => {
          reportArg = report;
          nameArg = name;
          return true;
        },
      });

      expect(reportArg).toBeDefined();
      expect((reportArg as SecurityReport).allPassed).toBe(true);
      expect((reportArg as SecurityReport).checks).toHaveLength(4);
      expect(nameArg).toBe("TestSkill");
      expect(result.ok).toBe(true);
    });

    test("calls onSecurityCheck with failed report", async () => {
      let reportArg: SecurityReport | undefined;

      await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "evil.sh": "rm -rf /",
          }),
        ),
        onSecurityCheck: async (report) => {
          reportArg = report;
          return false;
        },
      });

      expect(reportArg).toBeDefined();
      expect((reportArg as SecurityReport).allPassed).toBe(false);
      const execCheck = (reportArg as SecurityReport).checks.find(
        (c) => c.label === "No executables",
      );
      expect(execCheck?.passed).toBe(false);
      expect(execCheck?.details).toContain("evil.sh");
    });

    test("aborts when onSecurityCheck returns false", async () => {
      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "notes.txt": "safe",
          }),
        ),
        onSecurityCheck: async () => false,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe("InstallCancelledError");
      }
    });

    test("skips onSecurityCheck with --yolo", async () => {
      let callbackCalled = false;

      const result = await installSkill(tempDir, "user/repo", {
        provider: testProvider(
          fakeGitCloneWithFiles({
            "SKILL.md": VALID_SKILL_MD,
            "evil.sh": "rm -rf /",
            "guide.md": "<!-- hidden -->\u200Bhttps://bad.com",
          }),
        ),
        yolo: true,
        onSecurityCheck: async () => {
          callbackCalled = true;
          return false;
        },
      });

      expect(callbackCalled).toBe(false);
      expect(result.ok).toBe(true);
    });
  });

  describe("runSecurityChecks", () => {
    test("all pass for clean skill", async () => {
      const dir = join(tempDir, "clean-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "notes.txt"), "safe");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(true);
      expect(report.checks).toHaveLength(4);
      for (const check of report.checks) {
        expect(check.passed).toBe(true);
      }
    });

    test("detects executable files", async () => {
      const dir = join(tempDir, "exec-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "hook.sh"), "#!/bin/bash");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No executables");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("hook.sh");
    });

    test("detects extensionless files outside allowlist", async () => {
      const dir = join(tempDir, "noext-risky");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "install"), "#!/bin/bash\necho hi");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No executables");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("install");
    });

    test("detects HTML comments in markdown", async () => {
      const dir = join(tempDir, "html-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "extra.md"), "Normal text\n<!-- hidden instructions -->");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No html comments");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("extra.md");
    });

    test("detects URLs in markdown", async () => {
      const dir = join(tempDir, "url-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "guide.md"), "Visit https://example.com for details");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No URLs");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("guide.md");
    });

    test("detects http URLs in markdown", async () => {
      const dir = join(tempDir, "http-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "setup.md"), "Fetch from http://example.com/payload");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No URLs");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("setup.md");
    });

    test("detects zero-width characters in markdown", async () => {
      const dir = join(tempDir, "zwsp-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "sneaky.md"), "Normal\u200Bhidden instructions");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No invisible chars");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("sneaky.md");
    });

    test("detects RTL override characters in markdown", async () => {
      const dir = join(tempDir, "rtl-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "tricky.md"), "Text\u2066hidden\u2069 more");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const check = report.checks.find((c) => c.label === "No invisible chars");
      expect(check?.passed).toBe(false);
      expect(check?.details).toContain("tricky.md");
    });

    test("does not flag URLs in non-markdown files", async () => {
      const dir = join(tempDir, "txt-url");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "notes.txt"), "https://example.com");

      const report = await runSecurityChecks(dir);
      const check = report.checks.find((c) => c.label === "No URLs");
      expect(check?.passed).toBe(true);
    });

    test("does not flag HTML comments in non-markdown files", async () => {
      const dir = join(tempDir, "txt-html");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "config.json"), '{"key": "<!-- not flagged -->"}');

      const report = await runSecurityChecks(dir);
      const check = report.checks.find((c) => c.label === "No html comments");
      expect(check?.passed).toBe(true);
    });

    test("does not flag invisible chars in non-markdown files", async () => {
      const dir = join(tempDir, "txt-invisible");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "data.json"), '{"key": "val\u200Bue"}');

      const report = await runSecurityChecks(dir);
      const check = report.checks.find((c) => c.label === "No invisible chars");
      expect(check?.passed).toBe(true);
    });

    test("reports multiple failures simultaneously", async () => {
      const dir = join(tempDir, "multi-fail");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);
      await writeFile(join(dir, "hook.sh"), "#!/bin/bash");
      await writeFile(join(dir, "guide.md"), "<!-- hidden -->\u200Bhttps://evil.com");

      const report = await runSecurityChecks(dir);
      expect(report.allPassed).toBe(false);
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed.length).toBe(4);
    });
  });

  describe("scanForExecutableContent", () => {
    test("classifies safe extensions correctly", async () => {
      const dir = join(tempDir, "scan-safe");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "readme.md"), "hi");
      await writeFile(join(dir, "data.json"), "{}");
      await writeFile(join(dir, "config.yaml"), "");
      await writeFile(join(dir, "notes.txt"), "");

      const scan = await scanForExecutableContent(dir);
      expect(scan.safe).toHaveLength(4);
      expect(scan.executable).toHaveLength(0);
      expect(scan.unknown).toHaveLength(0);
    });

    test("classifies executable extensions correctly", async () => {
      const dir = join(tempDir, "scan-exec");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "hook.ts"), "");
      await writeFile(join(dir, "run.sh"), "");
      await writeFile(join(dir, "setup.py"), "");

      const scan = await scanForExecutableContent(dir);
      expect(scan.executable).toHaveLength(3);
      expect(scan.executable).toContain("hook.ts");
      expect(scan.executable).toContain("run.sh");
      expect(scan.executable).toContain("setup.py");
    });

    test("classifies unknown extensions correctly", async () => {
      const dir = join(tempDir, "scan-unknown");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "image.png"), "");
      await writeFile(join(dir, "data.bin"), "");

      const scan = await scanForExecutableContent(dir);
      expect(scan.unknown).toHaveLength(2);
    });

    test("treats files without extension as safe", async () => {
      const dir = join(tempDir, "scan-noext");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "LICENSE"), "MIT");
      await writeFile(join(dir, "README"), "hi");

      const scan = await scanForExecutableContent(dir);
      expect(scan.safe).toHaveLength(2);
    });

    test("treats extensionless files outside allowlist as unknown", async () => {
      const dir = join(tempDir, "scan-noext-unknown");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "install"), "#!/bin/bash\necho hi");

      const scan = await scanForExecutableContent(dir);
      expect(scan.safe).toHaveLength(0);
      expect(scan.unknown).toContain("install");
    });

    test("scans subdirectories recursively", async () => {
      const dir = join(tempDir, "scan-nested");
      await mkdir(join(dir, "sub"), { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "hi");
      await writeFile(join(dir, "sub", "hook.ts"), "");

      const scan = await scanForExecutableContent(dir);
      expect(scan.safe).toContain("SKILL.md");
      expect(scan.executable).toContain("sub/hook.ts");
    });

    test("ignores .git directory", async () => {
      const dir = join(tempDir, "scan-git");
      await mkdir(join(dir, ".git", "objects"), { recursive: true });
      await writeFile(join(dir, ".git", "HEAD"), "ref");
      await writeFile(join(dir, "SKILL.md"), "hi");

      const scan = await scanForExecutableContent(dir);
      expect(scan.safe).toHaveLength(1);
      expect(scan.executable).toHaveLength(0);
    });
  });

  describe("validateSkillStructure", () => {
    test("passes for valid SKILL.md with name", async () => {
      const dir = join(tempDir, "valid-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), VALID_SKILL_MD);

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("TestSkill");
      }
    });

    test("fails when SKILL.md is missing", async () => {
      const dir = join(tempDir, "no-skill");
      await mkdir(dir, { recursive: true });

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Missing SKILL.md");
      }
    });

    test("fails when name field is missing", async () => {
      const dir = join(tempDir, "bad-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), NO_NAME_SKILL_MD);

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('"name" field');
      }
    });

    test("rejects unsafe frontmatter name with path traversal", async () => {
      const dir = join(tempDir, "unsafe-name");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ../escape\ndescription: bad\n---\n\n# Escape\n`,
      );

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("safe directory name");
      }
    });

    test("rejects unsafe frontmatter name with separators", async () => {
      const dir = join(tempDir, "unsafe-separators");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: nested/skill\ndescription: bad\n---\n\n# Nested\n`,
      );

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("safe directory name");
      }
    });

    test("rejects Windows reserved device names", async () => {
      for (const reserved of ["CON", "prn", "aux", "NUL", "com1", "LPT3"]) {
        const dir = join(tempDir, `reserved-${reserved}`);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "SKILL.md"),
          `---\nname: ${reserved}\ndescription: bad\n---\n\n# Reserved\n`,
        );

        const result = await validateSkillStructure(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain("safe directory name");
        }
      }
    });

    test("parses YAML frontmatter with colon-containing values", async () => {
      const dir = join(tempDir, "yaml-skill");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: TestSkill\ndescription: "A skill: with colon"\n---\n\n# TestSkill\n`,
      );

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("TestSkill");
      }
    });

    test("parses frontmatter without trailing newline after closing ---", async () => {
      const dir = join(tempDir, "no-trailing-newline");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: TestSkill\ndescription: A test skill\n---`,
      );

      const result = await validateSkillStructure(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("TestSkill");
      }
    });
  });
});
