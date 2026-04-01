import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLearnings } from "../../../src/memory/learnings";
import { type SearchFilter, type SearchResult, searchMemory } from "../../../src/memory/search";
import { writeSummary } from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";

const testMemoryDir = join(tmpdir(), "shaka-test-search");

function makeSummary(
  overrides: Partial<{
    date: string;
    cwd: string;
    provider: "claude" | "opencode";
    sessionId: string;
    tags: string[];
    title: string;
    body: string;
  }> = {},
): SessionSummary {
  return {
    metadata: {
      date: overrides.date ?? "2026-02-09",
      cwd: overrides.cwd ?? "/projects/myapp",
      provider: overrides.provider ?? "claude",
      sessionId: overrides.sessionId ?? "ses-search001",
    },
    tags: overrides.tags ?? ["test"],
    title: overrides.title ?? "Test session",
    body: overrides.body ?? "## Summary\nDid some work.",
  };
}

describe("searchMemory", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("returns matches for query found in file content", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Fix authentication bug",
        body: "## Summary\nFixed token expiry validation in the auth module.",
        sessionId: "ses-auth0001",
      }),
    );
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Refactor database layer",
        body: "## Summary\nMigrated from SQLite to Postgres.",
        sessionId: "ses-db000001",
      }),
    );

    const results = await searchMemory("auth", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Fix authentication bug");
  });

  test("search is case-insensitive", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Fix Authentication Bug",
        body: "## Summary\nFixed TOKEN expiry.",
        sessionId: "ses-case0001",
      }),
    );

    const results = await searchMemory("token", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Fix Authentication Bug");
  });

  test("matches in title", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Implement WebSocket support",
        body: "## Summary\nAdded real-time communication.",
        sessionId: "ses-ws000001",
      }),
    );

    const results = await searchMemory("websocket", testMemoryDir);

    expect(results).toHaveLength(1);
  });

  test("matches in tags", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Generic session",
        tags: ["authentication", "security"],
        body: "## Summary\nDid some work.",
        sessionId: "ses-tags0001",
      }),
    );

    const results = await searchMemory("security", testMemoryDir);

    expect(results).toHaveLength(1);
  });

  test("returns results sorted by date (most recent first)", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        date: "2026-02-07",
        title: "Old session about testing",
        body: "## Summary\nWrote tests.",
        sessionId: "ses-old00001",
      }),
    );
    await writeSummary(
      testMemoryDir,
      makeSummary({
        date: "2026-02-09",
        title: "New session about testing",
        body: "## Summary\nMore tests.",
        sessionId: "ses-new00001",
      }),
    );

    const results = await searchMemory("testing", testMemoryDir);

    expect(results).toHaveLength(2);
    expect(results[0]?.date).toBe("2026-02-09");
    expect(results[1]?.date).toBe("2026-02-07");
  });

  test("includes snippet around the match", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Long session",
        body: "## Summary\nThis is a lot of context before the important keyword. The migration to Postgres was successful and all integration tests pass now.",
        sessionId: "ses-snip0001",
      }),
    );

    const results = await searchMemory("postgres", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toContain("Postgres");
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(250);
  });

  test("returns top 10 results maximum", async () => {
    // Create 12 matching summaries
    for (let i = 0; i < 12; i++) {
      await writeSummary(
        testMemoryDir,
        makeSummary({
          title: `Session ${i} about refactoring`,
          sessionId: `ses-many${String(i).padStart(4, "0")}`,
        }),
      );
    }

    const results = await searchMemory("refactoring", testMemoryDir);

    expect(results).toHaveLength(10);
  });

  test("returns empty array if no matches", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Unrelated session",
        body: "## Summary\nDid something else.",
        sessionId: "ses-none0001",
      }),
    );

    const results = await searchMemory("nonexistent-term", testMemoryDir);

    expect(results).toEqual([]);
  });

  test("returns empty array if directory does not exist", async () => {
    await rm(testMemoryDir, { recursive: true, force: true });

    const results = await searchMemory("anything", testMemoryDir);

    expect(results).toEqual([]);
  });

  test("returns empty array if sessions/ directory is empty", async () => {
    await mkdir(`${testMemoryDir}/sessions`, { recursive: true });

    const results = await searchMemory("anything", testMemoryDir);

    expect(results).toEqual([]);
  });

  test("result includes title, date, tags, filePath", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Important session",
        date: "2026-02-09",
        tags: ["important", "test"],
        sessionId: "ses-meta0001",
      }),
    );

    const results = await searchMemory("important", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Important session");
    expect(results[0]?.date).toBe("2026-02-09");
    expect(results[0]?.tags).toEqual(["important", "test"]);
    expect(results[0]?.filePath).toContain(".md");
  });

  test("session results have type 'session'", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({ title: "Typed session", sessionId: "ses-type0001" }),
    );

    const results = await searchMemory("typed", testMemoryDir);
    expect(results[0]?.type).toBe("session");
  });

  test("finds matches in learnings", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "correction",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Use Bun.file() instead of fs.readFile()",
        body: "This project uses Bun runtime.",
      },
    ]);

    const results = await searchMemory("Bun.file", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("learning");
    expect(results[0]?.title).toBe("Use Bun.file() instead of fs.readFile()");
  });

  test("learning results use last exposure date", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "preference",
        cwds: ["*"],
        exposures: [
          { date: "2026-02-09", sessionHash: "aaaa0000" },
          { date: "2026-02-12", sessionHash: "bbbb0000" },
        ],
        nonglobal: false,
        title: "No emojis in comments",
        body: "User prefers no emojis.",
      },
    ]);

    const results = await searchMemory("emojis", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.date).toBe("2026-02-12");
  });

  test("returns results from both sessions and learnings", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Session about testing patterns",
        body: "## Summary\nWrote tests.",
        sessionId: "ses-both0001",
      }),
    );
    await writeLearnings(testMemoryDir, [
      {
        category: "pattern",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Always write testing patterns first",
        body: "TDD approach.",
      },
    ]);

    const results = await searchMemory("testing patterns", testMemoryDir);

    expect(results).toHaveLength(2);
    const types = results.map((r) => r.type);
    expect(types).toContain("session");
    expect(types).toContain("learning");
  });

  test("learnings search is case-insensitive", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "correction",
        cwds: ["/x"],
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Use UPPERCASE Convention",
        body: "Constants should be SCREAMING_SNAKE.",
      },
    ]);

    const results = await searchMemory("uppercase", testMemoryDir);
    expect(results).toHaveLength(1);
  });

  test("returns empty when learnings file is missing", async () => {
    // No learnings file, no sessions directory
    await rm(testMemoryDir, { recursive: true, force: true });
    const results = await searchMemory("anything", testMemoryDir);
    expect(results).toEqual([]);
  });

  // --- Filter tests ---

  test("filter by type: learning only", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Session about testing patterns",
        body: "## Summary\nTesting patterns used.",
        sessionId: "ses-filt0001",
      }),
    );
    await writeLearnings(testMemoryDir, [
      {
        category: "pattern",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Testing patterns for Bun",
        body: "Use bun:test for testing patterns.",
      },
    ]);

    const results = await searchMemory("testing patterns", testMemoryDir, { type: "learning" });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("learning");
  });

  test("filter by type: session only", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Session about testing patterns",
        body: "## Summary\nTesting patterns used.",
        sessionId: "ses-filt0002",
      }),
    );
    await writeLearnings(testMemoryDir, [
      {
        category: "pattern",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Testing patterns for Bun",
        body: "Use bun:test for testing patterns.",
      },
    ]);

    const results = await searchMemory("testing patterns", testMemoryDir, { type: "session" });
    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("session");
  });

  test("filter by category: only matching learnings returned", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "correction",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Always use Bun runtime",
        body: "Correction about runtime.",
      },
      {
        category: "preference",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
        nonglobal: false,
        title: "Prefer Bun APIs",
        body: "Preference for Bun.",
      },
    ]);

    const results = await searchMemory("Bun", testMemoryDir, { category: "correction" });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Always use Bun runtime");
    expect(results[0]?.category).toBe("correction");
  });

  test("filter by cwd: filters sessions by cwd", async () => {
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Session in myapp",
        body: "## Summary\nWork on refactoring.",
        cwd: "/projects/myapp",
        sessionId: "ses-cwd00001",
      }),
    );
    await writeSummary(
      testMemoryDir,
      makeSummary({
        title: "Session in other",
        body: "## Summary\nRefactoring elsewhere.",
        cwd: "/projects/other",
        sessionId: "ses-cwd00002",
      }),
    );

    const results = await searchMemory("refactoring", testMemoryDir, { cwd: "myapp" });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Session in myapp");
  });

  test("filter by cwd: filters learnings by cwd", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "pattern",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "App-specific pattern",
        body: "Important insight for app.",
      },
      {
        category: "pattern",
        cwds: ["/projects/other"],
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
        nonglobal: false,
        title: "Other-specific pattern",
        body: "Important insight for other.",
      },
    ]);

    const results = await searchMemory("insight", testMemoryDir, { cwd: "myapp" });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("App-specific pattern");
  });

  test("custom maxResults limits output", async () => {
    for (let i = 0; i < 5; i++) {
      await writeSummary(
        testMemoryDir,
        makeSummary({
          title: `Session ${i} about deployment`,
          sessionId: `ses-max${String(i).padStart(5, "0")}`,
        }),
      );
    }

    const results = await searchMemory("deployment", testMemoryDir, undefined, 3);
    expect(results).toHaveLength(3);
  });

  test("learning results include category field", async () => {
    await writeLearnings(testMemoryDir, [
      {
        category: "fact",
        cwds: ["*"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Project supports Windows",
        body: "Cross-platform fact.",
      },
    ]);

    const results = await searchMemory("Windows", testMemoryDir);
    expect(results).toHaveLength(1);
    expect(results[0]?.category).toBe("fact");
  });

  // --- Archive search tests ---

  test("finds entries in learnings-archive.md", async () => {
    const { renderLearnings } = await import("../../../src/memory/learnings");

    const archiveEntries = [
      {
        category: "pattern" as const,
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-05", sessionHash: "arch0000" }],
        nonglobal: false,
        title: "Archived testing pattern",
        body: "Use factories for test data.",
      },
    ];

    await Bun.write(join(testMemoryDir, "learnings-archive.md"), renderLearnings(archiveEntries));

    const results = await searchMemory("factories", testMemoryDir);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Archived testing pattern");
    expect(results[0]?.snippet).toContain("[archived]");
  });

  test("returns both active and archived results for same query", async () => {
    const { renderLearnings } = await import("../../../src/memory/learnings");

    // Active learning
    await writeLearnings(testMemoryDir, [
      {
        category: "correction",
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
        nonglobal: false,
        title: "Active Bun Pattern",
        body: "Use Bun.file() for file I/O.",
      },
    ]);

    // Archived learning
    const archiveEntries = [
      {
        category: "pattern" as const,
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-02-05", sessionHash: "arch0000" }],
        nonglobal: false,
        title: "Archived Bun Pattern",
        body: "Use bun:test for testing.",
      },
    ];

    await Bun.write(join(testMemoryDir, "learnings-archive.md"), renderLearnings(archiveEntries));

    const results = await searchMemory("Bun", testMemoryDir);

    expect(results).toHaveLength(2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("Active Bun Pattern");
    expect(titles).toContain("Archived Bun Pattern");
  });
});
