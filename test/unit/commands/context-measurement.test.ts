import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextMeasurement,
  collectMeasurements,
} from "../../../src/commands/context-measurement";
import { writeSummary } from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";
import { writeLearnings } from "../../../src/memory/learnings";
import type { LearningEntry } from "../../../src/memory/learnings";

const testDir = join(tmpdir(), `shaka-test-context-${process.pid}`);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.7.0",
    assistant: { name: "TestBot" },
    principal: { name: "Tester", timezone: "UTC" },
    providers: {
      claude: { enabled: false },
      opencode: { enabled: false },
    },
    memory: {
      learnings_budget: 6000,
      sessions_budget: 5000,
      recency_window_days: 90,
    },
    permissions: { managed: false },
    ...overrides,
  };
}

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "pattern",
    cwds: overrides.cwds ?? [process.cwd()],
    exposures: overrides.exposures ?? [{ date: "2026-02-20", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Test learning entry",
    body: overrides.body ?? "Some useful knowledge.",
  };
}

function makeSummary(
  overrides: Partial<{
    date: string;
    cwd: string;
    provider: "claude" | "opencode";
    sessionId: string;
    title: string;
    body: string;
  }> = {},
): SessionSummary {
  return {
    metadata: {
      date: overrides.date ?? "2026-02-20",
      cwd: overrides.cwd ?? process.cwd(),
      provider: overrides.provider ?? "claude",
      sessionId: overrides.sessionId ?? "ses-test-12345",
    },
    tags: ["test"],
    title: overrides.title ?? "Test Session",
    body: overrides.body ?? "## Summary\nDid some work.",
  };
}

async function writeConfig(shakaHome: string, config = makeConfig()) {
  await Bun.write(join(shakaHome, "config.json"), JSON.stringify(config, null, 2));
}

async function setupMinimalHome(shakaHome: string) {
  await mkdir(shakaHome, { recursive: true });
  await writeConfig(shakaHome);
}

describe("collectMeasurements", () => {
  let savedShakaHome: string | undefined;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
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

  describe("empty installation", () => {
    test("handles missing directories gracefully", async () => {
      await setupMinimalHome(testDir);
      const m = await collectMeasurements(testDir);

      expect(m.shakaHome).toBe(testDir);
      expect(m.framework.chars).toBe(0);
      expect(m.userFiles).toEqual([]);
      expect(m.learnings.chars).toBe(0);
      expect(m.learnings.entryCount).toBe(0);
      expect(m.learnings.selectedCount).toBe(0);
      expect(m.sessions.chars).toBe(0);
      expect(m.sessions.fileCount).toBe(0);
      expect(m.rollups.chars).toBe(0);
      expect(m.rollups.totalOnDisk).toBe(0);
      expect(m.security.chars).toBe(0);
    });

    test("identity header is always nonzero", async () => {
      await setupMinimalHome(testDir);
      const m = await collectMeasurements(testDir);

      expect(m.identity.chars).toBeGreaterThan(0);
      expect(m.identity.name).toBe("Identity + Wrapper");
    });

    test("uses config names in identity header detail", async () => {
      await setupMinimalHome(testDir);
      const m = await collectMeasurements(testDir);

      expect(m.identity.hook).toBe("SessionStart");
    });
  });

  describe("framework measurement", () => {
    test("measures framework file via loadShakaFile", async () => {
      await setupMinimalHome(testDir);
      const systemDir = join(testDir, "system");
      await mkdir(systemDir, { recursive: true });
      const content = "# Reasoning Framework\n\nSome content here.";
      await Bun.write(join(systemDir, "base-reasoning-framework.md"), content);

      const m = await collectMeasurements(testDir);

      expect(m.framework.chars).toBe(content.length);
    });
  });

  describe("user files measurement", () => {
    test("measures user markdown files", async () => {
      await setupMinimalHome(testDir);
      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });

      const content = "# My Goals\n\nBe productive.";
      await Bun.write(join(userDir, "goals.md"), content);

      const m = await collectMeasurements(testDir);

      expect(m.userFiles).toHaveLength(1);
      expect(m.userFiles[0]!.name).toBe("user/goals.md");
      expect(m.userFiles[0]!.chars).toBe(content.length);
    });

    test("skips empty files", async () => {
      await setupMinimalHome(testDir);
      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });

      await Bun.write(join(userDir, "empty.md"), "   \n  ");

      const m = await collectMeasurements(testDir);

      expect(m.userFiles).toHaveLength(0);
    });

    test("skips unmodified templates when system symlink exists", async () => {
      await setupMinimalHome(testDir);

      // Create a "defaults" directory with a template
      const defaultsDir = join(testDir, "test-defaults");
      await mkdir(join(defaultsDir, "system"), { recursive: true });
      await mkdir(join(defaultsDir, "user"), { recursive: true });

      const templateContent = "# Goals\n\nFill in your goals here.";
      await Bun.write(join(defaultsDir, "user", "goals.md"), templateContent);

      // Symlink system → defaults/system (matching real installation structure)
      await symlink(join(defaultsDir, "system"), join(testDir, "system"), "junction");

      // Write the same content as user file (unmodified)
      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });
      await Bun.write(join(userDir, "goals.md"), templateContent);

      // Write modified content for another file
      const modifiedContent = "# Missions\n\nMy custom missions.";
      await Bun.write(join(userDir, "missions.md"), modifiedContent);

      const m = await collectMeasurements(testDir);

      expect(m.userFiles).toHaveLength(2);

      const goals = m.userFiles.find((f) => f.name.includes("goals.md"));
      expect(goals!.name).toContain("SKIPPED");
      expect(goals!.chars).toBe(0);

      const missions = m.userFiles.find((f) => f.name.includes("missions.md"));
      expect(missions!.name).not.toContain("SKIPPED");
      expect(missions!.chars).toBe(modifiedContent.length);
    });
  });

  describe("learnings measurement", () => {
    test("measures learnings with real selection logic", async () => {
      await setupMinimalHome(testDir);
      const memoryDir = join(testDir, "memory");

      const entries = [
        makeEntry({ title: "First learning", body: "Details of first." }),
        makeEntry({ title: "Second learning", body: "Details of second." }),
      ];
      await writeLearnings(memoryDir, entries);

      const m = await collectMeasurements(testDir);

      expect(m.learnings.entryCount).toBe(2);
      expect(m.learnings.selectedCount).toBeGreaterThan(0);
      expect(m.learnings.chars).toBeGreaterThan(0);
      expect(m.learnings.totalOnDisk).toBeGreaterThan(0);
    });

    test("returns zero when no learnings exist", async () => {
      await setupMinimalHome(testDir);

      const m = await collectMeasurements(testDir);

      expect(m.learnings.entryCount).toBe(0);
      expect(m.learnings.selectedCount).toBe(0);
      expect(m.learnings.chars).toBe(0);
    });
  });

  describe("sessions measurement", () => {
    test("measures sessions with real selection logic", async () => {
      await setupMinimalHome(testDir);
      const memoryDir = join(testDir, "memory");

      await writeSummary(memoryDir, makeSummary({ sessionId: "ses-1" }));
      await writeSummary(memoryDir, makeSummary({ sessionId: "ses-2" }));

      const m = await collectMeasurements(testDir);

      expect(m.sessions.fileCount).toBe(2);
      expect(m.sessions.selectedCount).toBeGreaterThan(0);
      expect(m.sessions.chars).toBeGreaterThan(0);
      expect(m.sessions.totalOnDisk).toBeGreaterThan(0);
    });

    test("returns zero when no sessions exist", async () => {
      await setupMinimalHome(testDir);

      const m = await collectMeasurements(testDir);

      expect(m.sessions.fileCount).toBe(0);
      expect(m.sessions.chars).toBe(0);
    });
  });

  describe("rollups measurement", () => {
    test("returns zero when no rollups exist", async () => {
      await setupMinimalHome(testDir);

      const m = await collectMeasurements(testDir);

      expect(m.rollups.chars).toBe(0);
      expect(m.rollups.totalOnDisk).toBe(0);
    });
  });

  describe("format reminder measurement", () => {
    test("measures template files when they exist", async () => {
      await setupMinimalHome(testDir);
      const templatesDir = join(testDir, "system", "templates");
      await mkdir(templatesDir, { recursive: true });

      await Bun.write(
        join(templatesDir, "reminder-full.eta"),
        "Full reminder <% if (x) { %>dynamic<% } %> content",
      );
      await Bun.write(join(templatesDir, "reminder-iteration.eta"), "Iteration reminder");
      await Bun.write(join(templatesDir, "reminder-minimal.eta"), "Minimal");
      await Bun.write(join(templatesDir, "classification-prompt.eta"), "Classify this prompt");

      const m = await collectMeasurements(testDir);

      expect(m.formatReminder.full.chars).toBeGreaterThan(0);
      expect(m.formatReminder.iteration.chars).toBeGreaterThan(0);
      expect(m.formatReminder.minimal.chars).toBeGreaterThan(0);
      expect(m.formatReminder.classificationPrompt.chars).toBe("Classify this prompt".length);
    });

    test("returns zero when templates are missing", async () => {
      await setupMinimalHome(testDir);

      const m = await collectMeasurements(testDir);

      expect(m.formatReminder.full.chars).toBeGreaterThan(0); // still has typical line padding
      expect(m.formatReminder.minimal.chars).toBe(0);
      expect(m.formatReminder.classificationPrompt.chars).toBe(0);
    });
  });

  describe("aggregation", () => {
    test("sessionStartTotal equals sum of non-skipped components", async () => {
      await setupMinimalHome(testDir);
      const systemDir = join(testDir, "system");
      await mkdir(systemDir, { recursive: true });
      await Bun.write(join(systemDir, "base-reasoning-framework.md"), "# Framework\n\nContent.");

      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });
      await Bun.write(join(userDir, "goals.md"), "# Goals\n\nMy goals here.");

      const m = await collectMeasurements(testDir);

      const manualSum =
        m.framework.chars +
        m.identity.chars +
        m.userFiles.filter((f) => !f.skipped).reduce((s, f) => s + f.chars, 0) +
        m.learnings.chars +
        m.rollups.chars +
        m.sessions.chars +
        m.separators.chars;

      expect(m.sessionStartTotal).toBe(manualSum);
    });

    test("separator count reflects injected parts", async () => {
      await setupMinimalHome(testDir);
      const systemDir = join(testDir, "system");
      await mkdir(systemDir, { recursive: true });
      await Bun.write(join(systemDir, "base-reasoning-framework.md"), "# Framework");

      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });
      await Bun.write(join(userDir, "notes.md"), "# Notes\n\nSome notes.");

      // No learnings, sessions, or rollups → partCount = 1 (framework) + 1 (user file) = 2
      const m = await collectMeasurements(testDir);

      const sep = "\n\n---\n\n";
      expect(m.separators.chars).toBe(sep.length * 1); // 2 parts → 1 separator
    });

    test("separator count increases with learnings and sessions", async () => {
      await setupMinimalHome(testDir);
      const systemDir = join(testDir, "system");
      await mkdir(systemDir, { recursive: true });
      await Bun.write(join(systemDir, "base-reasoning-framework.md"), "# Framework");

      const memoryDir = join(testDir, "memory");
      await writeLearnings(memoryDir, [makeEntry()]);
      await writeSummary(memoryDir, makeSummary());

      // partCount = 1 (framework) + 1 (learnings) + 1 (sessions) = 3
      const m = await collectMeasurements(testDir);

      const sep = "\n\n---\n\n";
      expect(m.separators.chars).toBe(sep.length * 2); // 3 parts → 2 separators
    });

    test("skipped user files do not count as parts", async () => {
      await setupMinimalHome(testDir);

      // Create a symlinked system dir with matching template
      const defaultsDir = join(testDir, "test-defaults");
      await mkdir(join(defaultsDir, "system"), { recursive: true });
      await mkdir(join(defaultsDir, "user"), { recursive: true });
      const templateContent = "# Template\n\nDefault content.";
      await Bun.write(join(defaultsDir, "user", "goals.md"), templateContent);
      await symlink(join(defaultsDir, "system"), join(testDir, "system"), "junction");

      // User file identical to template → skipped
      const userDir = join(testDir, "user");
      await mkdir(userDir, { recursive: true });
      await Bun.write(join(userDir, "goals.md"), templateContent);

      const m = await collectMeasurements(testDir);
      const skipped = m.userFiles.find((f) => f.skipped);
      expect(skipped).toBeDefined();

      // partCount = 0 (no framework, no injected user files, no memory) → 0 separators
      expect(m.separators.chars).toBe(0);
    });
  });

  describe("security measurement", () => {
    test("always reports zero injected chars", async () => {
      await setupMinimalHome(testDir);
      const secDir = join(testDir, "system", "security");
      await mkdir(secDir, { recursive: true });
      await Bun.write(join(secDir, "patterns.yaml"), "patterns:\n  - test: true\n");

      const m = await collectMeasurements(testDir);

      expect(m.security.chars).toBe(0);
      expect(m.security.detail).toContain("NOT injected");
    });
  });
});
