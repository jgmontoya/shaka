import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock inference so dedup/contradiction passes are no-ops
mock.module("../../../src/inference", () => ({
  inference: async () => ({ success: true, text: "NO DUPLICATES" }),
  hasInferenceProvider: async () => false,
}));

import { createMemoryCommand } from "../../../src/commands/memory/index";
import { type LearningEntry, loadLearnings, writeLearnings } from "../../../src/memory/learnings";
import { writeSummary } from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? ["/projects/myapp"],
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Default Title",
    body: overrides.body ?? "Default body.",
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
      delete process.env.SHAKA_HOME;
    } else {
      process.env.SHAKA_HOME = savedShakaHome;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  test("duplicate titles: each entry promoted independently", async () => {
    // Need 20+ entries to exceed consolidation threshold
    const entries: LearningEntry[] = [];
    for (let i = 0; i < 18; i++) {
      entries.push(makeEntry({ title: `Filler entry ${i}` }));
    }
    // Two entries with same title, 3+ CWDs each (promotion-eligible)
    entries.push(makeEntry({ title: "Same Title", cwds: ["/a", "/b", "/c"] }));
    entries.push(makeEntry({ title: "Same Title", cwds: ["/d", "/e", "/f"] }));

    await writeLearnings(memoryDir, entries);

    const cmd = createMemoryCommand();
    await cmd.parseAsync(["consolidate"], { from: "user" });

    const result = await loadLearnings(memoryDir);
    const promoted = result.filter((e) => e.title === "Same Title");

    expect(promoted).toHaveLength(2);
    expect(promoted[0]?.cwds).toEqual(["*"]);
    expect(promoted[1]?.cwds).toEqual(["*"]);
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
      delete process.env.SHAKA_HOME;
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
      makeEntry({ category: "correction", cwds: ["/projects/a"] }),
      makeEntry({ category: "pattern", cwds: ["*"], title: "Global Pattern" }),
      makeEntry({ category: "correction", cwds: ["/projects/a"], title: "Another Correction" }),
    ]);

    const summary: SessionSummary = {
      metadata: {
        date: "2026-02-15",
        cwd: "/projects/a",
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
});
