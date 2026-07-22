import { join } from "node:path";
import {
  CondensationCommitError,
  type CondensationCommitTestHooks,
  publishCondensationCommitUnderLock,
  recoverPendingCondensationCommitUnderLock,
} from "./condensation-commit";
import { replaceFileAtomically } from "./learning-file";
import {
  ARCHIVE_FILE,
  LEARNINGS_FILE,
  type LearningEntry,
  type LoadedLearningsDocument,
  appendToArchiveUnderLock,
  assertLearningsRepresentable,
  findUniqueLearningMatch,
  learningEntriesEqual,
  loadDocumentForMutation,
  renderValidatedLearnings,
  withLearningsLock,
  writeLearningsUnderLock,
} from "./learnings";
import { ensureLegacyScopeMigratedUnderLock } from "./legacy-scope-migration";
import type { DirectoryLockOptions } from "./lock";

export type LearningStoreTarget = "active" | "archive";

export interface ReadyLearningTarget {
  readonly exists: boolean;
  readonly document: LoadedLearningsDocument;
}

export interface LearningStoreReadiness {
  readonly active?: ReadyLearningTarget;
  readonly archive?: ReadyLearningTarget;
}

export interface ConsolidationCommitRequest {
  readonly expectedActive: readonly LearningEntry[];
  readonly activeReplacement: readonly LearningEntry[];
  readonly archiveEntries: readonly LearningEntry[];
}

export interface LearningRemovalResult {
  readonly status: "removed" | "stale" | "ambiguous";
  readonly entries: LearningEntry[];
}

export interface LearningUpdateResult {
  readonly status: "updated" | "stale" | "ambiguous";
  readonly entries: LearningEntry[];
}

function targetPath(memoryDir: string, target: LearningStoreTarget): string {
  return join(memoryDir, target === "active" ? LEARNINGS_FILE : ARCHIVE_FILE);
}

function validateConsolidationCommitRequest(
  memoryDir: string,
  request: ConsolidationCommitRequest,
): string {
  const activePath = targetPath(memoryDir, "active");
  const archivePath = targetPath(memoryDir, "archive");
  const activeReplacement = renderValidatedLearnings(activePath, request.activeReplacement);
  assertLearningsRepresentable(archivePath, [...request.archiveEntries]);
  return activeReplacement;
}

async function loadReadyTarget(
  memoryDir: string,
  target: LearningStoreTarget,
): Promise<ReadyLearningTarget> {
  const filePath = targetPath(memoryDir, target);
  const exists = await Bun.file(filePath).exists();
  const document = await loadDocumentForMutation(filePath);
  return { exists, document };
}

export async function prepareLearningStoreForMutationUnderLock(
  memoryDir: string,
  requiredTargets: readonly LearningStoreTarget[],
): Promise<LearningStoreReadiness> {
  await ensureLegacyScopeMigratedUnderLock(memoryDir);
  await recoverPendingCondensationCommitUnderLock(memoryDir);
  const requested = new Set(requiredTargets);
  const readiness: {
    active?: ReadyLearningTarget;
    archive?: ReadyLearningTarget;
  } = {};
  if (requested.has("active")) readiness.active = await loadReadyTarget(memoryDir, "active");
  if (requested.has("archive")) readiness.archive = await loadReadyTarget(memoryDir, "archive");
  return readiness;
}

export async function commitConsolidationIfUnchangedUnderLock(
  memoryDir: string,
  request: ConsolidationCommitRequest,
  hooks?: CondensationCommitTestHooks,
): Promise<boolean> {
  const activePath = targetPath(memoryDir, "active");
  const archivePath = targetPath(memoryDir, "archive");
  const activeReplacement = validateConsolidationCommitRequest(memoryDir, request);
  const requiredTargets: LearningStoreTarget[] =
    request.archiveEntries.length > 0 ? ["active", "archive"] : ["active"];
  const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, requiredTargets);
  if (!learningEntriesEqual(readiness.active?.document.entries ?? [], request.expectedActive)) {
    return false;
  }

  if (request.archiveEntries.length === 0) {
    await replaceFileAtomically(activePath, activeReplacement);
    return true;
  }
  const active = readiness.active;
  const archive = readiness.archive;
  if (!active || !archive) {
    throw new CondensationCommitError("Condensation commit readiness was not established.");
  }
  if (!active.exists) {
    throw new CondensationCommitError(
      `Condensation requires existing active learning storage: ${activePath}`,
      activePath,
    );
  }
  const archiveReplacement = renderValidatedLearnings(archivePath, [
    ...archive.document.entries,
    ...request.archiveEntries,
  ]);
  await publishCondensationCommitUnderLock(
    memoryDir,
    {
      activeSource: { exists: true, sourceText: active.document.sourceText },
      archiveSource: { exists: archive.exists, sourceText: archive.document.sourceText },
      activeReplacement,
      archiveReplacement,
    },
    hooks,
  );
  return true;
}

export async function commitConsolidationIfUnchanged(
  memoryDir: string,
  request: ConsolidationCommitRequest,
): Promise<boolean> {
  validateConsolidationCommitRequest(memoryDir, request);
  return await withLearningsLock(memoryDir, () =>
    commitConsolidationIfUnchangedUnderLock(memoryDir, request),
  );
}

export async function prepareLearningStoreForMutation(
  memoryDir: string,
  requiredTargets: readonly LearningStoreTarget[],
): Promise<LearningStoreReadiness> {
  return await withLearningsLock(memoryDir, () =>
    prepareLearningStoreForMutationUnderLock(memoryDir, requiredTargets),
  );
}

/** Write the complete active collection after establishing migration readiness. */
export async function writeLearnings(
  memoryDir: string,
  entries: readonly LearningEntry[],
): Promise<void> {
  assertLearningsRepresentable(targetPath(memoryDir, "active"), [...entries]);
  await withLearningsLock(memoryDir, async () => {
    await prepareLearningStoreForMutationUnderLock(memoryDir, ["active"]);
    await writeLearningsUnderLock(memoryDir, entries);
  });
}

/** Apply one active read-modify-write transaction under the shared learning lock. */
export async function mutateLearnings(
  memoryDir: string,
  mutation: (entries: LearningEntry[]) => LearningEntry[] | Promise<LearningEntry[]>,
  lockOptions?: DirectoryLockOptions,
): Promise<LearningEntry[]> {
  return await withLearningsLock(
    memoryDir,
    async () => {
      const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, ["active"]);
      const updated = await mutation(readiness.active?.document.entries ?? []);
      await writeLearningsUnderLock(memoryDir, updated);
      return updated;
    },
    lockOptions,
  );
}

/** Append archive entries after establishing archive readiness. */
export async function appendToArchive(
  memoryDir: string,
  entries: readonly LearningEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  assertLearningsRepresentable(targetPath(memoryDir, "archive"), [...entries]);
  await withLearningsLock(memoryDir, async () => {
    const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, ["archive"]);
    await appendToArchiveUnderLock(memoryDir, readiness.archive?.document.entries ?? [], entries);
  });
}

/** Replace a snapshot only when the fresh active collection remains structurally equal. */
export function replaceLearningsIfUnchanged(
  memoryDir: string,
  expected: readonly LearningEntry[],
  replacement: readonly LearningEntry[],
): Promise<boolean>;
export async function replaceLearningsIfUnchanged(
  memoryDir: string,
  expected: readonly LearningEntry[],
  replacement: readonly LearningEntry[],
  ...unsupportedArguments: unknown[]
): Promise<boolean> {
  if (unsupportedArguments.length > 0) {
    throw new TypeError(
      "replaceLearningsIfUnchanged no longer accepts a before-write callback; use the built-in consolidation path for archive moves.",
    );
  }
  const activePath = targetPath(memoryDir, "active");
  const content = renderValidatedLearnings(activePath, replacement);
  return await withLearningsLock(memoryDir, async () => {
    const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, ["active"]);
    if (!learningEntriesEqual(readiness.active?.document.entries ?? [], expected)) return false;

    await replaceFileAtomically(activePath, content);
    return true;
  });
}

/** Update one exact reviewed representation from its fresh locked value. */
export async function updateLearningIfUnchanged(
  memoryDir: string,
  expected: LearningEntry,
  update: (entry: LearningEntry) => LearningEntry,
): Promise<LearningUpdateResult> {
  const activePath = targetPath(memoryDir, "active");
  renderValidatedLearnings(activePath, [expected]);
  return await withLearningsLock(memoryDir, async () => {
    const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, ["active"]);
    const current = readiness.active?.document.entries ?? [];
    const match = findUniqueLearningMatch(current, expected);
    if (match.status !== "matched") return { status: match.status, entries: current };

    const entries = current.toSpliced(match.index, 1, update(match.entry));
    await writeLearningsUnderLock(memoryDir, entries);
    return { status: "updated", entries };
  });
}

/** Remove one exact reviewed representation without deleting an arbitrary duplicate. */
export async function removeLearningIfUnchanged(
  memoryDir: string,
  expected: LearningEntry,
): Promise<LearningRemovalResult> {
  const activePath = targetPath(memoryDir, "active");
  renderValidatedLearnings(activePath, [expected]);
  return await withLearningsLock(memoryDir, async () => {
    const readiness = await prepareLearningStoreForMutationUnderLock(memoryDir, ["active"]);
    const current = readiness.active?.document.entries ?? [];
    const match = findUniqueLearningMatch(current, expected);
    if (match.status !== "matched") return { status: match.status, entries: current };

    const entries = current.toSpliced(match.index, 1);
    await writeLearningsUnderLock(memoryDir, entries);
    return { status: "removed", entries };
  });
}
