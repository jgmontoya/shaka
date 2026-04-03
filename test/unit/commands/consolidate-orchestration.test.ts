/**
 * Orchestration tests for condensation (Pass 3) in consolidate.ts.
 *
 * Tests the integration layer: appendToArchive, condenseEntries, and
 * the modified runConsolidation flow. Inference is mocked at the module
 * boundary — everything else uses real filesystem.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearningEntry } from "../../../src/memory/learnings";
import { parseLearnings, renderLearnings, writeLearnings } from "../../../src/memory/learnings";

const testMemoryDir = join(tmpdir(), "shaka-test-consolidate-orch");

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? ["/projects/myapp"],
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Use Bun.file() instead of fs.readFile()",
    body: overrides.body ?? "This project uses Bun runtime.",
  };
}

// --- appendToArchive ---

describe("appendToArchive", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("creates archive file when it does not exist", async () => {
    const { appendToArchive } = await import("../../../src/memory/learnings");

    const entries = [
      makeEntry({ title: "Archived A", body: "Body A." }),
      makeEntry({ title: "Archived B", body: "Body B." }),
    ];

    await appendToArchive(testMemoryDir, entries);

    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(true);

    const content = await archiveFile.text();
    expect(content).toContain("Archived A");
    expect(content).toContain("Archived B");
  });

  test("appends to existing archive file without losing previous entries", async () => {
    const { appendToArchive } = await import("../../../src/memory/learnings");

    // First write
    const first = [makeEntry({ title: "First Entry", body: "First body." })];
    await appendToArchive(testMemoryDir, first);

    // Second write
    const second = [makeEntry({ title: "Second Entry", body: "Second body." })];
    await appendToArchive(testMemoryDir, second);

    const content = await Bun.file(join(testMemoryDir, "learnings-archive.md")).text();
    const parsed = parseLearnings(content);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.title).toBe("First Entry");
    expect(parsed[1]!.title).toBe("Second Entry");
  });

  test("no-ops when given empty array", async () => {
    const { appendToArchive } = await import("../../../src/memory/learnings");

    await appendToArchive(testMemoryDir, []);

    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(false);
  });
});

// --- condenseEntries ---

describe("condenseEntries", () => {
  test("returns entries unchanged when no candidates exist", async () => {
    // All entries have only 1 exposure — below CONDENSATION_EXPOSURE_MIN (2)
    // So findCondensationCandidates returns empty, and inference is never called.
    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({ title: "A", cwds: ["/proj"] }),
      makeEntry({ title: "B", cwds: ["/proj"] }),
    ];

    const result = await condenseEntries(entries);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.title).toBe("A");
    expect(result.entries[1]!.title).toBe("B");
    expect(result.archived).toHaveLength(0);
    expect(result.compoundsCreated).toBe(0);
  });
});

// --- condenseEntries with inference mock ---

// These tests mock the inference boundary to control LLM output.
// mock.module must be called before importing the module under test.

describe("condenseEntries (with inference)", () => {
  afterEach(() => {
    mock.restore();
  });

  function twoExposures() {
    return [
      { date: "2026-03-01", sessionHash: "aaaa0000" },
      { date: "2026-03-05", sessionHash: "bbbb0000" },
    ];
  }

  test("processes candidates and produces compound entries", async () => {
    const inferenceResponse = `CLUSTER [1, 2] — Bun runtime
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() for file I/O and bun:test for testing. Avoids Node.js-specific APIs.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: inferenceResponse }),
      hasInferenceProvider: async () => false,
    }));

    // Re-import to pick up mock
    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "Use Bun.file()",
        cwds: ["/myapp"],
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: ["/myapp"],
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    expect(result.compoundsCreated).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Bun Runtime Conventions");
    expect(result.archived).toHaveLength(2);
  });

  test("skips candidates where inference fails (fail-open)", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: false, error: "timeout" }),
      hasInferenceProvider: async () => false,
    }));

    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "A",
        cwds: ["/myapp"],
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B",
        cwds: ["/myapp"],
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    // Entries returned unchanged — inference failure means no condensation
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.title).toBe("A");
    expect(result.entries[1]!.title).toBe("B");
    expect(result.archived).toHaveLength(0);
    expect(result.compoundsCreated).toBe(0);
  });

  test("processes successful candidates and skips failed ones", async () => {
    let callCount = 0;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            text: `CLUSTER [1, 2] — Topic A
TITLE: Compound A
BODY: Merged body A.`,
          };
        }
        // Second call fails
        return { success: false, error: "timeout" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "A1",
        cwds: ["/proj-a"],
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "A2",
        cwds: ["/proj-a"],
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B1",
        cwds: ["/proj-b"],
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B2",
        cwds: ["/proj-b"],
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    // First candidate (/proj-a) succeeded, second (/proj-b) failed
    expect(result.compoundsCreated).toBe(1);
    expect(result.entries.find((e) => e.title === "Compound A")).toBeDefined();
    // A1 and A2 consumed by condensation
    expect(result.entries.find((e) => e.title === "A1")).toBeUndefined();
    expect(result.entries.find((e) => e.title === "A2")).toBeUndefined();
    expect(result.archived).toHaveLength(2);
    // B1 and B2 survive unchanged
    expect(result.entries.find((e) => e.title === "B1")).toBeDefined();
    expect(result.entries.find((e) => e.title === "B2")).toBeDefined();
  });
});

// --- runConsolidation threshold behavior ---

describe("runConsolidation", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("runs pass 3 even below threshold of 20 entries", async () => {
    // Mock inference to return NO CLUSTERS (so no actual condensation happens)
    // but we verify it was called, proving pass 3 ran.
    // Entries have single CWDs so no promotion candidates — promptUser never called.
    let inferenceCalled = false;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        inferenceCalled = true;
        return { success: true, text: "NO CLUSTERS" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

    // Write 5 entries (well below threshold 20), but with 2+ exposures
    // so findCondensationCandidates finds them. Single CWD = no promotion prompt.
    const entries: LearningEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        cwds: ["/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );

    await writeLearnings(testMemoryDir, entries);
    await runConsolidation(testMemoryDir);

    // Pass 3 must have run — inference was called
    expect(inferenceCalled).toBe(true);
  });

  test("archives condensed entries to learnings-archive.md", async () => {
    const inferenceResponse = `CLUSTER [1, 2] — Bun conventions
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() and bun:test. Avoids Node.js APIs.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: inferenceResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

    // 2 entries with 2+ exposures in same CWD — eligible for condensation.
    // Single CWD each = no promotion candidates, so promptUser never called.
    const entries: LearningEntry[] = [
      makeEntry({
        title: "Use Bun.file()",
        cwds: ["/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: ["/myapp"],
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];

    await writeLearnings(testMemoryDir, entries);
    await runConsolidation(testMemoryDir);

    // Archive file should exist with the 2 source entries
    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(true);

    const archiveContent = await archiveFile.text();
    expect(archiveContent).toContain("Use Bun.file()");
    expect(archiveContent).toContain("Use bun:test");

    // Main learnings should have the compound entry
    const { loadLearnings } = await import("../../../src/memory/learnings");
    const finalEntries = await loadLearnings(testMemoryDir);
    expect(finalEntries).toHaveLength(1);
    expect(finalEntries[0]!.title).toBe("Bun Runtime Conventions");
  });
});
