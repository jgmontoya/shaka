import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLearningStorage } from "../../../src/memory/learning-inspection";
import { type LearningEntry, renderLearnings } from "../../../src/memory/learnings";
import { testCwd, testCwds } from "../../helpers/memory-path";

const MIGRATION_FILES = {
  marker: ".learning-scope-migration-v1.json",
  intent: ".learning-scope-migration-v1.intent.json",
  activeBackup: ".learning-scope-migration-v1.active.md",
  archiveBackup: ".learning-scope-migration-v1.archive.md",
} as const;

const CONDENSATION_INTENT_FILE = ".learning-condensation-v1.intent.json";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function emptyCounts() {
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

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalLearning(): string {
  return renderLearnings([learningEntry("Canonical learning", "valid000")]);
}

function learningEntry(title: string, sessionHash: string): LearningEntry {
  return {
    category: "pattern",
    cwds: testCwds("/work/project"),
    exposures: [{ date: "2026-07-20", sessionHash }],
    nonglobal: false,
    title,
    body: `${title} body.`,
  };
}

async function snapshotFiles(memoryDir: string): Promise<Record<string, string>> {
  const names = (await readdir(memoryDir)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await Bun.file(join(memoryDir, name)).text()] as const),
    ),
  );
}

describe("inspectLearningStorage", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "shaka-learning-inspection-"));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  test("accepts an unstarted legacy mixed-wildcard store without writing", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const companionCwd = join(memoryDir, "company", "project");
    await Bun.write(
      activePath,
      `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-20@legacy00 -->

### Legacy global

Keep its global applicability.
`,
    );
    const before = await snapshotFiles(memoryDir);

    expect(await inspectLearningStorage(memoryDir)).toEqual([]);
    expect(await snapshotFiles(memoryDir)).toEqual(before);
  });

  test("reports malformed exclusion evidence with its file and learning title", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const promotion = JSON.stringify({
      sourceCwds: testCwds("/work/company/project"),
      excludedCwds: testCwds("/work/company/legacy"),
      exposures: [],
      reasons: ["manual-scope-correction"],
    });
    await Bun.write(
      activePath,
      `# Learnings

---

<!-- correction | cwd: ${testCwd("/work/company")} | exposures: 2026-02-09@aaaa0000 -->
<!-- promotion: ${promotion} -->

### Invalid corrected scope

Body.
`,
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope",
      severity: "error",
      filePath: activePath,
      title: "Invalid corrected scope",
      message:
        'Learning "Invalid corrected scope" has an invalid applicability scope. An active learning scope cannot be related to an excluded CWD.',
    });
  });

  test("reports a recoverable prepared migration as a non-failing warning without writing", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const companionCwd = join(memoryDir, "company", "project");
    const source = `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-20@legacy00 -->

### Legacy global

Keep its global applicability.
`;
    const replacement = renderLearnings([
      {
        category: "pattern",
        cwds: ["*"],
        exposures: [{ date: "2026-07-20", sessionHash: "legacy00" }],
        nonglobal: false,
        title: "Legacy global",
        body: "Keep its global applicability.",
        promotionEvidence: {
          sourceCwds: [companionCwd],
          excludedCwds: [],
          exposures: [],
          reasons: ["legacy-source-reconstruction"],
        },
      },
    ]);
    await Bun.write(activePath, source);
    await Bun.write(backupPath, source);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: { exists: true, sha256: sha256(replacement), text: replacement },
          },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
      }),
    );
    const before = await snapshotFiles(memoryDir);

    const diagnostics = await inspectLearningStorage(memoryDir);

    expect(diagnostics).toEqual([
      {
        code: "learning-scope-migration-incomplete",
        severity: "warning",
        filePath: intentPath,
        message: "Learning scope migration is incomplete; the next mutation will resume it.",
      },
    ]);
    expect(await snapshotFiles(memoryDir)).toEqual(before);
  });

  test("treats a malformed completion marker as a blocking error", async () => {
    const markerPath = join(memoryDir, MIGRATION_FILES.marker);
    await Bun.write(markerPath, "{not-json}\n");

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-marker",
      severity: "error",
      filePath: markerPath,
      message: `Migration marker is malformed: ${markerPath}`,
    });
  });

  test("treats an unsupported completion marker version as a blocking error", async () => {
    const markerPath = join(memoryDir, MIGRATION_FILES.marker);
    await Bun.write(
      markerPath,
      jsonText({
        version: 2,
        intentSha256: sha256("intent"),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-marker",
      severity: "error",
      filePath: markerPath,
      message: `Migration marker has an invalid schema: ${markerPath}`,
    });
  });

  test("reports missing completed-state recovery artifacts as warnings", async () => {
    const markerPath = join(memoryDir, MIGRATION_FILES.marker);
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    await Bun.write(join(memoryDir, "learnings.md"), canonicalLearning());
    await Bun.write(
      markerPath,
      jsonText({
        version: 1,
        intentSha256: sha256("missing intent bytes"),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: true, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: intentPath,
        message:
          "Completed learning scope migration intent is missing; recovery options are reduced.",
      },
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: backupPath,
        message:
          "Expected completed learning scope migration backup is missing; recovery options are reduced.",
      },
    ]);
  });

  test("reports a damaged completed-state backup as a warning", async () => {
    const source = canonicalLearning();
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const markerPath = join(memoryDir, MIGRATION_FILES.marker);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const intentText = jsonText({
      version: 1,
      targets: {
        active: {
          source: { exists: true, sha256: sha256(source) },
          replacement: { exists: true, sha256: sha256(source), text: source },
        },
        archive: { source: { exists: false }, replacement: { exists: false } },
      },
      counts: emptyCounts(),
    });
    await Bun.write(join(memoryDir, "learnings.md"), source);
    await Bun.write(intentPath, intentText);
    await Bun.write(backupPath, "damaged backup\n");
    await Bun.write(
      markerPath,
      jsonText({
        version: 1,
        intentSha256: sha256(intentText),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: true, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: backupPath,
        message:
          "Completed learning scope migration backup does not match its source; recovery options are reduced.",
      },
    ]);
  });

  test("reports a completed intent hash mismatch as a recovery warning", async () => {
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const intentText = jsonText({
      version: 1,
      targets: {
        active: { source: { exists: false }, replacement: { exists: false } },
        archive: { source: { exists: false }, replacement: { exists: false } },
      },
      counts: emptyCounts(),
    });
    await Bun.write(intentPath, intentText);
    await Bun.write(
      join(memoryDir, MIGRATION_FILES.marker),
      jsonText({
        version: 1,
        intentSha256: sha256("different intent bytes"),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: intentPath,
        message:
          "Completed learning scope migration intent does not match its marker; recovery options are reduced.",
      },
    ]);
  });

  test("reports completed marker counts that disagree with the bound intent", async () => {
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const intentText = jsonText({
      version: 1,
      targets: {
        active: { source: { exists: false }, replacement: { exists: false } },
        archive: { source: { exists: false }, replacement: { exists: false } },
      },
      counts: emptyCounts(),
    });
    await Bun.write(intentPath, intentText);
    await Bun.write(
      join(memoryDir, MIGRATION_FILES.marker),
      jsonText({
        version: 1,
        intentSha256: sha256(intentText),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: { ...emptyCounts(), recordsUnchanged: 1 },
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: intentPath,
        message:
          "Completed learning scope migration intent disagrees with its marker; recovery options are reduced.",
      },
    ]);
  });

  test("reports an unexpected completed-state backup as a warning", async () => {
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const intentText = jsonText({
      version: 1,
      targets: {
        active: { source: { exists: false }, replacement: { exists: false } },
        archive: { source: { exists: false }, replacement: { exists: false } },
      },
      counts: emptyCounts(),
    });
    await Bun.write(intentPath, intentText);
    await Bun.write(backupPath, "unexpected backup\n");
    await Bun.write(
      join(memoryDir, MIGRATION_FILES.marker),
      jsonText({
        version: 1,
        intentSha256: sha256(intentText),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-recovery",
        severity: "warning",
        filePath: backupPath,
        message:
          "Unexpected completed learning scope migration backup exists; recovery artifacts are inconsistent.",
      },
    ]);
  });

  test("keeps invalid current targets as errors after migration completion", async () => {
    const activePath = join(memoryDir, "learnings.md");
    await Bun.write(
      activePath,
      `# Learnings

---

<!-- pattern | cwd: *, /work/project | exposures: 2026-07-20@invalid0 -->

### Reintroduced legacy shape

This target is no longer canonical.
`,
    );
    await Bun.write(
      join(memoryDir, MIGRATION_FILES.marker),
      jsonText({
        version: 1,
        intentSha256: sha256("missing intent bytes"),
        completedAt: "2026-07-21T12:00:00.000Z",
        expectedBackups: { active: false, archive: false },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope",
      severity: "error",
      filePath: activePath,
      title: "Reintroduced legacy shape",
      message:
        'Learning "Reintroduced legacy shape" has an invalid applicability scope. Global scope must be represented only as ["*"].',
    });
  });

  test("reports a matching partial backup-only state as recoverable", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const companionCwd = join(memoryDir, "company", "project");
    const source = `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-20@backup00 -->

### Backup-only legacy global

Keep its global applicability.
`;
    await Bun.write(activePath, source);
    await Bun.write(backupPath, source);

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-scope-migration-incomplete",
        severity: "warning",
        filePath: backupPath,
        message:
          "Learning scope migration preparation is incomplete; the next mutation will resume it.",
      },
    ]);
  });

  test("treats a missing prepared-state backup as a blocking error", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const source = canonicalLearning();
    await Bun.write(activePath, source);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: { exists: true, sha256: sha256(source), text: source },
          },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-backup",
      severity: "error",
      filePath: backupPath,
      message: "Required learning scope migration backup is missing.",
    });
  });

  test("treats malformed prepared intent as a blocking error", async () => {
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    await Bun.write(intentPath, "{not-json}\n");

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-intent",
      severity: "error",
      filePath: intentPath,
      message: `Migration intent is malformed: ${intentPath}`,
    });
  });

  test("rejects a parseable but noncanonical prepared replacement", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const source = canonicalLearning();
    const noncanonicalReplacement = `${source}\n`;
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: {
              exists: true,
              sha256: sha256(noncanonicalReplacement),
              text: noncanonicalReplacement,
            },
          },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-intent",
      severity: "error",
      filePath: intentPath,
      message: `Migration intent contains an invalid replacement: ${activePath}`,
    });
  });

  test("rejects unknown prepared-intent keys through the closed schema", async () => {
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: { source: { exists: false }, replacement: { exists: false } },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
        unexpected: true,
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-intent",
      severity: "error",
      filePath: intentPath,
      message: `Migration intent has an invalid schema: ${intentPath}`,
    });
  });

  test("treats a prepared target in a third state as a blocking error", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const source = canonicalLearning();
    const unrelated = source.replace("Canonical learning", "Unrelated learning");
    await Bun.write(activePath, unrelated);
    await Bun.write(backupPath, source);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: { exists: true, sha256: sha256(source), text: source },
          },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-target",
      severity: "error",
      filePath: activePath,
      message: "Learning scope migration target is in an unexpected third state.",
    });
  });

  test("treats a prepared backup/source mismatch as a blocking error", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const intentPath = join(memoryDir, MIGRATION_FILES.intent);
    const backupPath = join(memoryDir, MIGRATION_FILES.activeBackup);
    const source = canonicalLearning();
    await Bun.write(activePath, source);
    await Bun.write(backupPath, "unrelated backup\n");
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: { exists: true, sha256: sha256(source), text: source },
          },
          archive: { source: { exists: false }, replacement: { exists: false } },
        },
        counts: emptyCounts(),
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-scope-migration-backup",
      severity: "error",
      filePath: backupPath,
      message: "Learning scope migration backup does not match the prepared source.",
    });
  });

  test("treats a malformed condensation intent as a blocking error", async () => {
    const intentPath = join(memoryDir, CONDENSATION_INTENT_FILE);
    await Bun.write(intentPath, "{not-json}\n");

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-condensation-intent",
      severity: "error",
      filePath: intentPath,
      message: `Condensation intent is malformed: ${intentPath}`,
    });
  });

  test("reports a recoverable condensation commit as a read-only warning", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_INTENT_FILE);
    const sourceOne = learningEntry("Source one", "source01");
    const sourceTwo = learningEntry("Source two", "source02");
    const existingArchive = learningEntry("Existing archive", "archive0");
    const compound = learningEntry("Compound", "compound");
    const activeSource = renderLearnings([sourceOne, sourceTwo]);
    const activeReplacement = renderLearnings([compound]);
    const archiveSource = renderLearnings([existingArchive]);
    const archiveReplacement = renderLearnings([existingArchive, sourceOne, sourceTwo]);
    await Bun.write(activePath, activeSource);
    await Bun.write(archivePath, archiveReplacement);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(activeSource) },
            replacement: {
              exists: true,
              sha256: sha256(activeReplacement),
              text: activeReplacement,
            },
          },
          archive: {
            source: { exists: true, sha256: sha256(archiveSource) },
            replacement: {
              exists: true,
              sha256: sha256(archiveReplacement),
              text: archiveReplacement,
            },
          },
        },
      }),
    );
    const before = await snapshotFiles(memoryDir);

    expect(await inspectLearningStorage(memoryDir)).toEqual([
      {
        code: "learning-condensation-incomplete",
        severity: "warning",
        filePath: intentPath,
        message: "Learning condensation commit is incomplete; the next mutation will resume it.",
      },
    ]);
    expect(await snapshotFiles(memoryDir)).toEqual(before);
  });

  test("treats a third-state condensation target as a blocking error", async () => {
    const activePath = join(memoryDir, "learnings.md");
    const archivePath = join(memoryDir, "learnings-archive.md");
    const intentPath = join(memoryDir, CONDENSATION_INTENT_FILE);
    const source = renderLearnings([learningEntry("Source", "source03")]);
    const replacement = renderLearnings([learningEntry("Compound", "compound")]);
    const unrelated = renderLearnings([learningEntry("Unrelated", "other000")]);
    const existingArchive = learningEntry("Existing archive", "archive1");
    const archive = renderLearnings([existingArchive]);
    const archiveReplacement = renderLearnings([
      existingArchive,
      learningEntry("Archived source", "source03"),
    ]);
    await Bun.write(activePath, unrelated);
    await Bun.write(archivePath, archive);
    await Bun.write(
      intentPath,
      jsonText({
        version: 1,
        targets: {
          active: {
            source: { exists: true, sha256: sha256(source) },
            replacement: {
              exists: true,
              sha256: sha256(replacement),
              text: replacement,
            },
          },
          archive: {
            source: { exists: true, sha256: sha256(archive) },
            replacement: {
              exists: true,
              sha256: sha256(archiveReplacement),
              text: archiveReplacement,
            },
          },
        },
      }),
    );

    expect(await inspectLearningStorage(memoryDir)).toContainEqual({
      code: "invalid-learning-condensation-target",
      severity: "error",
      filePath: activePath,
      message: "Condensation target is in an unexpected third state.",
    });
  });
});
