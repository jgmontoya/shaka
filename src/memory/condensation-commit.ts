/** Recoverable publication for condensation moves across active and archive storage. */

import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileAtomically, replaceFileAtomically } from "./learning-file";
import {
  ARCHIVE_FILE,
  LEARNINGS_FILE,
  type LoadedLearningSource,
  loadLearningSourceForMutation,
  parseLearningsDocument,
  renderValidatedLearnings,
} from "./learnings";

const VERSION = 1 as const;
export const CONDENSATION_COMMIT_FILE = ".learning-condensation-v1.intent.json";

export type CondensationCommitCheckpoint =
  | "intent-published"
  | "archive-replaced"
  | "active-replaced";

export interface CondensationCommitTestHooks {
  readonly afterCheckpoint?: (checkpoint: CondensationCommitCheckpoint) => void;
}

export type CondensationSourceVersion =
  | { readonly exists: false }
  | { readonly exists: true; readonly sha256: string };

export interface CondensationReplacement {
  readonly exists: true;
  readonly sha256: string;
  readonly text: string;
}

export interface CondensationTargetIntent {
  readonly source: CondensationSourceVersion;
  readonly replacement: CondensationReplacement;
}

export interface CondensationCommitIntentV1 {
  readonly version: 1;
  readonly targets: {
    readonly active: CondensationTargetIntent;
    readonly archive: CondensationTargetIntent;
  };
}

export interface CondensationCommitDocuments {
  readonly activeSource: LoadedLearningSource;
  readonly archiveSource: LoadedLearningSource;
  readonly activeReplacement: string;
  readonly archiveReplacement: string;
}

export class CondensationCommitError extends Error {
  constructor(
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "CondensationCommitError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function hashCondensationCommitText(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function parseSourceVersion(value: unknown): CondensationSourceVersion | undefined {
  if (!isRecord(value) || typeof value.exists !== "boolean") return undefined;
  if (!value.exists) return hasOnlyKeys(value, ["exists"]) ? { exists: false } : undefined;
  return hasOnlyKeys(value, ["exists", "sha256"]) && isSha256(value.sha256)
    ? { exists: true, sha256: value.sha256 }
    : undefined;
}

function parseReplacement(value: unknown): CondensationReplacement | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["exists", "sha256", "text"]) ||
    value.exists !== true ||
    !isSha256(value.sha256) ||
    typeof value.text !== "string" ||
    hashCondensationCommitText(value.text) !== value.sha256
  ) {
    return undefined;
  }
  return { exists: true, sha256: value.sha256, text: value.text };
}

function parseTargetIntent(value: unknown): CondensationTargetIntent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["source", "replacement"])) return undefined;
  const source = parseSourceVersion(value.source);
  const replacement = parseReplacement(value.replacement);
  return source && replacement ? { source, replacement } : undefined;
}

function validateReplacement(targetPath: string, replacement: CondensationReplacement): boolean {
  const parsed = parseLearningsDocument(replacement.text);
  if (parsed.diagnostics.length > 0) return false;
  try {
    return renderValidatedLearnings(targetPath, parsed.entries) === replacement.text;
  } catch {
    return false;
  }
}

export function parseCondensationCommitIntent(
  text: string,
  filePath: string,
): CondensationCommitIntentV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CondensationCommitError(`Condensation intent is malformed: ${filePath}`, filePath);
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "targets"]) ||
    value.version !== VERSION
  ) {
    throw new CondensationCommitError(
      `Condensation intent has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  if (!isRecord(value.targets) || !hasOnlyKeys(value.targets, ["active", "archive"])) {
    throw new CondensationCommitError(
      `Condensation intent has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  const active = parseTargetIntent(value.targets.active);
  const archive = parseTargetIntent(value.targets.archive);
  const memoryDir = dirname(filePath);
  const activePath = join(memoryDir, LEARNINGS_FILE);
  const archivePath = join(memoryDir, ARCHIVE_FILE);
  if (
    !active ||
    !archive ||
    !active.source.exists ||
    (active.source.exists && active.source.sha256 === active.replacement.sha256) ||
    (archive.source.exists && archive.source.sha256 === archive.replacement.sha256) ||
    !validateReplacement(activePath, active.replacement) ||
    !validateReplacement(archivePath, archive.replacement)
  ) {
    throw new CondensationCommitError(
      `Condensation intent has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  return { version: VERSION, targets: { active, archive } };
}

function sourceVersion(source: LoadedLearningSource): CondensationSourceVersion {
  return source.exists
    ? { exists: true, sha256: hashCondensationCommitText(source.sourceText) }
    : { exists: false };
}

function replacement(text: string): CondensationReplacement {
  return { exists: true, sha256: hashCondensationCommitText(text), text };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createIntent(documents: CondensationCommitDocuments): CondensationCommitIntentV1 {
  return {
    version: VERSION,
    targets: {
      active: {
        source: sourceVersion(documents.activeSource),
        replacement: replacement(documents.activeReplacement),
      },
      archive: {
        source: sourceVersion(documents.archiveSource),
        replacement: replacement(documents.archiveReplacement),
      },
    },
  };
}

export function classifyCondensationCommitTarget(
  currentText: string | undefined,
  target: CondensationTargetIntent,
): "source" | "replacement" | "third" {
  if (
    currentText !== undefined &&
    hashCondensationCommitText(currentText) === target.replacement.sha256
  ) {
    return "replacement";
  }
  if (!target.source.exists) return currentText === undefined ? "source" : "third";
  return currentText !== undefined &&
    hashCondensationCommitText(currentText) === target.source.sha256
    ? "source"
    : "third";
}

async function classifyTarget(
  targetPath: string,
  target: CondensationTargetIntent,
): Promise<"source" | "replacement"> {
  const current = await loadLearningSourceForMutation(targetPath);
  const state = classifyCondensationCommitTarget(
    current.exists ? current.sourceText : undefined,
    target,
  );
  if (state === "third") {
    throw new CondensationCommitError(
      `Condensation target is in an unexpected third state: ${targetPath}`,
      targetPath,
    );
  }
  if (state === "source" && current.exists) {
    const parsed = parseLearningsDocument(current.sourceText);
    if (parsed.diagnostics.length > 0) {
      throw new CondensationCommitError(
        `Condensation source target is invalid: ${targetPath}`,
        targetPath,
      );
    }
  }
  return state;
}

async function publishReplacement(
  targetPath: string,
  target: CondensationTargetIntent,
): Promise<boolean> {
  if ((await classifyTarget(targetPath, target)) === "replacement") return false;
  await replaceFileAtomically(targetPath, target.replacement.text);
  return true;
}

async function replayIntent(
  memoryDir: string,
  intentText: string,
  hooks?: CondensationCommitTestHooks,
): Promise<void> {
  const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
  const intent = parseCondensationCommitIntent(intentText, intentPath);
  const activePath = join(memoryDir, LEARNINGS_FILE);
  const archivePath = join(memoryDir, ARCHIVE_FILE);

  await classifyTarget(activePath, intent.targets.active);
  await classifyTarget(archivePath, intent.targets.archive);
  if (await publishReplacement(archivePath, intent.targets.archive)) {
    hooks?.afterCheckpoint?.("archive-replaced");
  }
  if (await publishReplacement(activePath, intent.targets.active)) {
    hooks?.afterCheckpoint?.("active-replaced");
  }
  if ((await classifyTarget(archivePath, intent.targets.archive)) !== "replacement") {
    throw new CondensationCommitError(
      "Archive condensation replacement did not persist.",
      archivePath,
    );
  }
  if ((await classifyTarget(activePath, intent.targets.active)) !== "replacement") {
    throw new CondensationCommitError(
      "Active condensation replacement did not persist.",
      activePath,
    );
  }

  const currentIntent = await loadLearningSourceForMutation(intentPath);
  if (!currentIntent.exists || currentIntent.sourceText !== intentText) {
    throw new CondensationCommitError(
      `Condensation intent changed during publication: ${intentPath}`,
      intentPath,
    );
  }
  await unlink(intentPath);
}

export async function recoverPendingCondensationCommitUnderLock(
  memoryDir: string,
  hooks?: CondensationCommitTestHooks,
): Promise<boolean> {
  const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
  const source = await loadLearningSourceForMutation(intentPath);
  if (!source.exists) return false;
  await replayIntent(memoryDir, source.sourceText, hooks);
  return true;
}

export async function publishCondensationCommitUnderLock(
  memoryDir: string,
  documents: CondensationCommitDocuments,
  hooks?: CondensationCommitTestHooks,
): Promise<void> {
  const intentPath = join(memoryDir, CONDENSATION_COMMIT_FILE);
  const intent = createIntent(documents);
  const intentText = jsonText(intent);
  parseCondensationCommitIntent(intentText, intentPath);

  const created = await createFileAtomically(intentPath, intentText);
  if (created === "exists") {
    const current = await loadLearningSourceForMutation(intentPath);
    if (!current.exists || current.sourceText !== intentText) {
      throw new CondensationCommitError(
        `A different condensation intent is already pending: ${intentPath}`,
        intentPath,
      );
    }
  } else {
    hooks?.afterCheckpoint?.("intent-published");
  }
  await replayIntent(memoryDir, intentText, hooks);
}
