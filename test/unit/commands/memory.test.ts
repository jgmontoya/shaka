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
import { rebuildIndex } from "../../../src/memory/knowledge";
import { type LearningEntry, loadLearnings, writeLearnings } from "../../../src/memory/learnings";
import { projectSlug } from "../../../src/memory/rollups";
import { writeSummary } from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";
import { hashContent } from "../../../src/memory/utils";

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
      process.env.SHAKA_HOME = undefined;
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
        cwd: "/projects/unrelated",
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
        cwd: "/projects/unrelated",
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

  test("reports integrity failures and sets a failing exit code", async () => {
    const cwd = "/projects/shaka";
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
    expect(rendered).toContain("Knowledge integrity: FAIL");
    expect(rendered).toContain("malformed-topic-page");
    expect(rendered).toContain(topicPath);
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
    const cwd = "/projects/shaka";
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
