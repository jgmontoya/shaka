import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LearningEntry } from "../../../src/memory/learnings";
import {
  buildRankingPrompt,
  parseRankingOutput,
  renderLearnings,
  writeLearnings,
} from "../../../src/memory/learnings";
import {
  appendMaintenanceLog,
  readMaintenanceState,
  shouldRunMaintenance,
  writeMaintenanceState,
} from "../../../src/memory/maintenance";

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

// --- shouldRunMaintenance ---

describe("shouldRunMaintenance", () => {
  test("returns skip when no new learnings extracted", () => {
    const entries = [makeEntry()];
    const state = { lastRun: "2026-03-01T00:00:00Z", entryCountAtLastRun: 1 };

    const decision = shouldRunMaintenance(entries, "/projects/myapp", state, 0);

    expect(decision).toEqual({ action: "skip", reason: "no new learnings" });
  });

  test("returns consolidate-and-prune when time gate passes and budget has pressure", () => {
    // 25 hours ago (> 24h), enough entries to exceed 6KB budget
    const now = new Date("2026-03-30T12:00:00Z");
    const state = { lastRun: "2026-03-29T11:00:00Z", entryCountAtLastRun: 30 };

    // Create many entries for /projects/myapp so selectLearnings can't fit them all
    const entries = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Learning Entry Number ${i} That Takes Up Budget Space`,
        body: `This is a detailed body for entry ${i}. It contains enough text to consume budget. `.repeat(
          3,
        ),
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );

    const decision = shouldRunMaintenance(entries, "/projects/myapp", state, 2, now);

    expect(decision.action).toBe("consolidate-and-prune");
  });

  test("returns consolidate-only when time gate passes but no budget pressure", () => {
    // 25 hours ago (> 24h), entries fit in budget
    const now = new Date("2026-03-30T12:00:00Z");
    const state = { lastRun: "2026-03-29T11:00:00Z", entryCountAtLastRun: 3 };

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Short Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
      }),
    );

    const decision = shouldRunMaintenance(entries, "/projects/myapp", state, 1, now);

    expect(decision).toEqual({ action: "consolidate-only" });
  });

  test("volume gate triggers maintenance even before 24h", () => {
    // 6 hours ago (< 24h), but 12 new entries (>= 10)
    const now = new Date("2026-03-30T12:00:00Z");
    const state = { lastRun: "2026-03-30T06:00:00Z", entryCountAtLastRun: 5 };

    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({
        title: `Short Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
      }),
    );

    const decision = shouldRunMaintenance(entries, "/projects/myapp", state, 3, now);

    // Volume gate met (15 - 5 = 10 >= 10), should not skip
    expect(decision.action).not.toBe("skip");
  });

  test("null state (first run) triggers on any new learnings", () => {
    const now = new Date("2026-03-30T12:00:00Z");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
      }),
    );

    // null state means never run before — time gate passes (hours since epoch >> 24)
    const decision = shouldRunMaintenance(entries, "/projects/myapp", null, 1, now);

    expect(decision.action).not.toBe("skip");
  });

  test("returns skip when time and volume gates both not met", () => {
    // 12 hours ago (< 24h), 5 new entries (< 10)
    const now = new Date("2026-03-30T12:00:00Z");
    const state = { lastRun: "2026-03-30T00:00:00Z", entryCountAtLastRun: 10 };
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ title: `Entry ${i}`, cwds: ["/projects/myapp"] }),
    );

    const decision = shouldRunMaintenance(entries, "/projects/myapp", state, 2, now);

    expect(decision).toEqual({ action: "skip", reason: "gates not met" });
  });
});

// --- State file ---

const testMemoryDir = "/tmp/shaka-test-maintenance";

describe("readMaintenanceState", () => {
  beforeEach(async () => {
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("returns null when file does not exist", async () => {
    const state = await readMaintenanceState(testMemoryDir);
    expect(state).toBeNull();
  });

  test("returns null when file contains invalid JSON", async () => {
    await Bun.write(`${testMemoryDir}/.last-maintenance`, "not json {{{");
    const state = await readMaintenanceState(testMemoryDir);
    expect(state).toBeNull();
  });

  test("returns null when JSON has wrong shape", async () => {
    await Bun.write(`${testMemoryDir}/.last-maintenance`, JSON.stringify({ lastRun: 123 }));
    const state = await readMaintenanceState(testMemoryDir);
    expect(state).toBeNull();
  });
});

describe("writeMaintenanceState", () => {
  beforeEach(async () => {
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("writes state and reads it back correctly", async () => {
    const state = { lastRun: "2026-03-30T12:00:00Z", entryCountAtLastRun: 42 };

    await writeMaintenanceState(testMemoryDir, state);
    const readBack = await readMaintenanceState(testMemoryDir);

    expect(readBack).toEqual(state);
  });
});

// --- Maintenance log ---

describe("appendMaintenanceLog", () => {
  beforeEach(async () => {
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("creates file and appends JSONL entries", async () => {
    const entry1 = {
      timestamp: "2026-03-30T12:00:00Z",
      trigger: "time",
      cwd: "/projects/myapp",
      condensed: 4,
      pruned: 2,
      promoted: 1,
      before: 45,
      after: 40,
    };
    const entry2 = {
      timestamp: "2026-03-31T12:00:00Z",
      trigger: "volume",
      cwd: "/projects/myapp",
      condensed: 0,
      pruned: 0,
      promoted: 0,
      before: 40,
      after: 40,
    };

    await appendMaintenanceLog(testMemoryDir, entry1);
    await appendMaintenanceLog(testMemoryDir, entry2);

    const content = await Bun.file(`${testMemoryDir}/maintenance.log`).text();
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(entry1);
    expect(JSON.parse(lines[1]!)).toEqual(entry2);
  });
});

// --- buildRankingPrompt ---

describe("buildRankingPrompt", () => {
  test("includes all entries it receives (caller pre-filters)", () => {
    const entries = [makeEntry({ title: "Entry A" }), makeEntry({ title: "Entry B" })];

    const prompt = buildRankingPrompt(entries);

    expect(prompt).toContain("Entry A");
    expect(prompt).toContain("Entry B");
  });

  test("uses same QUALITY_GATES as quality assessment prompt", () => {
    const entries = [makeEntry({ title: "Eligible" })];

    const prompt = buildRankingPrompt(entries);

    expect(prompt).toContain("NON-OBVIOUS");
    expect(prompt).toContain("RECURRING");
    expect(prompt).toContain("BEHAVIOR-CHANGING");
  });

  test("numbered [1]...[N] format", () => {
    const entries = [makeEntry({ title: "Entry A" }), makeEntry({ title: "Entry B" })];

    const prompt = buildRankingPrompt(entries);

    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });

  test("returns null for empty input", () => {
    expect(buildRankingPrompt([])).toBeNull();
  });
});

// --- parseRankingOutput ---

describe("parseRankingOutput", () => {
  test("parses RANK lines to 0-based indices", () => {
    const raw = `RANK 1 [3] — general engineering wisdom, not project-specific
RANK 2 [1] — one-time debugging step`;

    const verdicts = parseRankingOutput(raw);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({
      index: 2,
      reason: "general engineering wisdom, not project-specific",
    });
    expect(verdicts[1]).toEqual({ index: 0, reason: "one-time debugging step" });
  });

  test("ALL ACCEPTABLE returns empty array", () => {
    expect(parseRankingOutput("ALL ACCEPTABLE")).toEqual([]);
  });

  test("malformed lines are skipped", () => {
    const raw = `Some preamble
RANK 1 [2] — valid reason
This is garbage
RANK bad format
RANK 2 [5] — another valid reason`;

    const verdicts = parseRankingOutput(raw);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.index).toBe(1);
    expect(verdicts[1]!.index).toBe(4);
  });

  test("handles em-dash and en-dash separators", () => {
    const raw = `RANK 1 [1] \u2014 em-dash reason
RANK 2 [2] \u2013 en-dash reason`;

    const verdicts = parseRankingOutput(raw);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.reason).toBe("em-dash reason");
    expect(verdicts[1]!.reason).toBe("en-dash reason");
  });

  test("sorts by rank number even when LLM outputs out of order", () => {
    const raw = `RANK 3 [5] — third worst
RANK 1 [2] — worst entry
RANK 2 [3] — second worst`;

    const verdicts = parseRankingOutput(raw);

    expect(verdicts).toHaveLength(3);
    expect(verdicts[0]!.index).toBe(1); // [2] -> 0-based 1 (rank 1)
    expect(verdicts[1]!.index).toBe(2); // [3] -> 0-based 2 (rank 2)
    expect(verdicts[2]!.index).toBe(4); // [5] -> 0-based 4 (rank 3)
  });
});

// --- runMaintenance ---

const maintenanceTestDir = "/tmp/shaka-test-run-maintenance";

describe("runMaintenance", () => {
  beforeEach(async () => {
    await rm(maintenanceTestDir, { recursive: true, force: true });
    await mkdir(maintenanceTestDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(maintenanceTestDir, { recursive: true, force: true });
  });

  test("skips when shouldRunMaintenance returns skip (tracer bullet)", async () => {
    // Arrange: no new learnings -> decision is skip
    const entries = [makeEntry()];
    await writeLearnings(maintenanceTestDir, entries);

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 0);

    expect(result).toEqual({ skipped: true, reason: "no new learnings" });
  });

  test("runs condensation and writes backup when decision is consolidate-only", async () => {
    // Arrange: first run (null state), 2+ exposure entries trigger condensation
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    expect(result.skipped).toBe(false);
    // Backup should exist
    const backupFile = Bun.file(join(maintenanceTestDir, "learnings.backup.md"));
    expect(await backupFile.exists()).toBe(true);
  });

  test("updates state file after successful run", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    const state = await readMaintenanceState(maintenanceTestDir);
    expect(state).not.toBeNull();
    expect(state!.lastRun).toBe("2026-03-30T12:00:00.000Z");
    expect(state!.entryCountAtLastRun).toBe(5);
  });

  test("appends to JSONL maintenance log after run", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Brief.",
        cwds: ["/projects/myapp"],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    const logContent = await Bun.file(join(maintenanceTestDir, "maintenance.log")).text();
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry.timestamp).toBe("2026-03-30T12:00:00.000Z");
    expect(logEntry.cwd).toBe("/projects/myapp");
    expect(logEntry.before).toBe(5);
    expect(logEntry.after).toBe(5);
  });

  test("auto-promotes entries appearing in 3+ CWDs without user prompt", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const { loadLearnings: loadL } = await import("../../../src/memory/learnings");

    // Entry appears in 3 CWDs and is not nonglobal -> should be auto-promoted
    const entries = [
      makeEntry({
        title: "Cross-project pattern",
        cwds: ["/projects/alpha", "/projects/beta", "/projects/gamma"],
        nonglobal: false,
      }),
      makeEntry({
        title: "Single project entry",
        cwds: ["/projects/myapp"],
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 1, now);

    expect(result.promoted).toBe(1);

    const final = await loadL(maintenanceTestDir);
    const promoted = final.find((e) => e.title === "Cross-project pattern");
    expect(promoted).toBeDefined();
    expect(promoted!.cwds).toEqual(["*"]);
  });

  test("does not promote nonglobal entries", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const { loadLearnings: loadL } = await import("../../../src/memory/learnings");

    const entries = [
      makeEntry({
        title: "Nonglobal entry",
        cwds: ["/projects/alpha", "/projects/beta", "/projects/gamma"],
        nonglobal: true, // user opted out
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 1, now);

    expect(result.promoted).toBe(0);

    const final = await loadL(maintenanceTestDir);
    expect(final[0]!.cwds).toEqual(["/projects/alpha", "/projects/beta", "/projects/gamma"]);
  });

  test("auto-prunes bottom-ranked entries when decision is consolidate-and-prune", async () => {
    let callCount = 0;
    const rankingResponse = `RANK 1 [1] — general engineering wisdom
RANK 2 [2] — one-time debugging step`;

    mock.module("../../../src/inference", () => ({
      inference: async () => {
        callCount++;
        if (callCount <= 2) return { success: true, text: "NO DUPLICATES" };
        return { success: true, text: rankingResponse };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const { loadLearnings: loadL } = await import("../../../src/memory/learnings");

    const now = new Date("2026-03-30T12:00:00Z");

    const entries: LearningEntry[] = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Entry ${i} That Takes Up Budget Space`,
        body: `Detailed body for entry ${i}. `.repeat(5),
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    expect(result.pruned).toBe(2);

    const final = await loadL(maintenanceTestDir);
    expect(final.length).toBe(38);
  });

  test("respects AUTO_PRUNE_MAX cap of 3", async () => {
    let callCount = 0;
    const rankingResponse = `RANK 1 [1] — reason 1
RANK 2 [2] — reason 2
RANK 3 [3] — reason 3
RANK 4 [4] — reason 4
RANK 5 [5] — reason 5`;

    mock.module("../../../src/inference", () => ({
      inference: async () => {
        callCount++;
        if (callCount <= 2) return { success: true, text: "NO DUPLICATES" };
        return { success: true, text: rankingResponse };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const now = new Date("2026-03-30T12:00:00Z");

    const entries: LearningEntry[] = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Entry ${i} That Takes Budget`,
        body: `Detailed body for entry ${i}. `.repeat(5),
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    expect(result.pruned).toBe(3);
  });

  test("inference failure in consolidation does not crash (fail-open)", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        throw new Error("network timeout");
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        cwds: ["/projects/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    expect(result.skipped).toBe(false);
    const state = await readMaintenanceState(maintenanceTestDir);
    expect(state).not.toBeNull();
  });

  test("inference failure during auto-prune does not crash (fail-open)", async () => {
    let callCount = 0;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        callCount++;
        if (callCount <= 2) return { success: true, text: "NO DUPLICATES" };
        throw new Error("ranking timeout");
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const now = new Date("2026-03-30T12:00:00Z");

    // Budget pressure: many large entries
    const entries: LearningEntry[] = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Entry ${i} That Takes Budget`,
        body: `Detailed body for entry ${i}. `.repeat(5),
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    // Pruning failed, but pipeline completed
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(0);
    // State still updated
    const state = await readMaintenanceState(maintenanceTestDir);
    expect(state).not.toBeNull();
  });

  test("does not prune entries with exactly 2 exposures (exposure floor)", async () => {
    const rankingResponse = `RANK 1 [1] — should not be pruned`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: rankingResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const { loadLearnings: loadL } = await import("../../../src/memory/learnings");

    const now = new Date("2026-03-30T12:00:00Z");

    // Entry with exactly 2 exposures — must NOT be prunable
    const entries: LearningEntry[] = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Entry ${i} That Takes Budget`,
        body: `Detailed body for entry ${i}. `.repeat(5),
        cwds: ["/projects/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` },
          { date: "2026-03-10", sessionHash: `sec${String(i).padStart(5, "0")}` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    // All entries have 2 exposures, none should be prunable regardless of ranking
    expect(result.pruned).toBe(0);
  });

  test("does not prune entries younger than 7 days (age floor)", async () => {
    const rankingResponse = `RANK 1 [1] — should not be pruned`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: rankingResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const now = new Date("2026-03-30T12:00:00Z");

    // Entries created 6 days ago (< 7 day floor)
    const entries: LearningEntry[] = Array.from({ length: 40 }, (_, i) =>
      makeEntry({
        title: `Long Entry ${i} That Takes Budget`,
        body: `Detailed body for entry ${i}. `.repeat(5),
        cwds: ["/projects/myapp"],
        exposures: [{ date: "2026-03-24", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 2, now);

    // All entries are < 7 days old, none should be prunable
    expect(result.pruned).toBe(0);
  });

  test("returns result with counts for monitoring", async () => {
    const condensationResponse = `CLUSTER [1, 2] — Bun conventions
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() and bun:test. Avoids Node.js APIs.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: condensationResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    const entries = [
      makeEntry({
        title: "Use Bun.file()",
        cwds: ["/projects/myapp"],
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: ["/projects/myapp"],
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, "/projects/myapp", 1, now);

    expect(result.skipped).toBe(false);
    expect(result.before).toBe(2);
    expect(result.condensed).toBe(1);
    expect(typeof result.after).toBe("number");
  });
});
