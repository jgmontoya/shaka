import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateLearnings, writeLearnings } from "../../../src/memory/learning-store";
import type { LearningEntry } from "../../../src/memory/learnings";
import {
  buildRankingPrompt,
  loadLearnings,
  parseRankingOutput,
  renderLearnings,
} from "../../../src/memory/learnings";
import {
  appendMaintenanceLog,
  readMaintenanceState,
  shouldRunMaintenance,
  writeMaintenanceState,
} from "../../../src/memory/maintenance";
import { testCwd, testCwds } from "../../helpers/memory-path";

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? testCwds("/projects/myapp"),
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Use Bun.file() instead of fs.readFile()",
    body: overrides.body ?? "This project uses Bun runtime.",
    ...(overrides.promotionEvidence ? { promotionEvidence: overrides.promotionEvidence } : {}),
  };
}

// --- shouldRunMaintenance ---

describe("shouldRunMaintenance", () => {
  test("returns skip when no new learnings extracted", () => {
    const entries = [makeEntry()];
    const state = { lastRun: "2026-03-01T00:00:00Z", entryCountAtLastRun: 1 };

    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), state, 0);

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
        cwds: testCwds("/projects/myapp"),
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );

    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), state, 2, now);

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
        cwds: testCwds("/projects/myapp"),
      }),
    );

    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), state, 1, now);

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
        cwds: testCwds("/projects/myapp"),
      }),
    );

    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), state, 3, now);

    // Volume gate met (15 - 5 = 10 >= 10), should not skip
    expect(decision.action).not.toBe("skip");
  });

  test("null state (first run) triggers on any new learnings", () => {
    const now = new Date("2026-03-30T12:00:00Z");

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Brief.",
        cwds: testCwds("/projects/myapp"),
      }),
    );

    // null state means never run before — time gate passes (hours since epoch >> 24)
    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), null, 1, now);

    expect(decision.action).not.toBe("skip");
  });

  test("returns skip when time and volume gates both not met", () => {
    // 12 hours ago (< 24h), 5 new entries (< 10)
    const now = new Date("2026-03-30T12:00:00Z");
    const state = { lastRun: "2026-03-30T00:00:00Z", entryCountAtLastRun: 10 };
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({ title: `Entry ${i}`, cwds: testCwds("/projects/myapp") }),
    );

    const decision = shouldRunMaintenance(entries, testCwd("/projects/myapp"), state, 2, now);

    expect(decision).toEqual({ action: "skip", reason: "gates not met" });
  });
});

// --- State file ---

const testMemoryDir = join(tmpdir(), "shaka-test-maintenance");

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
      cwd: testCwd("/projects/myapp"),
      condensed: 4,
      generalized: 2,
      pruned: 2,
      before: 45,
      after: 40,
    };
    const entry2 = {
      timestamp: "2026-03-31T12:00:00Z",
      trigger: "volume",
      cwd: testCwd("/projects/myapp"),
      condensed: 0,
      generalized: 0,
      pruned: 0,
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

const maintenanceTestDir = join(tmpdir(), "shaka-test-run-maintenance");
const CONCURRENCY_OBSERVATION_MS = 250;

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

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 0);

    expect(result).toEqual({ skipped: true, reason: "no new learnings" });
  });

  test("rejects corrupt promotion metadata before maintenance side effects", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
<!-- promotion: invalid-json -->

### Global entry

Body.
`;
    const learningsPath = join(maintenanceTestDir, "learnings.md");
    await Bun.write(learningsPath, raw);

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    await expect(
      runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
        now: new Date("2026-03-30T12:00:00Z"),
      }),
    ).rejects.toThrow("promotion metadata");

    expect(await Bun.file(learningsPath).text()).toBe(raw);
    expect(await Bun.file(join(maintenanceTestDir, "learnings.backup.md")).exists()).toBe(false);
    expect(await Bun.file(join(maintenanceTestDir, ".last-maintenance")).exists()).toBe(false);
    expect(await Bun.file(join(maintenanceTestDir, "maintenance.log")).exists()).toBe(false);
    expect(await Bun.file(join(maintenanceTestDir, "learnings-archive.md")).exists()).toBe(false);
  });

  test("preserves legacy source bytes before writing the operational backup", async () => {
    const raw = `# Learnings

Custom header retained by the backup.

---

<!-- correction | cwd: ${testCwd("/projects/myapp")} | exposures: 2026-02-09@aaaa0000 -->

### Project entry

Body.
`;
    await Bun.write(join(maintenanceTestDir, "learnings.md"), raw);

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });

    expect(
      await Bun.file(join(maintenanceTestDir, ".learning-scope-migration-v1.active.md")).text(),
    ).toBe(raw);
    expect(await Bun.file(join(maintenanceTestDir, "learnings.backup.md")).text()).toBe(
      await Bun.file(join(maintenanceTestDir, "learnings.md")).text(),
    );
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
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

    expect(result.skipped).toBe(false);
    // Backup should exist
    const backupFile = Bun.file(join(maintenanceTestDir, "learnings.backup.md"));
    expect(await backupFile.exists()).toBe(true);
  });

  test("does not block extraction and skips a stale maintenance proposal", async () => {
    let releaseInference!: () => void;
    const inferenceRelease = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    let inferenceStarted!: () => void;
    const inferenceStart = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        inferenceStarted();
        await inferenceRelease;
        return { success: true, text: "NO CLUSTERS" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const maintenance = runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });
    await inferenceStart;

    const extraction = mutateLearnings(maintenanceTestDir, (current) => {
      return [...current, makeEntry({ title: "Concurrent extraction" })];
    });

    const extractionFinishedWhileInferenceWasPending = await Promise.race([
      extraction.then(() => true),
      Bun.sleep(CONCURRENCY_OBSERVATION_MS).then(() => false),
    ]);

    releaseInference();
    const [maintenanceResult] = await Promise.all([maintenance, extraction]);

    expect(extractionFinishedWhileInferenceWasPending).toBe(true);
    expect(maintenanceResult).toEqual({
      skipped: true,
      reason: "learnings changed during maintenance",
    });
    expect(await readMaintenanceState(maintenanceTestDir)).toBeNull();
    expect(await Bun.file(join(maintenanceTestDir, "maintenance.log")).exists()).toBe(false);
    expect((await loadLearnings(maintenanceTestDir)).map((entry) => entry.title)).toContain(
      "Concurrent extraction",
    );
  });

  test("serializes automatic maintenance attempts without duplicating inference", async () => {
    let releaseInference!: () => void;
    const inferenceRelease = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    let firstInferenceStarted!: () => void;
    const firstInferenceStart = new Promise<void>((resolve) => {
      firstInferenceStarted = resolve;
    });
    let secondInferenceStarted!: () => void;
    const secondInferenceStart = new Promise<void>((resolve) => {
      secondInferenceStarted = resolve;
    });
    let inferenceCalls = 0;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        inferenceCalls += 1;
        if (inferenceCalls === 1) firstInferenceStarted();
        if (inferenceCalls === 2) secondInferenceStarted();
        await inferenceRelease;
        return { success: true, text: "NO CLUSTERS" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const first = runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });
    await firstInferenceStart;

    const second = runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:01:00Z"),
    });
    const duplicateInferenceStarted = await Promise.race([
      secondInferenceStart.then(() => true),
      Bun.sleep(CONCURRENCY_OBSERVATION_MS).then(() => false),
    ]);

    releaseInference();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(duplicateInferenceStarted).toBe(false);
    expect(inferenceCalls).toBe(1);
    expect(firstResult.skipped).toBe(false);
    expect(secondResult).toEqual({ skipped: true, reason: "gates not met" });
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
        cwds: testCwds("/projects/myapp"),
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        cwds: testCwds("/projects/myapp"),
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

    const logContent = await Bun.file(join(maintenanceTestDir, "maintenance.log")).text();
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry.timestamp).toBe("2026-03-30T12:00:00.000Z");
    expect(logEntry.cwd).toBe(testCwd("/projects/myapp"));
    expect(logEntry.before).toBe(5);
    expect(logEntry.after).toBe(5);
  });

  test("routine maintenance generalizes three child branches to their parent", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const { loadLearnings: loadL } = await import("../../../src/memory/learnings");

    const entries = [
      makeEntry({
        title: "Cross-project pattern",
        cwds: testCwds("/projects/alpha", "/projects/beta", "/projects/gamma"),
        nonglobal: false,
      }),
      makeEntry({
        title: "Single project entry",
        cwds: testCwds("/projects/myapp"),
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, { now });

    expect(result.generalized).toBe(1);
    expect(result).not.toHaveProperty("promoted");

    const final = await loadL(maintenanceTestDir);
    expect(final.find((entry) => entry.title === "Cross-project pattern")).toMatchObject({
      cwds: testCwds("/projects"),
      promotionEvidence: {
        sourceCwds: testCwds("/projects/alpha", "/projects/beta", "/projects/gamma"),
        reasons: ["automatic-hierarchical-generalization"],
      },
    });
    const log = JSON.parse(
      (await Bun.file(join(maintenanceTestDir, "maintenance.log")).text()).trim(),
    );
    expect(log.generalized).toBe(1);
    expect(log).not.toHaveProperty("promoted");
  });

  test("repeated exposures at one CWD do not widen during maintenance", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const entry = makeEntry({
      cwds: testCwds("/projects/myapp"),
      exposures: [
        { date: "2026-03-01", sessionHash: "aaaa1111" },
        { date: "2026-03-02", sessionHash: "bbbb2222" },
        { date: "2026-03-03", sessionHash: "cccc3333" },
      ],
    });
    await writeLearnings(maintenanceTestDir, [entry]);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });

    expect(result.generalized).toBe(0);
    expect(await loadLearnings(maintenanceTestDir)).toEqual([entry]);
  });

  test("an unchanged second maintenance pass reports no generalization", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    await writeLearnings(maintenanceTestDir, [
      makeEntry({
        cwds: testCwds("/projects/alpha", "/projects/beta", "/projects/gamma"),
      }),
    ]);

    const first = await runMaintenance(maintenanceTestDir, testCwd("/projects/alpha"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });
    const second = await runMaintenance(maintenanceTestDir, testCwd("/projects/alpha"), 1, {
      now: new Date("2026-03-31T13:00:00Z"),
    });

    expect(first.generalized).toBe(1);
    expect(second.generalized).toBe(0);
    expect((await loadLearnings(maintenanceTestDir))[0]?.promotionEvidence?.reasons).toEqual([
      "automatic-hierarchical-generalization",
    ]);
  });

  test("a logging failure does not undo the already-protected active write", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: "NO CLUSTERS" }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const sourceEntry = makeEntry({
      title: "Cross-project pattern",
      cwds: testCwds("/projects/alpha", "/projects/beta", "/projects/gamma"),
      exposures: [
        { date: "2026-03-01", sessionHash: "alpha123" },
        { date: "2026-03-02", sessionHash: "beta456" },
      ],
    });
    await writeLearnings(maintenanceTestDir, [sourceEntry]);
    await mkdir(join(maintenanceTestDir, "maintenance.log"));

    await expect(
      runMaintenance(maintenanceTestDir, testCwd("/projects/alpha"), 1, {
        now: new Date("2026-03-30T12:00:00Z"),
      }),
    ).rejects.toThrow();

    expect(await loadLearnings(maintenanceTestDir)).toEqual([
      expect.objectContaining({
        ...sourceEntry,
        cwds: testCwds("/projects"),
        promotionEvidence: expect.objectContaining({
          sourceCwds: testCwds("/projects/alpha", "/projects/beta", "/projects/gamma"),
        }),
      }),
    ]);
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
        body: `Detailed body for entry ${i}. `.repeat(5).trim(),
        cwds: testCwds("/projects/myapp"),
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        body: `Detailed body for entry ${i}. `.repeat(5).trim(),
        cwds: testCwds("/projects/myapp"),
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

    expect(result.pruned).toBe(3);
  });

  test("automatic pruning excludes promotion evidence and nonglobal state", async () => {
    let rankingPrompt = "";
    mock.module("../../../src/inference", () => ({
      inference: async ({ userPrompt }: { userPrompt: string }) => {
        if (userPrompt.startsWith("Rank these entries")) {
          rankingPrompt = userPrompt;
          return { success: true, text: "ALL ACCEPTABLE" };
        }
        return { success: true, text: "NO DUPLICATES" };
      },
      hasInferenceProvider: async () => false,
    }));
    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const durable = [
      makeEntry({
        title: "Evidence-bearing durable entry",
        body: "Durable body. ".repeat(8).trim(),
        promotionEvidence: {
          sourceCwds: testCwds("/projects/myapp"),
          excludedCwds: [],
          exposures: [],
          reasons: ["manual-scope-correction"],
        },
      }),
      makeEntry({
        title: "Explicit nonglobal entry",
        body: "Durable body. ".repeat(8).trim(),
        nonglobal: true,
      }),
    ];
    const ordinary = Array.from({ length: 38 }, (_, index) =>
      makeEntry({
        title: `Ordinary prune candidate ${index}`,
        body: `Detailed body ${index}. `.repeat(8).trim(),
        exposures: [{ date: "2026-03-01", sessionHash: `old${String(index).padStart(5, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, [...durable, ...ordinary]);

    await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });

    expect(rankingPrompt).toContain("Ordinary prune candidate");
    expect(rankingPrompt).not.toContain("Evidence-bearing durable entry");
    expect(rankingPrompt).not.toContain("Explicit nonglobal entry");
    const finalTitles = (await loadLearnings(maintenanceTestDir)).map((entry) => entry.title);
    expect(finalTitles).toContain("Evidence-bearing durable entry");
    expect(finalTitles).toContain("Explicit nonglobal entry");
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
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        body: `Detailed body for entry ${i}. `.repeat(5).trim(),
        cwds: testCwds("/projects/myapp"),
        exposures: [{ date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        body: `Detailed body for entry ${i}. `.repeat(5).trim(),
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${String(i).padStart(4, "0")}` },
          { date: "2026-03-10", sessionHash: `sec${String(i).padStart(5, "0")}` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        body: `Detailed body for entry ${i}. `.repeat(5).trim(),
        cwds: testCwds("/projects/myapp"),
        exposures: [{ date: "2026-03-24", sessionHash: `hash${String(i).padStart(4, "0")}` }],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, { now });

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
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, { now });

    expect(result.skipped).toBe(false);
    expect(result.before).toBe(2);
    expect(result.condensed).toBe(1);
    expect(typeof result.after).toBe("number");
  });

  test("does not archive sources when a compound cannot be represented", async () => {
    const condensationResponse = `CLUSTER [1, 2] — Invalid compound
TITLE: Invalid compound
BODY: Keep before.
---
Keep after.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: condensationResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");
    const activePath = join(maintenanceTestDir, "learnings.md");
    const archivePath = join(maintenanceTestDir, "learnings-archive.md");
    const entries = [
      makeEntry({
        title: "One",
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Two",
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];
    await writeLearnings(maintenanceTestDir, entries);
    await Bun.write(archivePath, renderLearnings([makeEntry({ title: "Existing archive" })]));
    const activeSource = await Bun.file(activePath).text();
    const archiveSource = await Bun.file(archivePath).text();

    const result = await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 1, {
      now: new Date("2026-03-30T12:00:00Z"),
    });

    expect(result.condensed).toBe(0);
    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).toBe(archiveSource);
  });

  test("forwards provider hint to every inference() call", async () => {
    // Regression guard: runMaintenance and the consolidation helpers it
    // delegates to must forward the session's originating provider hint
    // so each inference() call can resolve the right per-provider model.
    // Previously they threaded `model?: string`, which coupled callers to
    // a specific CLI's model-string format.
    const seenProviders: Array<string | undefined> = [];
    mock.module("../../../src/inference", () => ({
      inference: async (options: { provider?: string }) => {
        seenProviders.push(options.provider);
        return { success: true, text: "NO CLUSTERS" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runMaintenance } = await import("../../../src/memory/maintenance");

    // Enough entries with 2+ exposures to trigger condensation AND enough
    // total entries (>=20) to trigger dedup + contradictions passes. That way
    // the test exercises all three consolidation inference calls.
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        body: "Body.",
        cwds: testCwds("/projects/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );
    await writeLearnings(maintenanceTestDir, entries);

    const now = new Date("2026-03-30T12:00:00Z");
    await runMaintenance(maintenanceTestDir, testCwd("/projects/myapp"), 2, {
      now,
      provider: "opencode",
    });

    expect(seenProviders.length).toBeGreaterThan(0);
    for (const p of seenProviders) {
      expect(p).toBe("opencode");
    }
  });
});
