/** Read-only integrity inspection for active and archived learnings storage. */

import { join } from "node:path";
import {
  CONDENSATION_COMMIT_FILE,
  CondensationCommitError,
  type CondensationCommitIntentV1,
  type CondensationTargetIntent,
  classifyCondensationCommitTarget,
  parseCondensationCommitIntent,
} from "./condensation-commit";
import { inspectLearningFileStatus } from "./learning-file";
import {
  ARCHIVE_FILE,
  LEARNINGS_FILE,
  type LearningDiagnosticCode,
  parseLearningsDocument,
  parseLegacyScopeMigrationDocument,
} from "./learnings";
import {
  LEARNING_SCOPE_MIGRATION_FILES,
  LearningScopeMigrationError,
  type LearningScopeMigrationIntentV1,
  type LearningScopeMigrationMarkerV1,
  MIGRATION_EVIDENCE_SOURCES,
  classifyLearningScopeMigrationTarget,
  hashLearningScopeMigrationText,
  parseLearningScopeMigrationIntent,
  parseLearningScopeMigrationMarker,
  validateLearningScopeMigrationReplacement,
} from "./legacy-scope-migration";

export type LearningStorageDiagnosticCode =
  | LearningDiagnosticCode
  | "unreadable-learning-file"
  | "invalid-learning-scope-migration-marker"
  | "invalid-learning-scope-migration-intent"
  | "invalid-learning-scope-migration-backup"
  | "invalid-learning-scope-migration-target"
  | "learning-scope-migration-incomplete"
  | "learning-scope-migration-recovery"
  | "invalid-learning-condensation-intent"
  | "invalid-learning-condensation-target"
  | "learning-condensation-incomplete";

export interface LearningStorageDiagnostic {
  readonly code: LearningStorageDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly filePath: string;
  readonly title?: string;
  readonly message: string;
}

type InspectedTextFile =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "regular"; readonly text: string };

interface MigrationInspection {
  readonly diagnostics: readonly LearningStorageDiagnostic[];
  readonly targetMode: "handled" | "legacy" | "strict";
}

interface PreparedTargetSpec {
  readonly targetPath: string;
  readonly backupPath: string;
  readonly intent: LearningScopeMigrationIntentV1["targets"]["active"];
}

function unreadableFileDiagnostic(filePath: string, message: string): LearningStorageDiagnostic[] {
  return [
    {
      code: "unreadable-learning-file",
      severity: "error",
      filePath,
      message,
    },
  ];
}

async function inspectLearningFile(
  filePath: string,
  mode: "legacy" | "strict",
): Promise<LearningStorageDiagnostic[]> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind === "missing") return [];
  if (status.kind === "invalid") return unreadableFileDiagnostic(filePath, status.message);

  const content = await Bun.file(filePath)
    .text()
    .catch(() => null);
  if (content === null) {
    return unreadableFileDiagnostic(filePath, "Learning storage file could not be read.");
  }
  const parsed =
    mode === "legacy"
      ? parseLegacyScopeMigrationDocument(content)
      : parseLearningsDocument(content);
  return parsed.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error",
    filePath,
  }));
}

async function inspectTextFile(filePath: string): Promise<InspectedTextFile> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind !== "regular") return status;
  try {
    return { kind: "regular", text: await Bun.file(filePath).text() };
  } catch {
    return { kind: "invalid", message: "Learning storage file could not be read." };
  }
}

function migrationDiagnostic(
  code: LearningStorageDiagnosticCode,
  severity: "error" | "warning",
  filePath: string,
  message: string,
): LearningStorageDiagnostic {
  return { code, severity, filePath, message };
}

async function inspectCondensationTarget(
  targetPath: string,
  target: CondensationTargetIntent,
): Promise<LearningStorageDiagnostic[]> {
  const current = await inspectTextFile(targetPath);
  const state =
    current.kind === "invalid"
      ? "third"
      : classifyCondensationCommitTarget(
          current.kind === "regular" ? current.text : undefined,
          target,
        );
  return state === "third"
    ? [
        migrationDiagnostic(
          "invalid-learning-condensation-target",
          "error",
          targetPath,
          "Condensation target is in an unexpected third state.",
        ),
      ]
    : [];
}

async function inspectCondensationCommit(memoryDir: string): Promise<LearningStorageDiagnostic[]> {
  const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
  const inspectedIntent = await inspectTextFile(intentPath);
  if (inspectedIntent.kind === "missing") return [];
  if (inspectedIntent.kind === "invalid") {
    return [
      migrationDiagnostic(
        "invalid-learning-condensation-intent",
        "error",
        intentPath,
        inspectedIntent.message,
      ),
    ];
  }

  let intent: CondensationCommitIntentV1;
  try {
    intent = parseCondensationCommitIntent(inspectedIntent.text, intentPath);
  } catch (error) {
    return [
      migrationDiagnostic(
        "invalid-learning-condensation-intent",
        "error",
        intentPath,
        error instanceof CondensationCommitError
          ? error.message
          : `Condensation intent could not be inspected: ${intentPath}`,
      ),
    ];
  }

  const targetDiagnostics = (
    await Promise.all([
      inspectCondensationTarget(join(memoryDir, LEARNINGS_FILE), intent.targets.active),
      inspectCondensationTarget(join(memoryDir, ARCHIVE_FILE), intent.targets.archive),
    ])
  ).flat();
  if (targetDiagnostics.length > 0) return targetDiagnostics;

  return [
    migrationDiagnostic(
      "learning-condensation-incomplete",
      "warning",
      intentPath,
      "Learning condensation commit is incomplete; the next mutation will resume it.",
    ),
  ];
}

function validateIntentReplacements(
  memoryDir: string,
  intent: LearningScopeMigrationIntentV1,
): void {
  validateLearningScopeMigrationReplacement(join(memoryDir, LEARNINGS_FILE), intent.targets.active);
  validateLearningScopeMigrationReplacement(join(memoryDir, ARCHIVE_FILE), intent.targets.archive);
}

function parsePreparedIntent(
  memoryDir: string,
  intentText: string,
  intentPath: string,
):
  | { readonly ok: true; readonly intent: LearningScopeMigrationIntentV1 }
  | { readonly ok: false; readonly diagnostics: readonly LearningStorageDiagnostic[] } {
  try {
    const intent = parseLearningScopeMigrationIntent(intentText, intentPath);
    validateIntentReplacements(memoryDir, intent);
    return { ok: true, intent };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        migrationDiagnostic(
          "invalid-learning-scope-migration-intent",
          "error",
          intentPath,
          error instanceof LearningScopeMigrationError
            ? error.message
            : `Migration intent could not be inspected: ${intentPath}`,
        ),
      ],
    };
  }
}

function inspectPreparedBackup(
  spec: PreparedTargetSpec,
  backup: InspectedTextFile,
): LearningStorageDiagnostic | undefined {
  if (!spec.intent.source.exists) {
    return backup.kind === "missing"
      ? undefined
      : migrationDiagnostic(
          "invalid-learning-scope-migration-backup",
          "error",
          spec.backupPath,
          "Unexpected learning scope migration backup exists for an absent source.",
        );
  }
  if (
    backup.kind === "regular" &&
    hashLearningScopeMigrationText(backup.text) === spec.intent.source.sha256
  ) {
    return undefined;
  }
  return migrationDiagnostic(
    "invalid-learning-scope-migration-backup",
    "error",
    spec.backupPath,
    backup.kind === "missing"
      ? "Required learning scope migration backup is missing."
      : "Learning scope migration backup does not match the prepared source.",
  );
}

function inspectPreparedTarget(
  spec: PreparedTargetSpec,
  target: InspectedTextFile,
): LearningStorageDiagnostic[] {
  const targetText = target.kind === "regular" ? target.text : undefined;
  const state = classifyLearningScopeMigrationTarget(targetText, spec.intent);
  if (target.kind === "invalid" || state === "third") {
    return [
      migrationDiagnostic(
        "invalid-learning-scope-migration-target",
        "error",
        spec.targetPath,
        "Learning scope migration target is in an unexpected third state.",
      ),
    ];
  }
  if (target.kind !== "regular") return [];
  const parsed =
    state === "source"
      ? parseLegacyScopeMigrationDocument(target.text)
      : parseLearningsDocument(target.text);
  return parsed.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error" as const,
    filePath: spec.targetPath,
  }));
}

async function inspectPreparedTargetSpec(
  spec: PreparedTargetSpec,
): Promise<LearningStorageDiagnostic[]> {
  const [target, backup] = await Promise.all([
    inspectTextFile(spec.targetPath),
    inspectTextFile(spec.backupPath),
  ]);
  const backupDiagnostic = inspectPreparedBackup(spec, backup);
  return [...(backupDiagnostic ? [backupDiagnostic] : []), ...inspectPreparedTarget(spec, target)];
}

async function inspectPreparedMigration(
  memoryDir: string,
  intentPath: string,
  intentText: string,
): Promise<MigrationInspection> {
  const preparedIntent = parsePreparedIntent(memoryDir, intentText, intentPath);
  if (!preparedIntent.ok) {
    return { diagnostics: preparedIntent.diagnostics, targetMode: "legacy" };
  }
  const { intent } = preparedIntent;
  const targetSpecs = [
    {
      targetPath: join(memoryDir, LEARNINGS_FILE),
      backupPath: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.activeBackup),
      intent: intent.targets.active,
    },
    {
      targetPath: join(memoryDir, ARCHIVE_FILE),
      backupPath: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.archiveBackup),
      intent: intent.targets.archive,
    },
  ] as const;
  const diagnostics = (await Promise.all(targetSpecs.map(inspectPreparedTargetSpec))).flat();

  if (diagnostics.length > 0) return { diagnostics, targetMode: "handled" };
  return {
    diagnostics: [
      migrationDiagnostic(
        "learning-scope-migration-incomplete",
        "warning",
        intentPath,
        "Learning scope migration is incomplete; the next mutation will resume it.",
      ),
    ],
    targetMode: "handled",
  };
}

function countsMatch(
  left: LearningScopeMigrationMarkerV1["counts"],
  right: LearningScopeMigrationIntentV1["counts"],
): boolean {
  const countKeys = [
    "wildcardRecordsExamined",
    "recordsCanonicalized",
    "recordsEnriched",
    "recordsUnchanged",
    "globalNonglobalNormalized",
    "exposureJoinsResolved",
    "exposureJoinsMissing",
    "exposureJoinsAmbiguous",
    "relativeCandidatesDropped",
    "optionalHistoryFailures",
  ] as const;
  return (
    countKeys.every((key) => left[key] === right[key]) &&
    MIGRATION_EVIDENCE_SOURCES.every(
      (source) => left.sourceContributions[source] === right.sourceContributions[source],
    )
  );
}

interface CompletedIntentInspection {
  readonly diagnostics: readonly LearningStorageDiagnostic[];
  readonly boundIntent?: LearningScopeMigrationIntentV1;
}

function completedRecoveryDiagnostic(filePath: string, message: string): LearningStorageDiagnostic {
  return migrationDiagnostic("learning-scope-migration-recovery", "warning", filePath, message);
}

function inspectPresentCompletedIntent(
  marker: LearningScopeMigrationMarkerV1,
  intentPath: string,
  intentText: string,
): CompletedIntentInspection {
  let parsed: LearningScopeMigrationIntentV1;
  try {
    parsed = parseLearningScopeMigrationIntent(intentText, intentPath);
  } catch {
    return {
      diagnostics: [
        completedRecoveryDiagnostic(
          intentPath,
          "Completed learning scope migration intent is malformed; recovery options are reduced.",
        ),
      ],
    };
  }
  if (hashLearningScopeMigrationText(intentText) !== marker.intentSha256) {
    return {
      diagnostics: [
        completedRecoveryDiagnostic(
          intentPath,
          "Completed learning scope migration intent does not match its marker; recovery options are reduced.",
        ),
      ],
    };
  }
  const disagrees =
    marker.expectedBackups.active !== parsed.targets.active.source.exists ||
    marker.expectedBackups.archive !== parsed.targets.archive.source.exists ||
    !countsMatch(marker.counts, parsed.counts);
  return {
    diagnostics: disagrees
      ? [
          completedRecoveryDiagnostic(
            intentPath,
            "Completed learning scope migration intent disagrees with its marker; recovery options are reduced.",
          ),
        ]
      : [],
    boundIntent: parsed,
  };
}

function inspectCompletedIntent(
  marker: LearningScopeMigrationMarkerV1,
  intentPath: string,
  inspectedIntent: InspectedTextFile,
): CompletedIntentInspection {
  if (inspectedIntent.kind === "missing") {
    return {
      diagnostics: [
        completedRecoveryDiagnostic(
          intentPath,
          "Completed learning scope migration intent is missing; recovery options are reduced.",
        ),
      ],
    };
  }
  if (inspectedIntent.kind === "invalid") {
    return {
      diagnostics: [
        completedRecoveryDiagnostic(
          intentPath,
          "Completed learning scope migration intent is unreadable; recovery options are reduced.",
        ),
      ],
    };
  }
  return inspectPresentCompletedIntent(marker, intentPath, inspectedIntent.text);
}

interface CompletedBackupSpec {
  readonly path: string;
  readonly expected: boolean;
  readonly source?: LearningScopeMigrationIntentV1["targets"]["active"]["source"];
}

async function inspectCompletedBackup(
  spec: CompletedBackupSpec,
): Promise<LearningStorageDiagnostic | undefined> {
  const backup = await inspectTextFile(spec.path);
  if (!spec.expected) {
    return backup.kind === "missing"
      ? undefined
      : completedRecoveryDiagnostic(
          spec.path,
          "Unexpected completed learning scope migration backup exists; recovery artifacts are inconsistent.",
        );
  }
  if (backup.kind === "missing") {
    return completedRecoveryDiagnostic(
      spec.path,
      "Expected completed learning scope migration backup is missing; recovery options are reduced.",
    );
  }
  if (backup.kind === "invalid") {
    return completedRecoveryDiagnostic(
      spec.path,
      "Expected completed learning scope migration backup is unreadable; recovery options are reduced.",
    );
  }
  if (spec.source?.exists && hashLearningScopeMigrationText(backup.text) !== spec.source.sha256) {
    return completedRecoveryDiagnostic(
      spec.path,
      "Completed learning scope migration backup does not match its source; recovery options are reduced.",
    );
  }
  return undefined;
}

async function inspectCompletedMigration(
  memoryDir: string,
  marker: LearningScopeMigrationMarkerV1,
  intentPath: string,
  inspectedIntent: InspectedTextFile,
): Promise<MigrationInspection> {
  const intent = inspectCompletedIntent(marker, intentPath, inspectedIntent);
  const backupSpecs = [
    {
      path: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.activeBackup),
      expected: marker.expectedBackups.active,
      source: intent.boundIntent?.targets.active.source,
    },
    {
      path: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.archiveBackup),
      expected: marker.expectedBackups.archive,
      source: intent.boundIntent?.targets.archive.source,
    },
  ] as const;
  const backupDiagnostics = (await Promise.all(backupSpecs.map(inspectCompletedBackup))).filter(
    (diagnostic): diagnostic is LearningStorageDiagnostic => diagnostic !== undefined,
  );
  return {
    diagnostics: [...intent.diagnostics, ...backupDiagnostics],
    targetMode: "strict",
  };
}

async function inspectPartialBackupPreparation(memoryDir: string): Promise<MigrationInspection> {
  const specs = [
    {
      targetPath: join(memoryDir, LEARNINGS_FILE),
      backupPath: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.activeBackup),
    },
    {
      targetPath: join(memoryDir, ARCHIVE_FILE),
      backupPath: join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.archiveBackup),
    },
  ] as const;
  const inspected = await Promise.all(
    specs.map(async (spec) => ({
      ...spec,
      target: await inspectTextFile(spec.targetPath),
      backup: await inspectTextFile(spec.backupPath),
    })),
  );
  const firstBackup = inspected.find(({ backup }) => backup.kind !== "missing");
  if (!firstBackup) return { diagnostics: [], targetMode: "legacy" };

  const diagnostics: LearningStorageDiagnostic[] = [];
  for (const { targetPath, backupPath, target, backup } of inspected) {
    if (backup.kind !== "missing") {
      if (backup.kind !== "regular" || target.kind !== "regular" || backup.text !== target.text) {
        diagnostics.push(
          migrationDiagnostic(
            "invalid-learning-scope-migration-backup",
            "error",
            backupPath,
            "Partial learning scope migration backup does not match its current source target.",
          ),
        );
      }
    }
    if (target.kind === "invalid") {
      diagnostics.push(...unreadableFileDiagnostic(targetPath, target.message));
    } else if (target.kind === "regular") {
      diagnostics.push(
        ...parseLegacyScopeMigrationDocument(target.text).diagnostics.map((diagnostic) => ({
          ...diagnostic,
          severity: "error" as const,
          filePath: targetPath,
        })),
      );
    }
  }

  if (diagnostics.length > 0) return { diagnostics, targetMode: "handled" };
  return {
    diagnostics: [
      migrationDiagnostic(
        "learning-scope-migration-incomplete",
        "warning",
        firstBackup.backupPath,
        "Learning scope migration preparation is incomplete; the next mutation will resume it.",
      ),
    ],
    targetMode: "handled",
  };
}

async function inspectMigration(memoryDir: string): Promise<MigrationInspection> {
  const markerPath = join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.marker);
  const intentPath = join(memoryDir, LEARNING_SCOPE_MIGRATION_FILES.intent);
  const [marker, intent] = await Promise.all([
    inspectTextFile(markerPath),
    inspectTextFile(intentPath),
  ]);

  if (marker.kind === "invalid") {
    return {
      diagnostics: [
        migrationDiagnostic(
          "invalid-learning-scope-migration-marker",
          "error",
          markerPath,
          marker.message,
        ),
      ],
      targetMode: "legacy",
    };
  }
  if (marker.kind === "regular") {
    try {
      const parsed = parseLearningScopeMigrationMarker(marker.text, markerPath);
      return inspectCompletedMigration(memoryDir, parsed, intentPath, intent);
    } catch (error) {
      return {
        diagnostics: [
          migrationDiagnostic(
            "invalid-learning-scope-migration-marker",
            "error",
            markerPath,
            error instanceof LearningScopeMigrationError
              ? error.message
              : `Migration marker could not be inspected: ${markerPath}`,
          ),
        ],
        targetMode: "legacy",
      };
    }
  }
  if (intent.kind === "regular") {
    return inspectPreparedMigration(memoryDir, intentPath, intent.text);
  }
  if (intent.kind === "invalid") {
    return {
      diagnostics: [
        migrationDiagnostic(
          "invalid-learning-scope-migration-intent",
          "error",
          intentPath,
          intent.message,
        ),
      ],
      targetMode: "legacy",
    };
  }
  return inspectPartialBackupPreparation(memoryDir);
}

/** Inspect learnings storage without repairing or mutating it. */
export async function inspectLearningStorage(
  memoryDir: string,
): Promise<LearningStorageDiagnostic[]> {
  const [migration, condensationDiagnostics] = await Promise.all([
    inspectMigration(memoryDir),
    inspectCondensationCommit(memoryDir),
  ]);
  if (migration.targetMode === "handled") {
    return [...migration.diagnostics, ...condensationDiagnostics];
  }
  const targetMode = migration.targetMode;
  const targetDiagnostics = await Promise.all(
    [LEARNINGS_FILE, ARCHIVE_FILE].map((fileName) =>
      inspectLearningFile(join(memoryDir, fileName), targetMode),
    ),
  );
  return [...migration.diagnostics, ...condensationDiagnostics, ...targetDiagnostics.flat()];
}
