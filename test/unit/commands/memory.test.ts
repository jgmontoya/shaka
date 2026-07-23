import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock inference so dedup/contradiction passes are no-ops
mock.module("../../../src/inference", () => ({
  inference: async () => ({ success: true, text: "NO DUPLICATES" }),
  hasInferenceProvider: async () => false,
}));

import { createMemoryCommand } from "../../../src/commands/memory/index";
import { CONDENSATION_COMMIT_FILE } from "../../../src/memory/condensation-commit";
import { rebuildIndex } from "../../../src/memory/knowledge";
import { appendToArchive, writeLearnings } from "../../../src/memory/learning-store";
import { type LearningEntry, loadLearnings, renderLearnings } from "../../../src/memory/learnings";
import { projectSlug } from "../../../src/memory/rollups";
import { writeSummary } from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";
import { hashContent } from "../../../src/memory/utils";
import { makeRunShaka } from "../../helpers/run-shaka";
import { testCwd, testCwds } from "../../helpers/memory-path";

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? testCwds("/projects/myapp"),
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Default Title",
    body: overrides.body ?? "Default body.",
    ...(overrides.promotionEvidence === undefined
      ? {}
      : { promotionEvidence: overrides.promotionEvidence }),
  };
}

function emptyMigrationCounts() {
  return {
    wildcardRecordsExamined: 0,
    recordsCanonicalized: 0,
    recordsEnriched: 0,
    recordsUnchanged: 0,
    globalNonglobalNormalized: 0,
    exposureJoinsResolved: 0,
    exposureJoinsMissing: 0,
    exposureJoinsAmbiguous: 0,
    relativeCandidatesDropped: 0,
    optionalHistoryFailures: 0,
    sourceContributions: {
      exposure: 0,
      activeMixed: 0,
      backupPromotion: 0,
      backupScoped: 0,
      backupMixed: 0,
      archivePromotion: 0,
      archiveScoped: 0,
      archiveMixed: 0,
    },
  };
}

let testDir: string;
let memoryDir: string;

describe("memory consolidate", () => {
  let savedShakaHome: string | undefined;
  let savedIsTTY: boolean | undefined;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    savedIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = undefined as unknown as boolean;
    testDir = await mkdtemp(join(tmpdir(), "shaka-test-memory-"));
    memoryDir = join(testDir, "memory");
    process.env.SHAKA_HOME = testDir;
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    process.stdin.isTTY = savedIsTTY as boolean;
    if (savedShakaHome === undefined) {
      process.env.SHAKA_HOME = undefined;
    } else {
      process.env.SHAKA_HOME = savedShakaHome;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  test("non-interactive consolidation applies automatic scope generalization", async () => {
    // Need 20+ entries to exceed consolidation threshold
    const entries: LearningEntry[] = [];
    for (let i = 0; i < 18; i++) {
      entries.push(makeEntry({ title: `Filler entry ${i}` }));
    }
    // Two entries with same title and three independent top-level branches.
    entries.push(makeEntry({ title: "Same Title", cwds: testCwds("/a", "/b", "/c") }));
    entries.push(makeEntry({ title: "Same Title", cwds: testCwds("/d", "/e", "/f") }));

    await writeLearnings(memoryDir, entries);

    const cmd = createMemoryCommand();
    await cmd.parseAsync(["consolidate"], { from: "user" });

    const result = await loadLearnings(memoryDir);
    const generalized = result.filter((e) => e.title === "Same Title");

    expect(generalized).toHaveLength(2);
    expect(generalized[0]?.cwds).toEqual(["*"]);
    expect(generalized[1]?.cwds).toEqual(["*"]);
    expect(generalized[0]?.promotionEvidence).toEqual({
      sourceCwds: testCwds("/a", "/b", "/c"),
      excludedCwds: [],
      exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
      reasons: ["automatic-hierarchical-generalization"],
    });
    expect(generalized[1]?.promotionEvidence).toEqual({
      sourceCwds: testCwds("/d", "/e", "/f"),
      excludedCwds: [],
      exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
      reasons: ["automatic-hierarchical-generalization"],
    });
  });
});

describe("memory mutation command errors", () => {
  let commandRoot: string;
  let savedExitCode: typeof process.exitCode;
  let savedShakaHome: string | undefined;

  beforeEach(async () => {
    commandRoot = await mkdtemp(join(tmpdir(), "shaka-memory-command-error-"));
    savedExitCode = process.exitCode;
    savedShakaHome = process.env.SHAKA_HOME;
    process.exitCode = 0;
    process.env.SHAKA_HOME = commandRoot;
    await mkdir(join(commandRoot, "memory"), { recursive: true });
  });

  afterEach(async () => {
    process.exitCode = savedExitCode ?? 0;
    if (savedShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = savedShakaHome;
    await rm(commandRoot, { recursive: true, force: true });
  });

  test("consolidate reports damaged storage without a stack trace", async () => {
    const learningPath = join(commandRoot, "memory", "learnings.md");
    const source = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-07-18@aaaa0000 -->
<!-- promotion: invalid-json -->

### Damaged promotion

Body.`;
    await Bun.write(learningPath, source);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));

    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["consolidate"], { from: "user" });
    } finally {
      console.error = originalError;
    }

    const rendered = errors.join("\n");
    expect(rendered).toContain("Cannot rewrite");
    expect(rendered).toContain("shaka memory check");
    expect(rendered).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(process.exitCode).toBe(1);
    expect(await Bun.file(learningPath).text()).toBe(source);
  });

  test("review reports an unsafe storage path without a stack trace", async () => {
    const learningPath = join(commandRoot, "memory", "learnings.md");
    const targetPath = join(commandRoot, "linked-learnings.md");
    const source = renderLearnings([makeEntry({ title: "Linked learning" })]);
    await Bun.write(targetPath, source);
    await symlink(targetPath, learningPath);
    const errors: string[] = [];
    const originalError = console.error;
    const originalIsTTY = process.stdin.isTTY;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    process.stdin.isTTY = true;

    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["review"], { from: "user" });
    } finally {
      console.error = originalError;
      process.stdin.isTTY = originalIsTTY as boolean;
    }

    const rendered = errors.join("\n");
    expect(rendered).toContain("regular file");
    expect(rendered).toContain("shaka memory check");
    expect(rendered).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(process.exitCode).toBe(1);
    expect((await lstat(learningPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(targetPath).text()).toBe(source);
  });

  test("consolidate reports blocked migration readiness without a stack trace", async () => {
    const memoryDir = join(commandRoot, "memory");
    await writeLearnings(memoryDir, [makeEntry({ title: "Migration target" })]);
    await Bun.write(join(memoryDir, ".learning-scope-migration-v1.json"), "not-json");
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));

    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["consolidate"], { from: "user" });
    } finally {
      console.error = originalError;
    }

    const rendered = errors.join("\n");
    expect(rendered).toContain("Migration marker is malformed");
    expect(rendered).toContain("shaka memory check");
    expect(rendered).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(process.exitCode).toBe(1);
  });

  test("consolidate subprocess exits cleanly when storage is damaged", async () => {
    const learningPath = join(commandRoot, "memory", "learnings.md");
    const source = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-07-18@aaaa0000 -->
<!-- promotion: invalid-json -->

### Damaged promotion

Body.`;
    await Bun.write(learningPath, source);

    const result = makeRunShaka(commandRoot)(["memory", "consolidate"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot rewrite");
    expect(result.stderr).toContain("shaka memory check");
    expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(result.stderr).not.toContain("LearningsIntegrityError:");
    expect(await Bun.file(learningPath).text()).toBe(source);
  });

  test("consolidate subprocess reports a malformed condensation intent without a stack trace", async () => {
    const memoryDir = join(commandRoot, "memory");
    await Bun.write(join(memoryDir, CONDENSATION_COMMIT_FILE), "{not-json}\n");

    const result = makeRunShaka(commandRoot)(["memory", "consolidate"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Condensation intent is malformed");
    expect(result.stderr).toContain("shaka memory check");
    expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(result.stderr).not.toContain("CondensationCommitError:");
    expect(result.stderr).not.toContain("Bun v");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "consolidate subprocess reports an unreadable regular file without a stack trace",
    async () => {
      const learningPath = join(commandRoot, "memory", "learnings.md");
      const source = renderLearnings([makeEntry({ title: "Unreadable learning" })]);
      await Bun.write(learningPath, source);

      const result = await (async () => {
        await chmod(learningPath, 0o000);
        try {
          return makeRunShaka(commandRoot)(["memory", "consolidate"]);
        } finally {
          await chmod(learningPath, 0o600);
        }
      })();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Learning storage file could not be read.");
      expect(result.stderr).toContain("shaka memory check");
      expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
      expect(result.stderr).not.toContain("EACCES");
      expect(result.stderr).not.toContain("Bun v");
      expect(await Bun.file(learningPath).text()).toBe(source);
    },
  );

  test("consolidate rethrows unexpected failures", async () => {
    await writeLearnings(join(commandRoot, "memory"), [makeEntry()]);
    await mkdir(join(commandRoot, "memory", "learnings.backup.md"));
    const cmd = createMemoryCommand();

    await expect(cmd.parseAsync(["consolidate"], { from: "user" })).rejects.toThrow();

    expect(process.exitCode).toBe(0);
  });
});

describe("memory review scope", () => {
  let reviewRoot: string;
  let reviewMemoryDir: string;
  let savedIsTTY: boolean | undefined;

  beforeEach(async () => {
    reviewRoot = await mkdtemp(join(tmpdir(), "shaka-review-scope-"));
    reviewMemoryDir = join(reviewRoot, "memory");
    savedIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
  });

  afterEach(async () => {
    process.stdin.isTTY = savedIsTTY as boolean;
    await rm(reviewRoot, { recursive: true, force: true });
  });

  test("excludes a target and accepts the displayed common ancestor", async () => {
    const target = testCwd("/company-b/project-x");
    await writeLearnings(reviewMemoryDir, [
      makeEntry({
        title: "Company A convention",
        cwds: ["*"],
        promotionEvidence: {
          sourceCwds: [
            testCwd("/company-a/project-1"),
            testCwd("/company-a/project-2"),
            testCwd("/company-a/project-3"),
            target,
          ],
          excludedCwds: [],
          exposures: [],
          reasons: ["legacy-source-reconstruction"],
        },
      }),
    ]);
    const answers = ["1", "s", "e", "y", "a", "y", "q"];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const { runReview } = await import("../../../src/commands/memory/review");
      await runReview(
        reviewMemoryDir,
        { cwd: target, forbiddenAncestorRoots: testCwds("/Users/test") },
        async () => answers.shift() ?? "q",
      );
    } finally {
      console.log = originalLog;
    }

    const [result] = await loadLearnings(reviewMemoryDir);
    expect(result?.cwds).toEqual(testCwds("/company-a"));
    expect(result?.promotionEvidence?.excludedCwds).toEqual([target]);
    expect(result?.nonglobal).toBe(true);
    expect(output.join("\n")).toContain("Source CWDs:");
    expect(output.join("\n")).toContain("Excluded CWDs:");
    expect(output.join("\n")).toContain("Evidence reasons: legacy-source-reconstruction");
  });

  test("includes one exact stored exclusion without clearing nonglobal", async () => {
    const target = testCwd("/company-b/project-x");
    await writeLearnings(reviewMemoryDir, [
      makeEntry({
        title: "Corrected convention",
        cwds: testCwds("/company-a"),
        nonglobal: true,
        promotionEvidence: {
          sourceCwds: [testCwd("/company-a/project-1"), testCwd("/company-a/project-2"), target],
          excludedCwds: [target],
          exposures: [],
          reasons: ["manual-scope-correction"],
        },
      }),
    ]);
    const answers = ["1", "s", "i", "1", "y", "q"];
    const { runReview } = await import("../../../src/commands/memory/review");

    await runReview(reviewMemoryDir, { cwd: target }, async () => answers.shift() ?? "q");

    const [result] = await loadLearnings(reviewMemoryDir);
    expect(result?.cwds).toEqual([testCwd("/company-a"), target]);
    expect(result?.promotionEvidence?.excludedCwds).toEqual([]);
    expect(result?.nonglobal).toBe(true);
  });

  test("requires asserted roots before narrowing an evidence-free legacy global", async () => {
    const target = testCwd("/company-b/project-x");
    await writeLearnings(reviewMemoryDir, [makeEntry({ title: "Legacy global", cwds: ["*"] })]);
    const answers = [
      "1",
      "s",
      "e",
      "y",
      "r",
      "relative/project",
      `${testCwd("/company-a/project-1")}, ${testCwd("/company-a/project-2")}`,
      "a",
      "y",
      "q",
    ];
    const { runReview } = await import("../../../src/commands/memory/review");

    await runReview(reviewMemoryDir, { cwd: target }, async () => answers.shift() ?? "q");

    const [result] = await loadLearnings(reviewMemoryDir);
    expect(result?.cwds).toEqual(testCwds("/company-a"));
    expect(result?.promotionEvidence?.sourceCwds).toEqual(
      testCwds("/company-a/project-1", "/company-a/project-2"),
    );
    expect(result?.promotionEvidence?.excludedCwds).toEqual([target]);
  });

  test("reports stale review state and preserves the concurrent change", async () => {
    const target = testCwd("/target");
    const original = makeEntry({
      title: "Concurrent scope review",
      cwds: ["*"],
      promotionEvidence: {
        sourceCwds: [testCwd("/a"), testCwd("/b"), testCwd("/c"), target],
        excludedCwds: [],
        exposures: [],
        reasons: ["legacy-source-reconstruction"],
      },
    });
    await writeLearnings(reviewMemoryDir, [original]);
    const answers = ["1", "s", "e", "y"];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const { runReview } = await import("../../../src/commands/memory/review");
      await runReview(reviewMemoryDir, { cwd: target }, async (question) => {
        if (question.includes("Apply this scope")) {
          await writeLearnings(reviewMemoryDir, [
            { ...original, body: "Changed by another writer." },
          ]);
          return "y";
        }
        return answers.shift() ?? "q";
      });
    } finally {
      console.log = originalLog;
    }

    const [result] = await loadLearnings(reviewMemoryDir);
    expect(result?.cwds).toEqual(["*"]);
    expect(result?.body).toBe("Changed by another writer.");
    expect(output.join("\n")).toContain("changed while it was being reviewed");
  });
});

describe("memory stats", () => {
  let savedShakaHome: string | undefined;
  let statsTestDir: string;
  let statsMemoryDir: string;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    statsTestDir = await mkdtemp(join(tmpdir(), "shaka-test-stats-"));
    statsMemoryDir = join(statsTestDir, "memory");
    process.env.SHAKA_HOME = statsTestDir;
    await mkdir(statsMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    if (savedShakaHome === undefined) {
      process.env.SHAKA_HOME = undefined;
    } else {
      process.env.SHAKA_HOME = savedShakaHome;
    }
    await rm(statsTestDir, { recursive: true, force: true });
  });

  test("runs without error on empty memory", async () => {
    const cmd = createMemoryCommand();
    // Should not throw
    await cmd.parseAsync(["stats"], { from: "user" });
  });

  test("runs with learnings and sessions", async () => {
    await writeLearnings(statsMemoryDir, [
      makeEntry({ category: "correction", cwds: testCwds("/projects/a") }),
      makeEntry({ category: "pattern", cwds: ["*"], title: "Global Pattern" }),
      makeEntry({
        category: "correction",
        cwds: testCwds("/projects/a"),
        title: "Another Correction",
      }),
    ]);

    const summary: SessionSummary = {
      metadata: {
        date: "2026-02-15",
        cwd: testCwd("/projects/a"),
        provider: "claude",
        sessionId: "ses-stats001",
      },
      tags: ["test"],
      title: "Stats test session",
      body: "## Summary\nTest.",
    };
    await writeSummary(statsMemoryDir, summary);

    const cmd = createMemoryCommand();
    // Should not throw
    await cmd.parseAsync(["stats"], { from: "user" });
  });

  test("reports global, scoped, and scope-corrected learnings as exclusive groups", async () => {
    await writeLearnings(statsMemoryDir, [
      makeEntry({ category: "pattern", cwds: ["*"], title: "Global Pattern" }),
      makeEntry({ category: "fact", cwds: testCwds("/projects/a"), title: "Scoped Fact" }),
      makeEntry({
        category: "correction",
        cwds: testCwds("/projects/a"),
        title: "Corrected Scope",
        promotionEvidence: {
          sourceCwds: testCwds("/projects/a", "/projects/b"),
          excludedCwds: testCwds("/projects/b"),
          exposures: [],
          reasons: ["manual-scope-correction"],
        },
      }),
    ]);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["stats"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(output).toContain("  global: 1  |  project-scoped: 1  |  scope-corrected: 1");
  });
});

describe("memory search", () => {
  let savedShakaHome: string | undefined;
  let searchTestDir: string;
  let searchMemoryDir: string;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    searchTestDir = await mkdtemp(join(tmpdir(), "shaka-test-memory-search-"));
    searchMemoryDir = join(searchTestDir, "memory");
    process.env.SHAKA_HOME = searchTestDir;
    await mkdir(searchMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    if (savedShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = savedShakaHome;
    await rm(searchTestDir, { recursive: true, force: true });
  });

  test("--all includes matches from unrelated projects", async () => {
    const summaryPath = await writeSummary(searchMemoryDir, {
      metadata: {
        date: "2026-02-15",
        cwd: testCwd("/projects/unrelated"),
        provider: "claude",
        sessionId: "ses-search-all",
      },
      tags: [],
      title: "Cross-project needle",
      body: "## Summary\nFound through explicit all-project search.",
    });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["search", "needle", "--all"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Cross-project needle");
    expect(rendered).toContain(`path: ${summaryPath}`);
  });

  test("default search excludes matches from unrelated projects", async () => {
    await writeSummary(searchMemoryDir, {
      metadata: {
        date: "2026-02-15",
        cwd: testCwd("/projects/unrelated"),
        provider: "claude",
        sessionId: "ses-search-default",
      },
      tags: [],
      title: "Unrelated default needle",
      body: "## Summary\nThis must require --all.",
    });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["search", "needle"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toBe('No results for "needle"');
  });

  test("honors memory.search_max_results", async () => {
    await Bun.write(
      join(searchTestDir, "config.json"),
      JSON.stringify({
        version: "test",
        reasoning: {},
        permissions: {},
        providers: {},
        assistant: {},
        principal: {},
        memory: { search_max_results: 1 },
      }),
    );
    for (const [date, sessionId] of [
      ["2026-02-14", "ses-search-max-one"],
      ["2026-02-15", "ses-search-max-two"],
    ] as const) {
      await writeSummary(searchMemoryDir, {
        metadata: { date, cwd: process.cwd(), provider: "claude", sessionId },
        tags: [],
        title: `Configured limit ${sessionId}`,
        body: "## Summary\nConfigured limit token.",
      });
    }

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["search", "configured limit"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Found 1 result");
    expect(rendered).toContain("Configured limit ses-search-max-two");
    expect(rendered).not.toContain("Configured limit ses-search-max-one");
  });

  test("prints compiled knowledge with its own result type", async () => {
    const knowledgeDir = join(searchMemoryDir, "knowledge", "current-project");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd: process.cwd() }));
    await Bun.write(
      join(knowledgeDir, "memory-architecture.md"),
      `---
title: Memory Architecture
updated: 2026-07-14
summary: Project-scoped recall
---

Compiled knowledge needle.
`,
    );

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["search", "needle", "--type", "knowledge"], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toContain("[knowledge] Memory Architecture");
  });
});

describe("memory check", () => {
  let savedShakaHome: string | undefined;
  let savedExitCode: typeof process.exitCode;
  let checkRoot: string;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    checkRoot = await mkdtemp(join(tmpdir(), "shaka-memory-check-"));
    process.env.SHAKA_HOME = checkRoot;
  });

  afterEach(async () => {
    if (savedShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = savedShakaHome;
    process.exitCode = savedExitCode ?? 0;
    await rm(checkRoot, { recursive: true, force: true });
  });

  test("passes with healthy active and archived learnings", async () => {
    const cwd = testCwd("/projects/shaka");
    const checkMemoryDir = join(checkRoot, "memory");
    await writeLearnings(checkMemoryDir, [makeEntry({ title: "Active learning" })]);
    await appendToArchive(checkMemoryDir, [makeEntry({ title: "Archived learning" })]);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: PASS");
    expect(rendered).toContain("Knowledge integrity: PASS");
    expect(rendered).toContain("Learning integrity: PASS");
    expect(process.exitCode).toBe(0);
  });

  test("reports migration recovery warnings without failing storage health", async () => {
    const cwd = testCwd("/projects/shaka");
    const checkMemoryDir = join(checkRoot, "memory");
    await mkdir(checkMemoryDir, { recursive: true });
    await Bun.write(
      join(checkMemoryDir, "learnings.md"),
      renderLearnings([makeEntry({ title: "Healthy learning" })]),
    );
    await Bun.write(
      join(checkMemoryDir, ".learning-scope-migration-v1.json"),
      `${JSON.stringify({
        version: 1,
        intentSha256: "a".repeat(64),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: emptyMigrationCounts(),
      })}\n`,
    );

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: PASS");
    expect(rendered).toContain("Learning integrity: PASS");
    expect(rendered).toContain("[warning] learning-scope-migration-recovery");
    expect(process.exitCode).toBe(0);
  });

  test("reports integrity failures and sets a failing exit code", async () => {
    const cwd = testCwd("/projects/shaka");
    const knowledgeDir = join(checkRoot, "memory", "knowledge", projectSlug(cwd));
    const topicPath = join(knowledgeDir, "broken-topic.md");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd }));
    await Bun.write(
      join(knowledgeDir, ".manifest.json"),
      JSON.stringify({ compiledSources: {}, lastCompilation: "2026-07-15T12:00:00.000Z" }),
    );
    await Bun.write(topicPath, "# Missing frontmatter");
    await Bun.write(join(knowledgeDir, "_index.md"), "# Knowledge Index\n");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: FAIL");
    expect(rendered).toContain("Knowledge integrity: FAIL");
    expect(rendered).toContain("Learning integrity: PASS");
    expect(rendered).toContain("malformed-topic-page");
    expect(rendered).toContain(topicPath);
    expect(process.exitCode).toBe(1);
  });

  test("reports mixed-case active promotion metadata without changing it", async () => {
    const cwd = testCwd("/projects/shaka");
    const learningPath = join(checkRoot, "memory", "learnings.md");
    const source = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-07-18@aaaa0000 -->
<!-- Promotion: invalid-json -->

### Promotion provenance

Keep the source evidence.

---`;
    await mkdir(join(checkRoot, "memory"), { recursive: true });
    await Bun.write(learningPath, source);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: FAIL");
    expect(rendered).toContain("Knowledge integrity: PASS");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("malformed-promotion-metadata");
    expect(rendered).toContain("Promotion provenance");
    expect(rendered).toContain(learningPath);
    expect(await Bun.file(learningPath).text()).toBe(source);
    expect(process.exitCode).toBe(1);
  });

  test("reports malformed learning records with their title and file path", async () => {
    const cwd = testCwd("/projects/shaka");
    const learningPath = join(checkRoot, "memory", "learnings.md");
    const source = `# Learnings

---

<!-- correction | cwd: ${testCwd("/projects/a")} | broken -->

### Lost learning

Body.

---`;
    await mkdir(join(checkRoot, "memory"), { recursive: true });
    await Bun.write(learningPath, source);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: FAIL");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("malformed-learning-record");
    expect(rendered).toContain("Lost learning");
    expect(rendered).toContain(learningPath);
    expect(await Bun.file(learningPath).text()).toBe(source);
    expect(process.exitCode).toBe(1);
  });

  test("reports duplicated archived promotion metadata", async () => {
    const cwd = testCwd("/projects/shaka");
    const archivePath = join(checkRoot, "memory", "learnings-archive.md");
    const promotion = `<!-- promotion: ${JSON.stringify({
      sourceCwds: testCwds("/a", "/b", "/c"),
      exposures: [{ date: "2026-07-18", sessionHash: "aaaa0000" }],
      reasons: ["automatic-cross-project-threshold"],
    })} -->`;
    const source = `# Archived Learnings

---

<!-- correction | cwd: * | exposures: 2026-07-18@aaaa0000 -->
${promotion}
${promotion}

### Archived provenance

Keep the archived source evidence.

---`;
    await mkdir(join(checkRoot, "memory"), { recursive: true });
    await Bun.write(archivePath, source);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("duplicate-promotion-metadata");
    expect(rendered).toContain("Archived provenance");
    expect(rendered).toContain(archivePath);
    expect(process.exitCode).toBe(1);
  });

  test("reports an unreadable learnings file instead of crashing", async () => {
    const cwd = testCwd("/projects/shaka");
    const learningPath = join(checkRoot, "memory", "learnings.md");
    await mkdir(learningPath, { recursive: true });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: FAIL");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("unreadable-learning-file");
    expect(rendered).toContain(learningPath);
    expect(process.exitCode).toBe(1);
  });

  test("reports a symlinked active learnings file without replacing it", async () => {
    const cwd = testCwd("/projects/shaka");
    const checkMemoryDir = join(checkRoot, "memory");
    const learningPath = join(checkMemoryDir, "learnings.md");
    const targetPath = join(checkRoot, "linked-learnings.md");
    const source = `# Learnings

---

<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->

### Linked learning

Body.

---`;
    await mkdir(checkMemoryDir, { recursive: true });
    await Bun.write(targetPath, source);
    await symlink(targetPath, learningPath);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Memory integrity: FAIL");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("unreadable-learning-file");
    expect(rendered).toContain(learningPath);
    expect((await lstat(learningPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(targetPath).text()).toBe(source);
    expect(process.exitCode).toBe(1);
  });

  test("reports a dangling active learnings symlink as invalid storage", async () => {
    const cwd = testCwd("/projects/shaka");
    const checkMemoryDir = join(checkRoot, "memory");
    const learningPath = join(checkMemoryDir, "learnings.md");
    const missingTarget = join(checkRoot, "missing-learnings.md");
    await mkdir(checkMemoryDir, { recursive: true });
    await symlink(missingTarget, learningPath);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["check", "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain("Learning integrity: FAIL");
    expect(rendered).toContain("unreadable-learning-file");
    expect(rendered).toContain(learningPath);
    expect((await lstat(learningPath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(missingTarget).exists()).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe("memory impact", () => {
  let savedShakaHome: string | undefined;
  let impactRoot: string;

  beforeEach(async () => {
    savedShakaHome = process.env.SHAKA_HOME;
    impactRoot = await mkdtemp(join(tmpdir(), "shaka-memory-impact-"));
    process.env.SHAKA_HOME = impactRoot;
  });

  afterEach(async () => {
    if (savedShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = savedShakaHome;
    await rm(impactRoot, { recursive: true, force: true });
  });

  test("reports source references without changing knowledge files", async () => {
    const cwd = testCwd("/projects/shaka");
    const sourceId = "2026-07-15-impact001";
    const memoryDir = join(impactRoot, "memory");
    const sourcePath = join(memoryDir, "sessions", `${sourceId}.md`);
    const knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));
    const topicPath = join(knowledgeDir, "retrieval.md");
    const sourceContent = "source session";
    await mkdir(join(memoryDir, "sessions"), { recursive: true });
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(sourcePath, sourceContent);
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd }));
    await Bun.write(
      join(knowledgeDir, ".manifest.json"),
      JSON.stringify({
        compiledSources: { [`${sourceId}.md`]: hashContent(sourceContent) },
        lastCompilation: "2026-07-15T12:00:00.000Z",
      }),
    );
    await Bun.write(
      topicPath,
      `---
title: Retrieval
created: 2026-07-15
updated: 2026-07-15
confidence: medium
sources:
  - ${sourceId}
summary: Deterministic retrieval
---

## Overview

Search is deterministic.

## Key Decisions

- Keep substring matching (source: ${sourceId})
`,
    );
    await rebuildIndex(knowledgeDir);
    const before = await Bun.file(topicPath).text();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      const cmd = createMemoryCommand();
      await cmd.parseAsync(["impact", sourcePath, "--cwd", cwd], { from: "user" });
    } finally {
      console.log = originalLog;
    }

    const rendered = output.join("\n");
    expect(rendered).toContain(`Source impact: ${sourceId}`);
    expect(rendered).toContain(`topic: Retrieval (${topicPath})`);
    expect(rendered).toContain("decision: Keep substring matching");
    expect(rendered).toContain("inspection complete: yes");
    expect(await Bun.file(topicPath).text()).toBe(before);
  });
});
