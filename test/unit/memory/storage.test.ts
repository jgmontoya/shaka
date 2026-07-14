import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SummaryIndex,
  listSummaries,
  loadSummary,
  selectRecentSummaries,
  writeSummary,
} from "../../../src/memory/storage";
import type { SessionSummary } from "../../../src/memory/summarize";

const testMemoryDir = join(tmpdir(), "shaka-test-memory");

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
      sessionId: overrides.sessionId ?? "ses-abc12345",
    },
    tags: overrides.tags ?? ["test", "storage"],
    title: overrides.title ?? "Test session summary",
    body: overrides.body ?? "## Summary\nDid some work.\n\n## Decisions\n- Chose option A.",
  };
}

describe("Storage", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  describe("writeSummary", () => {
    test("creates sessions/ subdirectory if it does not exist", async () => {
      const summary = makeSummary();
      await writeSummary(testMemoryDir, summary);

      const sessionsDir = Bun.file(`${testMemoryDir}/sessions`);
      // Check that a file was written inside sessions/
      const glob = new Bun.Glob("*.md");
      const files = await Array.fromAsync(glob.scan(`${testMemoryDir}/sessions`));
      expect(files.length).toBe(1);
    });

    test("returns the written file path", async () => {
      const summary = makeSummary();
      const filePath = await writeSummary(testMemoryDir, summary);

      expect(filePath).toContain(join(testMemoryDir, "sessions"));
      expect(filePath).toEndWith(".md");
      expect(await Bun.file(filePath).exists()).toBe(true);
    });

    test("filename is date-hash format", async () => {
      const { basename } = await import("node:path");
      const summary = makeSummary({ sessionId: "ses-deadbeef99" });
      const filePath = await writeSummary(testMemoryDir, summary);
      const filename = basename(filePath);

      // Format: YYYY-MM-DD-{hash8}.md
      expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.md$/);
      expect(filename).toContain("2026-02-09");
    });

    test("same session ID produces same filename (overwrites)", async () => {
      const summary1 = makeSummary({ sessionId: "same-id", title: "First attempt" });
      const summary2 = makeSummary({ sessionId: "same-id", title: "Updated summary" });
      const path1 = await writeSummary(testMemoryDir, summary1);
      const path2 = await writeSummary(testMemoryDir, summary2);

      // Same filename — second write overwrites first
      expect(path1).toBe(path2);

      // Content is the updated version
      const loaded = await loadSummary(path2);
      expect(loaded?.title).toBe("Updated summary");

      // Only one file exists
      const glob = new Bun.Glob("*.md");
      const files = await Array.fromAsync(glob.scan(`${testMemoryDir}/sessions`));
      expect(files.length).toBe(1);
    });

    test("different session IDs produce different hashes", async () => {
      const summary1 = makeSummary({ sessionId: "ses_abc123", title: "One" });
      const summary2 = makeSummary({
        sessionId: "cb92e783-4494-4c53-af79-6f577750af17",
        title: "Two",
      });
      const path1 = await writeSummary(testMemoryDir, summary1);
      const path2 = await writeSummary(testMemoryDir, summary2);

      const hash1 = path1.match(/([a-f0-9]{8})\.md$/)?.[1];
      const hash2 = path2.match(/([a-f0-9]{8})\.md$/)?.[1];
      expect(hash1).not.toBe(hash2);
    });

    test("written file contains valid frontmatter", async () => {
      const summary = makeSummary({ tags: ["auth", "bug-fix"] });
      const filePath = await writeSummary(testMemoryDir, summary);
      const content = await Bun.file(filePath).text();

      expect(content).toContain("---");
      expect(content).toContain("date:");
      expect(content).toContain("cwd: /projects/myapp");
      expect(content).toContain("provider: claude");
      expect(content).toContain("session_id: ses-abc12345");
    });

    test("written file contains title and body", async () => {
      const summary = makeSummary();
      const filePath = await writeSummary(testMemoryDir, summary);
      const content = await Bun.file(filePath).text();

      expect(content).toContain("# Test session summary");
      expect(content).toContain("## Summary");
      expect(content).toContain("Did some work.");
    });

    test("written file is parseable by loadSummary", async () => {
      const summary = makeSummary();
      const filePath = await writeSummary(testMemoryDir, summary);
      const loaded = await loadSummary(filePath);

      expect(loaded).not.toBeNull();
      expect(loaded?.metadata.date).toBe(summary.metadata.date);
      expect(loaded?.metadata.cwd).toBe(summary.metadata.cwd);
      expect(loaded?.metadata.provider).toBe(summary.metadata.provider);
      expect(loaded?.metadata.sessionId).toBe(summary.metadata.sessionId);
      expect(loaded?.tags).toEqual(summary.tags);
      expect(loaded?.title).toBe(summary.title);
    });
  });

  describe("listSummaries", () => {
    test("returns summaries sorted by date (most recent first)", async () => {
      await writeSummary(
        testMemoryDir,
        makeSummary({ date: "2026-02-07", sessionId: "ses-aaa00001" }),
      );
      await writeSummary(
        testMemoryDir,
        makeSummary({ date: "2026-02-09", sessionId: "ses-bbb00002" }),
      );
      await writeSummary(
        testMemoryDir,
        makeSummary({ date: "2026-02-08", sessionId: "ses-ccc00003" }),
      );

      const summaries = await listSummaries(testMemoryDir);

      expect(summaries).toHaveLength(3);
      expect(summaries[0]?.date).toBe("2026-02-09");
      expect(summaries[1]?.date).toBe("2026-02-08");
      expect(summaries[2]?.date).toBe("2026-02-07");
    });

    test("returns index data from frontmatter", async () => {
      await writeSummary(
        testMemoryDir,
        makeSummary({
          tags: ["auth", "fix"],
          title: "Fix login bug",
          sessionId: "ses-idx00001",
        }),
      );

      const summaries = await listSummaries(testMemoryDir);

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.title).toBe("Fix login bug");
      expect(summaries[0]?.tags).toEqual(["auth", "fix"]);
      expect(summaries[0]?.cwd).toBe("/projects/myapp");
      expect(summaries[0]?.provider).toBe("claude");
    });

    test("returns empty array if sessions/ directory does not exist", async () => {
      await rm(testMemoryDir, { recursive: true, force: true });
      const summaries = await listSummaries(testMemoryDir);
      expect(summaries).toEqual([]);
    });

    test("returns empty array if sessions/ directory is empty", async () => {
      await mkdir(`${testMemoryDir}/sessions`, { recursive: true });
      const summaries = await listSummaries(testMemoryDir);
      expect(summaries).toEqual([]);
    });

    test("skips non-markdown files", async () => {
      await writeSummary(testMemoryDir, makeSummary({ sessionId: "ses-md000001" }));
      await Bun.write(`${testMemoryDir}/sessions/notes.txt`, "not a summary");

      const summaries = await listSummaries(testMemoryDir);
      expect(summaries).toHaveLength(1);
    });

    test("skips files with unparseable frontmatter", async () => {
      await writeSummary(testMemoryDir, makeSummary({ sessionId: "ses-good0001" }));
      await Bun.write(`${testMemoryDir}/sessions/bad.md`, "no frontmatter here");

      const summaries = await listSummaries(testMemoryDir);
      expect(summaries).toHaveLength(1);
    });
  });

  describe("loadSummary", () => {
    test("reads and parses a summary file", async () => {
      const original = makeSummary();
      const filePath = await writeSummary(testMemoryDir, original);

      const loaded = await loadSummary(filePath);

      expect(loaded).not.toBeNull();
      expect(loaded?.title).toBe(original.title);
      expect(loaded?.body).toContain("## Summary");
    });

    test("returns null if file does not exist", async () => {
      const loaded = await loadSummary("/nonexistent/path/file.md");
      expect(loaded).toBeNull();
    });
  });

  describe("selectRecentSummaries", () => {
    const summaries: SummaryIndex[] = [
      {
        filePath: "/a.md",
        title: "A",
        date: "2026-02-09",
        cwd: "/projects/myapp",
        tags: [],
        provider: "claude",
        sessionId: "a",
      },
      {
        filePath: "/b.md",
        title: "B",
        date: "2026-02-08",
        cwd: "/projects/myapp",
        tags: [],
        provider: "claude",
        sessionId: "b",
      },
      {
        filePath: "/c.md",
        title: "C",
        date: "2026-02-07",
        cwd: "/projects/other",
        tags: [],
        provider: "opencode",
        sessionId: "c",
      },
      {
        filePath: "/d.md",
        title: "D",
        date: "2026-02-06",
        cwd: "/projects/other",
        tags: [],
        provider: "claude",
        sessionId: "d",
      },
      {
        filePath: "/e.md",
        title: "E",
        date: "2026-02-05",
        cwd: "/projects/myapp",
        tags: [],
        provider: "claude",
        sessionId: "e",
      },
    ];

    test("prefers summaries whose cwd matches current directory", () => {
      const result = selectRecentSummaries(summaries, "/projects/myapp", 3);
      expect(result).toHaveLength(3);
      expect(result.every((s) => s.cwd === "/projects/myapp")).toBe(true);
    });

    test("does not fill remaining slots from unrelated cwds", () => {
      const result = selectRecentSummaries(summaries, "/projects/myapp", 5);
      expect(result).toHaveLength(3);
      expect(result.every((summary) => summary.cwd === "/projects/myapp")).toBe(true);
    });

    test("returns no summaries if the current project has no matches", () => {
      const result = selectRecentSummaries(summaries, "/projects/unknown", 3);
      expect(result).toEqual([]);
    });

    test("treats nested working directories as the same project scope", () => {
      const root = summaries[0];
      expect(root).toBeDefined();
      if (!root) throw new Error("expected root summary fixture");
      const nested = {
        ...root,
        filePath: "/nested.md",
        cwd: "/projects/myapp/packages/api",
        sessionId: "nested",
      };

      expect(selectRecentSummaries([nested], "/projects/myapp")).toEqual([nested]);
      expect(selectRecentSummaries([root], "/projects/myapp/packages/api")).toEqual([root]);
    });

    test("respects limit (default 3)", () => {
      const result = selectRecentSummaries(summaries, "/projects/myapp");
      expect(result).toHaveLength(3);
    });

    test("returns empty array if no summaries", () => {
      expect(selectRecentSummaries([], "/projects/myapp")).toEqual([]);
    });

    test("returns all if fewer than limit", () => {
      const few = summaries.slice(0, 2);
      const result = selectRecentSummaries(few, "/projects/myapp", 5);
      expect(result).toHaveLength(2);
    });
  });
});
