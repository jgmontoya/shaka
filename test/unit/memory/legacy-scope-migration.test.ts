import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LearningEntry,
  appendToArchive,
  loadLearnings,
  mutateLearnings,
  parseLearnings,
  renderLearnings,
  withLearningsLock,
  writeLearnings,
} from "../../../src/index";
import { ensureLegacyScopeMigratedUnderLock } from "../../../src/memory/legacy-scope-migration";
import { writeSummary } from "../../../src/memory/storage";
import { hashSessionId } from "../../../src/memory/utils";
import { testCwds } from "../../helpers/memory-path";

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "pattern",
    cwds: overrides.cwds ?? testCwds("/work/project"),
    exposures: overrides.exposures ?? [{ date: "2026-07-20", sessionHash: "abcd1234" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Use the project convention",
    body: overrides.body ?? "Follow the established project convention.",
    ...(overrides.promotionEvidence ? { promotionEvidence: overrides.promotionEvidence } : {}),
  };
}

describe("legacy learning-scope migration", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "shaka-learning-scope-migration-"));
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  test("a package-root mutator establishes migration readiness before writing", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const companionCwd = join(memoryDir, "company-a", "project-1");
    const source = `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-19@legacy00 -->

### Legacy global

Keep its global applicability.
`;
    await Bun.write(activePath, source);
    if (process.platform !== "win32") await chmod(activePath, 0o600);

    await mutateLearnings(memoryDir, (entries) => [
      ...entries,
      makeEntry({ title: "New learning" }),
    ]);

    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    const intentText = await Bun.file(
      join(memoryDir, ".learning-scope-migration-v1.intent.json"),
    ).text();
    const intentHash = new Bun.CryptoHasher("sha256").update(intentText).digest("hex");
    expect(marker.version).toBe(1);
    expect(marker.intentSha256).toBe(intentHash);
    expect(marker.counts).toEqual(JSON.parse(intentText).counts);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.active.md")).text()).toBe(
      source,
    );
    const migrated = await loadLearnings(memoryDir);
    expect(migrated.map((entry) => entry.title)).toEqual(["Legacy global", "New learning"]);
    expect(migrated[0]?.cwds).toEqual(["*"]);
    expect(migrated[0]?.promotionEvidence).toMatchObject({
      sourceCwds: [companionCwd],
      excludedCwds: [],
      reasons: ["legacy-source-reconstruction"],
    });
    expect(marker.counts).toMatchObject({
      wildcardRecordsExamined: 1,
      recordsCanonicalized: 1,
      recordsEnriched: 1,
    });
    if (process.platform !== "win32") {
      for (const fileName of [
        "learnings.md",
        ".learning-scope-migration-v1.active.md",
        ".learning-scope-migration-v1.intent.json",
      ]) {
        expect((await lstat(join(memoryDir, fileName))).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("completes when canonical source and replacement bytes are identical", async () => {
    const source = `# Learnings

Automatically captured preferences, corrections, and patterns.

---

<!-- pattern | cwd: * | exposures: 2026-07-20@equal000 -->

### Canonical global

Keep the canonical representation.
`;
    await Bun.write(join(memoryDir, "learnings.md"), source);

    await mutateLearnings(memoryDir, (entries) => entries);

    expect(await Bun.file(join(memoryDir, "learnings.md")).text()).toBe(source);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      true,
    );
  });

  test("rejects duplicate wildcard sentinels in a required target", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- pattern | cwd: *, * | exposures: 2026-07-20@stars000 -->

### Duplicate wildcards

Do not guess how to repair this shape.
`;
    await Bun.write(activePath, source);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "invalid applicability scope",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.intent.json")).exists(),
    ).toBe(false);
  });

  test("reports aggregate migration counts without learning or CWD content", async () => {
    const privateCwd = join(memoryDir, "private-company", "secret-project");
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- pattern | cwd: *, ${privateCwd} | exposures: 2026-07-20@report00 -->

### Confidential title

Confidential body.
`,
    );
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => messages.push(args.join(" "));
    try {
      await mutateLearnings(memoryDir, (entries) => entries);
    } finally {
      console.error = originalError;
    }

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("examined=1");
    expect(messages[0]).toContain("activeMixed=1");
    expect(messages[0]).not.toContain(privateCwd);
    expect(messages[0]).not.toContain("Confidential title");
    expect(messages[0]).not.toContain("Confidential body");
  });

  test("strict archive history preserves mixed companions for active and archive targets", async () => {
    const companionCwd = join(memoryDir, "company-a", "project-2");
    const active = `# Learnings

---

<!-- pattern | cwd: * | exposures: 2026-07-19@active00 -->

### Shared legacy rule

Keep its global applicability.
`;
    const archive = `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-18@archive0 -->

### Shared legacy rule

Keep its global applicability.
`;
    await Bun.write(join(memoryDir, "learnings.md"), active);
    await Bun.write(join(memoryDir, "learnings-archive.md"), archive);

    await mutateLearnings(memoryDir, (entries) => entries);

    const migratedActive = await loadLearnings(memoryDir);
    const migratedArchive = await Bun.file(join(memoryDir, "learnings-archive.md")).text();
    const migratedArchiveEntries = parseLearnings(migratedArchive);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(migratedActive[0]?.promotionEvidence?.sourceCwds).toEqual([companionCwd]);
    expect(migratedArchiveEntries[0]?.promotionEvidence?.sourceCwds).toEqual([companionCwd]);
    expect(migratedArchive).toContain("cwd: * | exposures:");
    expect(migratedArchive).not.toContain(`cwd: *, ${companionCwd}`);
    expect(marker.counts.sourceContributions.archiveMixed).toBe(2);
  });

  test("recovers exact CWD evidence from one unambiguous session-summary join", async () => {
    const date = "2026-07-17";
    const sessionId = "legacy-session-resolved";
    const recoveredCwd = join(memoryDir, "company-a", "project-3");
    await writeSummary(memoryDir, {
      metadata: { date, cwd: recoveredCwd, provider: "test", sessionId },
      tags: [],
      title: "Legacy session",
      body: "Summary body.",
    });
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: ${date}@${hashSessionId(sessionId)} -->

### Reconstructed from exposure

Keep its global applicability.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.cwds).toEqual(["*"]);
    expect(entry?.promotionEvidence?.sourceCwds).toEqual([recoveredCwd]);
    expect(marker.counts).toMatchObject({
      exposureJoinsResolved: 1,
      exposureJoinsMissing: 0,
      exposureJoinsAmbiguous: 0,
      relativeCandidatesDropped: 0,
    });
    expect(marker.counts.sourceContributions.exposure).toBe(1);
  });

  test("treats repeated summary rows with one distinct CWD as an unambiguous join", async () => {
    const date = "2026-07-17";
    const sessionId = "legacy-session-repeated";
    const recoveredCwd = join(memoryDir, "company-a", "project-repeated");
    const summaryPath = await writeSummary(memoryDir, {
      metadata: { date, cwd: recoveredCwd, provider: "test", sessionId },
      tags: [],
      title: "Repeated legacy session",
      body: "Summary body.",
    });
    await Bun.write(
      join(memoryDir, "sessions", "repeated-copy.md"),
      await Bun.file(summaryPath).text(),
    );
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: ${date}@${hashSessionId(sessionId)} -->

### Repeated exposure

Keep its global applicability.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.promotionEvidence?.sourceCwds).toEqual([recoveredCwd]);
    expect(marker.counts.exposureJoinsResolved).toBe(1);
    expect(marker.counts.exposureJoinsAmbiguous).toBe(0);
  });

  test("unions only strict scoped, promotion, and mixed history matches", async () => {
    const scopedCwd = join(memoryDir, "history", "scoped");
    const promotedCwd = join(memoryDir, "history", "promoted");
    const mixedCwd = join(memoryDir, "history", "mixed");
    const rejectedCwd = join(memoryDir, "history", "different-body");
    const identity = {
      category: "fact" as const,
      title: "Strict history identity",
      body: "The body is part of identity.",
    };
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-15@history0 -->

### ${identity.title}

${identity.body}
`,
    );
    await Bun.write(
      join(memoryDir, "learnings.backup.md"),
      renderLearnings([
        makeEntry({ ...identity, cwds: [scopedCwd] }),
        makeEntry({
          ...identity,
          cwds: ["*"],
          promotionEvidence: {
            sourceCwds: [promotedCwd],
            excludedCwds: [],
            exposures: [],
            reasons: ["manual-cross-project-review"],
          },
        }),
        makeEntry({ ...identity, cwds: ["*", mixedCwd] }),
        makeEntry({ ...identity, body: "Different body.", cwds: [rejectedCwd] }),
      ]),
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.promotionEvidence?.sourceCwds).toEqual([mixedCwd, promotedCwd, scopedCwd].sort());
    expect(entry?.promotionEvidence?.sourceCwds).not.toContain(rejectedCwd);
    expect(marker.counts.sourceContributions).toMatchObject({
      backupPromotion: 1,
      backupScoped: 1,
      backupMixed: 1,
    });
  });

  test("ambiguous session-summary joins add no source evidence", async () => {
    const date = "2026-07-16";
    const sessionId = "legacy-session-ambiguous";
    const firstPath = await writeSummary(memoryDir, {
      metadata: {
        date,
        cwd: join(memoryDir, "company-a", "project-1"),
        provider: "test",
        sessionId,
      },
      tags: [],
      title: "First summary",
      body: "Summary body.",
    });
    const firstText = await Bun.file(firstPath).text();
    await writeSummary(memoryDir, {
      metadata: {
        date,
        cwd: join(memoryDir, "company-b", "project-1"),
        provider: "test",
        sessionId,
      },
      tags: [],
      title: "Second summary",
      body: "Summary body.",
    });
    await Bun.write(join(memoryDir, "sessions", "duplicate-summary.md"), firstText);
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: ${date}@${hashSessionId(sessionId)} -->

### Ambiguous exposure

Keep its global applicability.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.promotionEvidence).toBeUndefined();
    expect(marker.counts).toMatchObject({
      exposureJoinsResolved: 0,
      exposureJoinsMissing: 0,
      exposureJoinsAmbiguous: 1,
      recordsUnchanged: 1,
    });
  });

  test("drops a resolved relative summary CWD without blocking migration", async () => {
    const date = "2026-07-15";
    const sessionId = "legacy-session-relative";
    await writeSummary(memoryDir, {
      metadata: { date, cwd: "relative/project", provider: "test", sessionId },
      tags: [],
      title: "Relative summary",
      body: "Summary body.",
    });
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: ${date}@${hashSessionId(sessionId)} -->

### Relative exposure

Keep its global applicability.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.promotionEvidence).toBeUndefined();
    expect(marker.counts).toMatchObject({
      exposureJoinsResolved: 1,
      relativeCandidatesDropped: 1,
      recordsUnchanged: 1,
    });
  });

  test("blocks a relative mixed companion before publishing migration artifacts", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- fact | cwd: *, relative/project | exposures: 2026-07-14@relative -->

### Invalid persisted companion

Keep its global applicability.
`;
    await Bun.write(activePath, source);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "invalid applicability scope",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.active.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.intent.json")).exists(),
    ).toBe(false);
  });

  test("ignores an entire optional history file containing a relative companion", async () => {
    const historicalCwd = join(memoryDir, "company-a", "historical-project");
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-13@missing0 -->

### Optional history target

Keep its global applicability.
`,
    );
    await Bun.write(
      join(memoryDir, "learnings.backup.md"),
      `# Learnings

---

<!-- fact | cwd: ${historicalCwd} | exposures: 2026-07-12@history0 -->

### Optional history target

Keep its global applicability.

---

<!-- pattern | cwd: *, relative/project | exposures: 2026-07-12@invalid0 -->

### Invalid optional record

Body.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.promotionEvidence).toBeUndefined();
    expect(marker.counts.optionalHistoryFailures).toBe(1);
    expect(marker.counts.sourceContributions.backupScoped).toBe(0);
  });

  test("replays the same prepared intent after a crash at intent publication", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const companionCwd = join(memoryDir, "company-a", "project-4");
    const source = `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-12@crash000 -->

### Crash-safe migration

Body.
`;
    await Bun.write(activePath, source);

    await expect(
      withLearningsLock(memoryDir, () =>
        ensureLegacyScopeMigratedUnderLock(memoryDir, {
          afterCheckpoint: (checkpoint) => {
            if (checkpoint === "intent-published") throw new Error("synthetic crash");
          },
        }),
      ),
    ).rejects.toThrow("synthetic crash");

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.intent.json")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    expect(entry?.cwds).toEqual(["*"]);
    expect(entry?.promotionEvidence?.sourceCwds).toEqual([companionCwd]);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      true,
    );
  });

  test("blocks an incomplete intent whose required source backup is missing", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const backupPath = join(memoryDir, ".learning-scope-migration-v1.active.md");
    const source = `# Learnings

---

<!-- pattern | cwd: * | exposures: 2026-07-12@crash001 -->

### Missing recovery backup

Body.
`;
    await Bun.write(activePath, source);
    await expect(
      withLearningsLock(memoryDir, () =>
        ensureLegacyScopeMigratedUnderLock(memoryDir, {
          afterCheckpoint: (checkpoint) => {
            if (checkpoint === "intent-published") throw new Error("synthetic crash");
          },
        }),
      ),
    ).rejects.toThrow("synthetic crash");
    await rm(backupPath);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "backup is missing or damaged",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );
  });

  test("blocks a malformed prepared intent without changing a target", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- pattern | cwd: * | exposures: 2026-07-12@crash002 -->

### Malformed intent target

Body.
`;
    await Bun.write(activePath, source);
    await Bun.write(join(memoryDir, ".learning-scope-migration-v1.intent.json"), "not-json");

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "intent is malformed",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );
  });

  test("blocks a self-consistent intent with invalid replacement grammar", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const intentPath = join(memoryDir, ".learning-scope-migration-v1.intent.json");
    const source = `# Learnings

---

<!-- pattern | cwd: * | exposures: 2026-07-12@crash003 -->

### Invalid replacement replay

Body.
`;
    await Bun.write(activePath, source);
    await expect(
      withLearningsLock(memoryDir, () =>
        ensureLegacyScopeMigratedUnderLock(memoryDir, {
          afterCheckpoint: (checkpoint) => {
            if (checkpoint === "intent-published") throw new Error("synthetic crash");
          },
        }),
      ),
    ).rejects.toThrow("synthetic crash");

    const intent = await Bun.file(intentPath).json();
    const invalidReplacement = "# Learnings\n\nthis is not a learning record\n";
    intent.targets.active.replacement.text = invalidReplacement;
    intent.targets.active.replacement.sha256 = new Bun.CryptoHasher("sha256")
      .update(invalidReplacement)
      .digest("hex");
    await Bun.write(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "invalid replacement",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );
  });

  test("finishes active replacement after a crash following archive replacement", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const activeCwd = join(memoryDir, "active-project");
    const archiveCwd = join(memoryDir, "archive-project");
    const activeSource = `# Learnings

---

<!-- pattern | cwd: *, ${activeCwd} | exposures: 2026-07-11@active00 -->

### Active crash target

Body.
`;
    const archiveSource = `# Learnings

---

<!-- pattern | cwd: *, ${archiveCwd} | exposures: 2026-07-10@archive0 -->

### Archive crash target

Body.
`;
    await Bun.write(activePath, activeSource);
    await Bun.write(archivePath, archiveSource);

    await expect(
      withLearningsLock(memoryDir, () =>
        ensureLegacyScopeMigratedUnderLock(memoryDir, {
          afterCheckpoint: (checkpoint) => {
            if (checkpoint === "archive-replaced") throw new Error("synthetic archive crash");
          },
        }),
      ),
    ).rejects.toThrow("synthetic archive crash");

    expect(await Bun.file(activePath).text()).toBe(activeSource);
    expect(await Bun.file(archivePath).text()).not.toBe(archiveSource);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    expect((await loadLearnings(memoryDir))[0]?.promotionEvidence?.sourceCwds).toEqual([activeCwd]);
    const archiveEntries = parseLearnings(await Bun.file(archivePath).text());
    expect(archiveEntries[0]?.promotionEvidence?.sourceCwds).toEqual([archiveCwd]);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      true,
    );
  });

  test("blocks replay without overwriting a target in a third state", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-09@source00 -->

### Original target

Body.
`;
    const unrelated = `# Learnings

---

<!-- fact | cwd: ${join(memoryDir, "unrelated")} | exposures: 2026-07-09@other000 -->

### Out-of-band replacement

Body.
`;
    await Bun.write(activePath, source);
    await expect(
      withLearningsLock(memoryDir, () =>
        ensureLegacyScopeMigratedUnderLock(memoryDir, {
          afterCheckpoint: (checkpoint) => {
            if (checkpoint === "intent-published") throw new Error("synthetic crash");
          },
        }),
      ),
    ).rejects.toThrow("synthetic crash");
    await Bun.write(activePath, unrelated);

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow("third state");

    expect(await Bun.file(activePath).text()).toBe(unrelated);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );
  });

  test("never overwrites a pre-existing mismatched source backup", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const backupPath = join(memoryDir, ".learning-scope-migration-v1.active.md");
    const source = `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-08@source00 -->

### Backup target

Body.
`;
    await Bun.write(activePath, source);
    await Bun.write(backupPath, "unrelated backup bytes");

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "does not match current source",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
    expect(await Bun.file(backupPath).text()).toBe("unrelated backup bytes");
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.intent.json")).exists(),
    ).toBe(false);
  });

  test("accepts a matching partial backup-only state and completes preparation", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const backupPath = join(memoryDir, ".learning-scope-migration-v1.active.md");
    const source = `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-08@partial0 -->

### Partial backup target

Body.
`;
    await Bun.write(activePath, source);
    await Bun.write(backupPath, source);

    await mutateLearnings(memoryDir, (entries) => entries);

    expect(await Bun.file(backupPath).text()).toBe(source);
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.intent.json")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      true,
    );
  });

  test("normalizes a legacy global nonglobal flag and records its counter", async () => {
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-08@nonglob0 | nonglobal -->

### Contradictory legacy flags

Body.
`,
    );

    await mutateLearnings(memoryDir, (entries) => entries);

    const [entry] = await loadLearnings(memoryDir);
    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(entry?.cwds).toEqual(["*"]);
    expect(entry?.nonglobal).toBe(false);
    expect(marker.counts.globalNonglobalNormalized).toBe(1);
    expect(marker.counts.recordsCanonicalized).toBe(1);
  });

  test("serializes concurrent migration and keeps artifacts byte-identical on rerun", async () => {
    const companionCwd = join(memoryDir, "company-a", "concurrent-project");
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-08@concur00 -->

### Concurrent legacy target

Body.
`,
    );

    await Promise.all([
      mutateLearnings(memoryDir, (entries) => [
        ...entries,
        makeEntry({ title: "First concurrent addition" }),
      ]),
      mutateLearnings(memoryDir, (entries) => [
        ...entries,
        makeEntry({ title: "Second concurrent addition" }),
      ]),
    ]);
    const artifactPaths = [
      "learnings.md",
      ".learning-scope-migration-v1.active.md",
      ".learning-scope-migration-v1.intent.json",
      ".learning-scope-migration-v1.json",
    ].map((fileName) => join(memoryDir, fileName));
    const before = await Promise.all(artifactPaths.map((filePath) => Bun.file(filePath).text()));

    await mutateLearnings(memoryDir, (entries) => entries);

    const after = await Promise.all(artifactPaths.map((filePath) => Bun.file(filePath).text()));
    expect(after).toEqual(before);
    const entries = await loadLearnings(memoryDir);
    expect(entries[0]?.title).toBe("Concurrent legacy target");
    expect(
      entries
        .slice(1)
        .map((entry) => entry.title)
        .sort(),
    ).toEqual(["First concurrent addition", "Second concurrent addition"]);
    expect(entries[0]?.promotionEvidence?.sourceCwds).toEqual([companionCwd]);
  });

  test("preserves absent migration targets and creates no source backup for them", async () => {
    await mutateLearnings(memoryDir, () => [makeEntry({ title: "First learning" })]);

    const marker = await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).json();
    expect(marker.expectedBackups).toEqual({ active: false, archive: false });
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.active.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(memoryDir, ".learning-scope-migration-v1.archive.md")).exists(),
    ).toBe(false);
    expect((await loadLearnings(memoryDir)).map((entry) => entry.title)).toEqual([
      "First learning",
    ]);
  });

  test("blocks readiness when the completion marker is malformed", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- fact | cwd: ${join(memoryDir, "project")} | exposures: 2026-07-07@valid000 -->

### Valid learning

Body.
`;
    await Bun.write(activePath, source);
    await Bun.write(join(memoryDir, ".learning-scope-migration-v1.json"), "not-json");

    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "marker is malformed",
    );

    expect(await Bun.file(activePath).text()).toBe(source);
  });

  test("allows strict mutations after completion when recovery artifacts are missing", async () => {
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-06@global00 -->

### Canonical global

Body.
`,
    );
    await mutateLearnings(memoryDir, (entries) => entries);
    await rm(join(memoryDir, ".learning-scope-migration-v1.intent.json"), { force: true });
    await rm(join(memoryDir, ".learning-scope-migration-v1.active.md"), { force: true });

    await mutateLearnings(memoryDir, (entries) => [
      ...entries,
      makeEntry({ title: "Mutation after artifact loss" }),
    ]);

    expect((await loadLearnings(memoryDir)).map((entry) => entry.title)).toEqual([
      "Canonical global",
      "Mutation after artifact loss",
    ]);
  });

  test("archive corruption after completion does not block an active-only mutation", async () => {
    await writeLearnings(memoryDir, [makeEntry({ title: "Active entry" })]);
    await appendToArchive(memoryDir, [makeEntry({ title: "Archived entry" })]);
    const archivePath = join(memoryDir, "learnings-archive.md");
    await Bun.write(
      archivePath,
      `# Learnings

---

<!-- fact | cwd: *, ${join(memoryDir, "legacy")} | exposures: 2026-07-05@mixed000 -->

### Reintroduced mixed archive

Body.
`,
    );

    await mutateLearnings(memoryDir, (entries) => [
      ...entries,
      makeEntry({ title: "Active mutation still allowed" }),
    ]);

    expect((await loadLearnings(memoryDir)).map((entry) => entry.title)).toContain(
      "Active mutation still allowed",
    );
    await expect(
      appendToArchive(memoryDir, [makeEntry({ title: "Blocked archive append" })]),
    ).rejects.toThrow("invalid applicability scope");
  });

  test("active corruption after completion does not block an archive-only append", async () => {
    await writeLearnings(memoryDir, [makeEntry({ title: "Active entry" })]);
    await appendToArchive(memoryDir, [makeEntry({ title: "Initial archive" })]);
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- fact | cwd: *, ${join(memoryDir, "legacy")} | exposures: 2026-07-04@mixed000 -->

### Reintroduced mixed active

Body.
`,
    );

    await appendToArchive(memoryDir, [makeEntry({ title: "Archive append still allowed" })]);

    expect(await Bun.file(join(memoryDir, "learnings-archive.md")).text()).toContain(
      "### Archive append still allowed",
    );
    await expect(mutateLearnings(memoryDir, (entries) => entries)).rejects.toThrow(
      "invalid applicability scope",
    );
  });

  test("rejects eager invalid replacement before publishing migration artifacts", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const source = `# Learnings

---

<!-- fact | cwd: * | exposures: 2026-07-03@global00 -->

### Existing global

Body.
`;
    await Bun.write(activePath, source);

    await expect(
      writeLearnings(memoryDir, [makeEntry({ title: "Invalid replacement", exposures: [] })]),
    ).rejects.toThrow("invalid learning storage");

    expect(await Bun.file(activePath).text()).toBe(source);
    for (const fileName of [
      ".learning-scope-migration-v1.json",
      ".learning-scope-migration-v1.intent.json",
      ".learning-scope-migration-v1.active.md",
    ]) {
      expect(await Bun.file(join(memoryDir, fileName)).exists()).toBe(false);
    }
  });
});
