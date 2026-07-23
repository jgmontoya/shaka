import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDENSATION_COMMIT_FILE } from "../../../src/memory/condensation-commit";
import {
  type CandidateWithClusters,
  applyCondensation,
  applyDuplicateMerges,
} from "../../../src/memory/consolidation";
import {
  type ConsolidationCommitRequest,
  appendToArchive,
  commitConsolidationIfUnchanged,
  commitConsolidationIfUnchangedUnderLock,
  mutateLearnings,
  writeLearnings,
} from "../../../src/memory/learning-store";
import {
  type LearningEntry,
  loadLearnings,
  parseLearnings,
  renderLearnings,
  withLearningsLock,
} from "../../../src/memory/learnings";
import { testCwd, testCwds } from "../../helpers/memory-path";

function makeEntry(title: string, sessionHash: string): LearningEntry {
  return {
    category: "correction",
    cwds: testCwds("/projects/condensation-commit"),
    exposures: [{ date: "2026-07-21", sessionHash }],
    nonglobal: false,
    title,
    body: `${title} body.`,
  };
}

async function interruptCommit(
  memoryDir: string,
  request: ConsolidationCommitRequest,
  checkpoint: "intent-published" | "archive-replaced" | "active-replaced",
): Promise<boolean> {
  return await withLearningsLock(memoryDir, () =>
    commitConsolidationIfUnchangedUnderLock(memoryDir, request, {
      afterCheckpoint: (current) => {
        if (current === checkpoint) throw new Error("synthetic interruption");
      },
    }),
  );
}

describe("commitConsolidationIfUnchanged", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "shaka-condensation-commit-"));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  test("the next mutation completes an interrupted archive-first commit exactly once", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    await writeLearnings(memoryDir, sources);
    expect(await Bun.file(archivePath).exists()).toBe(false);

    await expect(
      interruptCommit(
        memoryDir,
        {
          expectedActive: sources,
          activeReplacement: [compound],
          archiveEntries: sources,
        },
        "archive-replaced",
      ),
    ).rejects.toThrow("synthetic interruption");

    expect(await loadLearnings(memoryDir)).toEqual(sources);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual(sources);

    await mutateLearnings(memoryDir, (entries) => entries);

    expect(await loadLearnings(memoryDir)).toEqual([compound]);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual(sources);
    expect(await Bun.file(activePath).text()).not.toContain("### Source A");
    expect(await Bun.file(activePath).text()).not.toContain("### Source B");
  });

  test("the next mutation completes a commit interrupted before either target changes", async () => {
    const archivePath = join(memoryDir, "learnings-archive.md");
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    await writeLearnings(memoryDir, sources);

    await expect(
      interruptCommit(
        memoryDir,
        {
          expectedActive: sources,
          activeReplacement: [compound],
          archiveEntries: sources,
        },
        "intent-published",
      ),
    ).rejects.toThrow("synthetic interruption");

    expect(await loadLearnings(memoryDir)).toEqual(sources);
    expect(await Bun.file(archivePath).exists()).toBe(false);
    if (process.platform !== "win32") {
      expect((await lstat(join(memoryDir, CONDENSATION_COMMIT_FILE))).mode & 0o777).toBe(0o600);
    }

    await mutateLearnings(memoryDir, (entries) => entries);

    expect(await loadLearnings(memoryDir)).toEqual([compound]);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual(sources);
  });

  test("the next mutation cleans up a fully published commit without duplicating the archive", async () => {
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const archivedEarlier = makeEntry("Earlier archive", "eeeeeeee");
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    await writeLearnings(memoryDir, sources);
    await appendToArchive(memoryDir, [archivedEarlier]);

    await expect(
      interruptCommit(
        memoryDir,
        {
          expectedActive: sources,
          activeReplacement: [compound],
          archiveEntries: sources,
        },
        "active-replaced",
      ),
    ).rejects.toThrow("synthetic interruption");

    expect(await loadLearnings(memoryDir)).toEqual([compound]);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual([
      archivedEarlier,
      ...sources,
    ]);
    expect(await Bun.file(intentPath).exists()).toBe(true);

    await mutateLearnings(memoryDir, (entries) => entries);

    expect(await loadLearnings(memoryDir)).toEqual([compound]);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual([
      archivedEarlier,
      ...sources,
    ]);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("recovery fails closed when an interrupted target has changed independently", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    const unrelatedActive = renderLearnings([makeEntry("Independent update", "dddddddd")]);
    await writeLearnings(memoryDir, sources);

    await expect(
      interruptCommit(
        memoryDir,
        {
          expectedActive: sources,
          activeReplacement: [compound],
          archiveEntries: sources,
        },
        "archive-replaced",
      ),
    ).rejects.toThrow("synthetic interruption");
    await Bun.write(activePath, unrelatedActive);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "unexpected third state",
    );

    expect(await Bun.file(activePath).text()).toBe(unrelatedActive);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual(sources);
    expect(await Bun.file(intentPath).exists()).toBe(true);
  });

  test("an archive third state is detected before active publication", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    const unrelatedArchive = renderLearnings([makeEntry("Independent archive", "dddddddd")]);
    await writeLearnings(memoryDir, sources);
    const activeSource = await Bun.file(activePath).text();

    await expect(
      interruptCommit(
        memoryDir,
        {
          expectedActive: sources,
          activeReplacement: [compound],
          archiveEntries: sources,
        },
        "intent-published",
      ),
    ).rejects.toThrow("synthetic interruption");
    await Bun.write(archivePath, unrelatedArchive);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "unexpected third state",
    );

    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).toBe(unrelatedArchive);
    expect(await Bun.file(intentPath).exists()).toBe(true);
  });

  test("a public mutation refuses a malformed pending intent", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const active = [makeEntry("Active", "aaaaaaaa")];
    const archived = makeEntry("Archived", "bbbbbbbb");
    await writeLearnings(memoryDir, active);
    await appendToArchive(memoryDir, [archived]);
    const activeSource = await Bun.file(activePath).text();
    const archiveSource = await Bun.file(archivePath).text();
    await Bun.write(intentPath, "{not-json}\n");

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "Condensation intent is malformed",
    );

    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).toBe(archiveSource);
    expect(await Bun.file(intentPath).text()).toBe("{not-json}\n");
  });

  test("a stale active snapshot leaves both targets untouched and creates no intent", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const current = makeEntry("Current active", "aaaaaaaa");
    const stale = makeEntry("Stale active", "bbbbbbbb");
    const archivedEarlier = makeEntry("Earlier archive", "cccccccc");
    const compound = makeEntry("Compound", "dddddddd");
    await writeLearnings(memoryDir, [current]);
    await appendToArchive(memoryDir, [archivedEarlier]);
    const activeSource = await Bun.file(activePath).text();
    const archiveSource = await Bun.file(archivePath).text();

    const committed = await commitConsolidationIfUnchanged(memoryDir, {
      expectedActive: [stale],
      activeReplacement: [compound],
      archiveEntries: [stale],
    });

    expect(committed).toBe(false);
    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).toBe(archiveSource);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("a successful commit appends sources to the freshest archive snapshot", async () => {
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const archivedEarlier = makeEntry("Earlier archive", "cccccccc");
    const compound = makeEntry("Compound", "dddddddd");
    await writeLearnings(memoryDir, sources);
    await appendToArchive(memoryDir, [archivedEarlier]);

    const committed = await commitConsolidationIfUnchanged(memoryDir, {
      expectedActive: sources,
      activeReplacement: [compound],
      archiveEntries: sources,
    });

    expect(committed).toBe(true);
    expect(await loadLearnings(memoryDir)).toEqual([compound]);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual([
      archivedEarlier,
      ...sources,
    ]);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("an active-only commit neither creates nor modifies archive storage", async () => {
    const archiveAbsentDir = join(memoryDir, "archive-absent");
    const archivePresentDir = join(memoryDir, "archive-present");
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const compound = makeEntry("Compound", "cccccccc");
    const archivedEarlier = makeEntry("Earlier archive", "dddddddd");
    await writeLearnings(archiveAbsentDir, sources);
    await writeLearnings(archivePresentDir, sources);
    await appendToArchive(archivePresentDir, [archivedEarlier]);
    const existingArchivePath = join(archivePresentDir, "learnings-archive.md");
    const existingArchiveSource = await Bun.file(existingArchivePath).text();

    const absentCommitted = await commitConsolidationIfUnchanged(archiveAbsentDir, {
      expectedActive: sources,
      activeReplacement: [compound],
      archiveEntries: [],
    });
    const presentCommitted = await commitConsolidationIfUnchanged(archivePresentDir, {
      expectedActive: sources,
      activeReplacement: [compound],
      archiveEntries: [],
    });

    expect(absentCommitted).toBe(true);
    expect(presentCommitted).toBe(true);
    expect(await loadLearnings(archiveAbsentDir)).toEqual([compound]);
    expect(await loadLearnings(archivePresentDir)).toEqual([compound]);
    expect(await Bun.file(join(archiveAbsentDir, "learnings-archive.md")).exists()).toBe(false);
    expect(await Bun.file(existingArchivePath).text()).toBe(existingArchiveSource);
    expect(await Bun.file(join(archiveAbsentDir, CONDENSATION_COMMIT_FILE)).exists()).toBe(false);
    expect(await Bun.file(join(archivePresentDir, CONDENSATION_COMMIT_FILE)).exists()).toBe(false);
  });

  test("an invalid active replacement is rejected before transaction side effects", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const archivedEarlier = makeEntry("Earlier archive", "cccccccc");
    const invalidCompound: LearningEntry = {
      ...makeEntry("Invalid compound", "dddddddd"),
      cwds: ["*"],
      promotionEvidence: {
        sourceCwds: testCwds("/projects/condensation-commit"),
        excludedCwds: testCwds("/projects/condensation-commit"),
        exposures: [],
        reasons: ["manual-scope-correction"],
      },
    };
    await writeLearnings(memoryDir, sources);
    await appendToArchive(memoryDir, [archivedEarlier]);
    const activeSource = await Bun.file(activePath).text();
    const archiveSource = await Bun.file(archivePath).text();

    await expect(
      commitConsolidationIfUnchanged(memoryDir, {
        expectedActive: sources,
        activeReplacement: [invalidCompound],
        archiveEntries: sources,
      }),
    ).rejects.toThrow("invalid applicability scope");

    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).toBe(archiveSource);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("corrupt active provenance is rejected before transaction side effects", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const sources = [makeEntry("Source A", "aaaaaaaa"), makeEntry("Source B", "bbbbbbbb")];
    const archivedEarlier = makeEntry("Earlier archive", "cccccccc");
    const compound = makeEntry("Compound", "dddddddd");
    await writeLearnings(memoryDir, sources);
    await appendToArchive(memoryDir, [archivedEarlier]);
    const corruptActive = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-07-21@aaaaaaaa -->
<!-- promotion: invalid-json -->

### Corrupt active

Body.
`;
    await Bun.write(activePath, corruptActive);
    const archiveSource = await Bun.file(archivePath).text();

    await expect(
      commitConsolidationIfUnchanged(memoryDir, {
        expectedActive: sources,
        activeReplacement: [compound],
        archiveEntries: sources,
      }),
    ).rejects.toThrow("promotion metadata");

    expect(await Bun.file(activePath).text()).toBe(corruptActive);
    expect(await Bun.file(archivePath).text()).toBe(archiveSource);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });

  test("commits sources transformed by an earlier consolidation pass", async () => {
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
    const original = [
      makeEntry("Duplicate A", "aaaaaaaa"),
      makeEntry("Duplicate B", "bbbbbbbb"),
      makeEntry("Related source", "cccccccc"),
    ];
    const duplicateResult = applyDuplicateMerges(original, [{ keep: 0, drop: [1] }]);
    const candidate: CandidateWithClusters = {
      candidate: {
        cwd: testCwd("/projects/condensation-commit"),
        entries: duplicateResult.entries,
        indices: [0, 1],
      },
      clusters: [
        {
          indices: [0, 1],
          label: "Combined topic",
          title: "Compound",
          body: "Combined body.",
        },
      ],
    };
    const condensation = applyCondensation(duplicateResult.entries, [candidate]);
    expect(original).not.toContainEqual(condensation.archived[0]);
    await writeLearnings(memoryDir, original);

    const committed = await commitConsolidationIfUnchanged(memoryDir, {
      expectedActive: original,
      activeReplacement: condensation.entries,
      archiveEntries: condensation.archived,
    });

    expect(committed).toBe(true);
    expect(await loadLearnings(memoryDir)).toEqual(condensation.entries);
    expect(parseLearnings(await Bun.file(archivePath).text())).toEqual(condensation.archived);
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });
});
