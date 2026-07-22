import { isAbsolute, join } from "node:path";
import {
  createFileAtomically,
  inspectLearningFileStatus,
  replaceFileAtomically,
} from "./learning-file";
import { type PromotionEvidence, type PromotionReason, normalizeCwdPath } from "./learning-scope";
import {
  ARCHIVE_FILE,
  LEARNINGS_FILE,
  type LearningEntry,
  LearningsIntegrityError,
  type LoadedLearningSource,
  loadLearningSourceForMutation,
  parseLearningsDocument,
  parseLegacyScopeMigrationDocument,
  renderValidatedLearnings,
} from "./learnings";
import { type SummaryIndex, listSummaries } from "./storage";
import { hashSessionId } from "./utils";

const VERSION = 1 as const;
const MARKER_FILE = ".learning-scope-migration-v1.json";
const INTENT_FILE = ".learning-scope-migration-v1.intent.json";
const ACTIVE_BACKUP_FILE = ".learning-scope-migration-v1.active.md";
const ARCHIVE_BACKUP_FILE = ".learning-scope-migration-v1.archive.md";
const OPTIONAL_HISTORY_FILE = "learnings.backup.md";

export const LEARNING_SCOPE_MIGRATION_FILES = {
  marker: MARKER_FILE,
  intent: INTENT_FILE,
  activeBackup: ACTIVE_BACKUP_FILE,
  archiveBackup: ARCHIVE_BACKUP_FILE,
} as const;

export const MIGRATION_EVIDENCE_SOURCES = [
  "exposure",
  "activeMixed",
  "backupPromotion",
  "backupScoped",
  "backupMixed",
  "archivePromotion",
  "archiveScoped",
  "archiveMixed",
] as const;

export type MigrationEvidenceSource = (typeof MIGRATION_EVIDENCE_SOURCES)[number];
export type MigrationCheckpoint = "intent-published" | "archive-replaced";

export interface MigrationTestHooks {
  readonly afterCheckpoint?: (checkpoint: MigrationCheckpoint) => void;
}

export interface MigrationCounts {
  readonly wildcardRecordsExamined: number;
  readonly recordsCanonicalized: number;
  readonly recordsEnriched: number;
  readonly recordsUnchanged: number;
  readonly globalNonglobalNormalized: number;
  readonly exposureJoinsResolved: number;
  readonly exposureJoinsMissing: number;
  readonly exposureJoinsAmbiguous: number;
  readonly relativeCandidatesDropped: number;
  readonly optionalHistoryFailures: number;
  readonly sourceContributions: Readonly<Record<MigrationEvidenceSource, number>>;
}

interface MutableMigrationCounts {
  wildcardRecordsExamined: number;
  recordsCanonicalized: number;
  recordsEnriched: number;
  recordsUnchanged: number;
  globalNonglobalNormalized: number;
  exposureJoinsResolved: number;
  exposureJoinsMissing: number;
  exposureJoinsAmbiguous: number;
  relativeCandidatesDropped: number;
  optionalHistoryFailures: number;
  sourceContributions: Record<MigrationEvidenceSource, number>;
}

export interface MigrationTargetIntent {
  readonly source: { readonly exists: false } | { readonly exists: true; readonly sha256: string };
  readonly replacement:
    | { readonly exists: false }
    | { readonly exists: true; readonly sha256: string; readonly text: string };
}

export interface LearningScopeMigrationIntentV1 {
  readonly version: 1;
  readonly targets: {
    readonly active: MigrationTargetIntent;
    readonly archive: MigrationTargetIntent;
  };
  readonly counts: MigrationCounts;
}

export interface LearningScopeMigrationMarkerV1 {
  readonly version: 1;
  readonly intentSha256: string;
  readonly completedAt: string;
  readonly expectedBackups: {
    readonly active: boolean;
    readonly archive: boolean;
  };
  readonly counts: MigrationCounts;
}

interface MigrationSnapshot {
  readonly exists: boolean;
  readonly sourceText: string;
  readonly entries: readonly LearningEntry[];
}

type TargetName = "active" | "archive";

export class LearningScopeMigrationError extends Error {
  constructor(
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "LearningScopeMigrationError";
  }
}

function emptyCounts(): MutableMigrationCounts {
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
    sourceContributions: Object.fromEntries(
      MIGRATION_EVIDENCE_SOURCES.map((source) => [source, 0]),
    ) as Record<MigrationEvidenceSource, number>,
  };
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

export function hashLearningScopeMigrationText(text: string): string {
  return sha256(text);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function reportMigrationCounts(counts: MigrationCounts): void {
  if (counts.wildcardRecordsExamined === 0 && counts.optionalHistoryFailures === 0) return;
  const contributions = MIGRATION_EVIDENCE_SOURCES.map(
    (source) => `${source}=${counts.sourceContributions[source]}`,
  ).join(",");
  console.error(
    [
      "Learning scope migration v1 complete",
      `examined=${counts.wildcardRecordsExamined}`,
      `canonicalized=${counts.recordsCanonicalized}`,
      `enriched=${counts.recordsEnriched}`,
      `unchanged=${counts.recordsUnchanged}`,
      `normalized-nonglobal=${counts.globalNonglobalNormalized}`,
      `joins-resolved=${counts.exposureJoinsResolved}`,
      `joins-missing=${counts.exposureJoinsMissing}`,
      `joins-ambiguous=${counts.exposureJoinsAmbiguous}`,
      `relative-dropped=${counts.relativeCandidatesDropped}`,
      `optional-history-failures=${counts.optionalHistoryFailures}`,
      `contributions=${contributions}`,
    ].join(" "),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function exposureKey(exposure: { readonly date: string; readonly sessionHash: string }): string {
  return `${exposure.date}@${exposure.sessionHash}`;
}

function mergeExposures(
  ...groups: readonly (readonly { readonly date: string; readonly sessionHash: string }[])[]
) {
  const byKey = new Map<string, { date: string; sessionHash: string }>();
  for (const exposure of groups.flat()) byKey.set(exposureKey(exposure), { ...exposure });
  return [...byKey.values()].sort(
    (left, right) =>
      compareCodeUnits(left.date, right.date) ||
      compareCodeUnits(left.sessionHash, right.sessionHash),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseCounts(value: unknown): MigrationCounts | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
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
    "sourceContributions",
  ];
  if (!hasOnlyKeys(value, keys)) return undefined;
  if (
    keys
      .filter((key) => key !== "sourceContributions")
      .some((key) => !isNonNegativeInteger(value[key]))
  )
    return undefined;
  const contributions = value.sourceContributions;
  if (!isRecord(contributions) || !hasOnlyKeys(contributions, MIGRATION_EVIDENCE_SOURCES)) {
    return undefined;
  }
  if (MIGRATION_EVIDENCE_SOURCES.some((source) => !isNonNegativeInteger(contributions[source]))) {
    return undefined;
  }
  return value as unknown as MigrationCounts;
}

function parseTargetIntent(value: unknown): MigrationTargetIntent | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["source", "replacement"])) return undefined;
  const source = value.source;
  const replacement = value.replacement;
  if (!isRecord(source) || !isRecord(replacement)) return undefined;
  const sourceValid =
    (hasOnlyKeys(source, ["exists"]) && source.exists === false) ||
    (hasOnlyKeys(source, ["exists", "sha256"]) &&
      source.exists === true &&
      isSha256(source.sha256));
  const replacementValid =
    (hasOnlyKeys(replacement, ["exists"]) && replacement.exists === false) ||
    (hasOnlyKeys(replacement, ["exists", "sha256", "text"]) &&
      replacement.exists === true &&
      isSha256(replacement.sha256) &&
      typeof replacement.text === "string" &&
      sha256(replacement.text) === replacement.sha256);
  if (!sourceValid || !replacementValid || source.exists !== replacement.exists) return undefined;
  return value as unknown as MigrationTargetIntent;
}

function parseIntent(text: string, filePath: string): LearningScopeMigrationIntentV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LearningScopeMigrationError(`Migration intent is malformed: ${filePath}`, filePath);
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "targets", "counts"])) {
    throw new LearningScopeMigrationError(
      `Migration intent has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  const targets = value.targets;
  const active = isRecord(targets) ? parseTargetIntent(targets.active) : undefined;
  const archive = isRecord(targets) ? parseTargetIntent(targets.archive) : undefined;
  const counts = parseCounts(value.counts);
  if (
    value.version !== VERSION ||
    !isRecord(targets) ||
    !hasOnlyKeys(targets, ["active", "archive"]) ||
    !active ||
    !archive ||
    !counts
  ) {
    throw new LearningScopeMigrationError(
      `Migration intent has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  return { version: VERSION, targets: { active, archive }, counts };
}

function parseMarker(text: string, filePath: string): LearningScopeMigrationMarkerV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new LearningScopeMigrationError(`Migration marker is malformed: ${filePath}`, filePath);
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "intentSha256", "completedAt", "expectedBackups", "counts"])
  ) {
    throw new LearningScopeMigrationError(
      `Migration marker has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  const expected = value.expectedBackups;
  const counts = parseCounts(value.counts);
  const completedAt = value.completedAt;
  const validDate =
    typeof completedAt === "string" &&
    Number.isFinite(Date.parse(completedAt)) &&
    new Date(completedAt).toISOString() === completedAt;
  if (
    value.version !== VERSION ||
    !isSha256(value.intentSha256) ||
    !validDate ||
    !isRecord(expected) ||
    !hasOnlyKeys(expected, ["active", "archive"]) ||
    typeof expected.active !== "boolean" ||
    typeof expected.archive !== "boolean" ||
    !counts
  ) {
    throw new LearningScopeMigrationError(
      `Migration marker has an invalid schema: ${filePath}`,
      filePath,
    );
  }
  return value as unknown as LearningScopeMigrationMarkerV1;
}

export function parseLearningScopeMigrationIntent(
  text: string,
  filePath: string,
): LearningScopeMigrationIntentV1 {
  return parseIntent(text, filePath);
}

export function parseLearningScopeMigrationMarker(
  text: string,
  filePath: string,
): LearningScopeMigrationMarkerV1 {
  return parseMarker(text, filePath);
}

export type MigrationTargetState = "source" | "replacement" | "third";

export function classifyLearningScopeMigrationTarget(
  sourceText: string | undefined,
  target: MigrationTargetIntent,
): MigrationTargetState {
  if (!target.source.exists) return sourceText === undefined ? "replacement" : "third";
  if (sourceText === undefined) return "third";
  const hash = sha256(sourceText);
  if (target.replacement.exists && hash === target.replacement.sha256) return "replacement";
  return hash === target.source.sha256 ? "source" : "third";
}

export function validateLearningScopeMigrationReplacement(
  targetPath: string,
  target: MigrationTargetIntent,
): void {
  if (!target.replacement.exists) return;
  const parsed = parseLearningsDocument(target.replacement.text);
  const canonical =
    parsed.diagnostics.length === 0
      ? renderValidatedLearnings(targetPath, parsed.entries)
      : undefined;
  if (canonical !== target.replacement.text) {
    throw new LearningScopeMigrationError(
      `Migration intent contains an invalid replacement: ${targetPath}`,
      targetPath,
    );
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind === "missing") return undefined;
  if (status.kind === "invalid") {
    throw new LearningScopeMigrationError(status.message, filePath);
  }
  try {
    return await Bun.file(filePath).text();
  } catch {
    throw new LearningScopeMigrationError("Migration artifact could not be read.", filePath);
  }
}

function parseMigrationTarget(filePath: string, source: LoadedLearningSource): MigrationSnapshot {
  if (!source.exists) return { exists: false, sourceText: "", entries: [] };
  const parsed = parseLegacyScopeMigrationDocument(source.sourceText);
  if (parsed.diagnostics.length > 0)
    throw new LearningsIntegrityError(filePath, parsed.diagnostics);
  return { exists: true, sourceText: source.sourceText, entries: parsed.entries };
}

async function loadOptionalHistory(
  filePath: string,
  counts: MutableMigrationCounts,
): Promise<readonly LearningEntry[]> {
  try {
    const source = await loadLearningSourceForMutation(filePath);
    if (!source.exists) return [];
    const parsed = parseLegacyScopeMigrationDocument(source.sourceText);
    if (parsed.diagnostics.length > 0) {
      counts.optionalHistoryFailures++;
      return [];
    }
    return parsed.entries;
  } catch {
    counts.optionalHistoryFailures++;
    return [];
  }
}

function summaryJoinKey(date: string, sessionHash: string): string {
  return `${date}@${sessionHash}`;
}

function buildSummaryIndex(
  summaries: readonly Pick<SummaryIndex, "date" | "sessionId" | "cwd">[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const summary of summaries) {
    const key = summaryJoinKey(summary.date, hashSessionId(summary.sessionId));
    const cwds = index.get(key) ?? new Set<string>();
    cwds.add(summary.cwd);
    index.set(key, cwds);
  }
  return index;
}

interface ReconstructionSource {
  readonly name: MigrationEvidenceSource;
  readonly cwds: readonly string[];
}

function companions(entry: LearningEntry): string[] {
  return entry.cwds.filter((cwd) => cwd !== "*");
}

function isMixed(entry: LearningEntry): boolean {
  return entry.cwds.includes("*") && companions(entry).length > 0;
}

function strictMatch(left: LearningEntry, right: LearningEntry): boolean {
  return left.category === right.category && left.title === right.title && left.body === right.body;
}

function collectHistoricalEntry(
  entry: LearningEntry,
  promotion: Set<string>,
  scoped: Set<string>,
  mixed: Set<string>,
): void {
  for (const cwd of entry.promotionEvidence?.sourceCwds ?? []) promotion.add(cwd);
  if (isMixed(entry)) {
    for (const cwd of companions(entry)) mixed.add(cwd);
    return;
  }
  if (entry.promotionEvidence || entry.cwds.includes("*")) return;
  for (const cwd of entry.cwds) scoped.add(cwd);
}

function collectHistoricalSources(
  target: LearningEntry,
  history: readonly LearningEntry[],
  prefix: "backup" | "archive",
): ReconstructionSource[] {
  const promotion = new Set<string>();
  const scoped = new Set<string>();
  const mixed = new Set<string>();
  for (const entry of history) {
    if (!strictMatch(target, entry)) continue;
    collectHistoricalEntry(entry, promotion, scoped, mixed);
  }
  return [
    { name: `${prefix}Promotion`, cwds: uniqueSorted([...promotion]) },
    { name: `${prefix}Scoped`, cwds: uniqueSorted([...scoped]) },
    { name: `${prefix}Mixed`, cwds: uniqueSorted([...mixed]) },
  ];
}

function exposureSources(
  targetKey: string,
  entry: LearningEntry,
  summaries: ReadonlyMap<string, ReadonlySet<string>>,
  counts: MutableMigrationCounts,
): string[] {
  const recovered = new Set<string>();
  const relativeCandidates = new Set<string>();
  for (const exposure of entry.exposures) {
    const candidates = summaries.get(summaryJoinKey(exposure.date, exposure.sessionHash));
    if (!candidates) {
      counts.exposureJoinsMissing++;
      continue;
    }
    if (candidates.size !== 1) {
      counts.exposureJoinsAmbiguous++;
      continue;
    }
    counts.exposureJoinsResolved++;
    const cwd = candidates.values().next().value;
    if (!cwd) continue;
    if (!isAbsolute(cwd)) {
      relativeCandidates.add(`${targetKey}\0${cwd}`);
      continue;
    }
    const normalized = normalizeCwdPath(cwd);
    if (normalized) recovered.add(normalized);
  }
  counts.relativeCandidatesDropped += relativeCandidates.size;
  return uniqueSorted([...recovered]);
}

function normalizeSource(source: ReconstructionSource): ReconstructionSource {
  return {
    name: source.name,
    cwds: uniqueSorted(
      source.cwds.flatMap((cwd) => {
        const normalized = normalizeCwdPath(cwd);
        return normalized && isAbsolute(normalized) ? [normalized] : [];
      }),
    ),
  };
}

function reconstructSources(
  targetKey: string,
  entry: LearningEntry,
  targetName: TargetName,
  summaries: ReadonlyMap<string, ReadonlySet<string>>,
  backup: readonly LearningEntry[],
  archive: readonly LearningEntry[],
  counts: MutableMigrationCounts,
): string[] {
  const rawSources: ReconstructionSource[] = [
    { name: "exposure", cwds: exposureSources(targetKey, entry, summaries, counts) },
    {
      name: "activeMixed",
      cwds: targetName === "active" && isMixed(entry) ? companions(entry) : [],
    },
    ...collectHistoricalSources(entry, backup, "backup"),
    ...collectHistoricalSources(entry, archive, "archive"),
  ];
  const sources = rawSources.map(normalizeSource);
  const combined = new Set<string>();
  for (const source of sources) {
    for (const cwd of source.cwds) {
      if (combined.has(cwd)) continue;
      combined.add(cwd);
      counts.sourceContributions[source.name]++;
    }
  }
  return uniqueSorted([...combined]);
}

function migratedEvidence(
  entry: LearningEntry,
  recovered: readonly string[],
): PromotionEvidence | undefined {
  if (recovered.length === 0) return entry.promotionEvidence;
  const existing = entry.promotionEvidence;
  const reasons = uniqueSorted([
    ...(existing?.reasons ?? []),
    "legacy-source-reconstruction",
  ]) as PromotionReason[];
  return {
    sourceCwds: uniqueSorted([...(existing?.sourceCwds ?? []), ...recovered]),
    excludedCwds: uniqueSorted(existing?.excludedCwds ?? []),
    exposures: mergeExposures(existing?.exposures ?? [], entry.exposures),
    reasons,
  };
}

function migrateEntries(
  entries: readonly LearningEntry[],
  targetName: TargetName,
  summaries: ReadonlyMap<string, ReadonlySet<string>>,
  backup: readonly LearningEntry[],
  archive: readonly LearningEntry[],
  counts: MutableMigrationCounts,
): LearningEntry[] {
  return entries.map((entry, index) => {
    if (!entry.cwds.includes("*")) return entry;
    counts.wildcardRecordsExamined++;
    const recovered = reconstructSources(
      `${targetName}:${index}`,
      entry,
      targetName,
      summaries,
      backup,
      archive,
      counts,
    );
    const promotionEvidence = migratedEvidence(entry, recovered);
    const canonicalized = entry.cwds.length !== 1 || entry.cwds[0] !== "*" || entry.nonglobal;
    if (canonicalized) counts.recordsCanonicalized++;
    if (entry.nonglobal) counts.globalNonglobalNormalized++;
    const enriched = !Bun.deepEquals(entry.promotionEvidence, promotionEvidence);
    if (enriched) counts.recordsEnriched++;
    if (!canonicalized && !enriched) counts.recordsUnchanged++;
    return {
      ...entry,
      cwds: ["*"],
      nonglobal: false,
      ...(promotionEvidence ? { promotionEvidence } : {}),
    };
  });
}

function targetIntent(
  source: LoadedLearningSource,
  replacementText?: string,
): MigrationTargetIntent {
  if (!source.exists) return { source: { exists: false }, replacement: { exists: false } };
  if (replacementText === undefined)
    throw new Error("Existing migration target lacks replacement text.");
  return {
    source: { exists: true, sha256: sha256(source.sourceText) },
    replacement: {
      exists: true,
      sha256: sha256(replacementText),
      text: replacementText,
    },
  };
}

async function verifyBackup(
  backupPath: string,
  source: MigrationTargetIntent["source"],
  beforeIntent: boolean,
): Promise<void> {
  const backup = await readOptionalText(backupPath);
  if (!source.exists) {
    if (backup !== undefined) {
      throw new LearningScopeMigrationError(
        `Unexpected migration backup: ${backupPath}`,
        backupPath,
      );
    }
    return;
  }
  if (backup === undefined || sha256(backup) !== source.sha256) {
    throw new LearningScopeMigrationError(
      `${beforeIntent ? "Migration backup does not match current source" : "Migration backup is missing or damaged"}: ${backupPath}`,
      backupPath,
    );
  }
}

async function ensureBackup(backupPath: string, source: LoadedLearningSource): Promise<void> {
  if (!source.exists) {
    if ((await inspectLearningFileStatus(backupPath)).kind !== "missing") {
      throw new LearningScopeMigrationError(
        `Unexpected migration backup: ${backupPath}`,
        backupPath,
      );
    }
    return;
  }
  const created = await createFileAtomically(backupPath, source.sourceText);
  if (created === "exists") {
    const existing = await readOptionalText(backupPath);
    if (existing !== source.sourceText) {
      throw new LearningScopeMigrationError(
        `Migration backup does not match current source: ${backupPath}`,
        backupPath,
      );
    }
  }
}

async function classifyTarget(
  targetPath: string,
  target: MigrationTargetIntent,
): Promise<"source" | "replacement"> {
  const current = await loadLearningSourceForMutation(targetPath);
  const state = classifyLearningScopeMigrationTarget(
    current.exists ? current.sourceText : undefined,
    target,
  );
  if (state !== "third") return state;
  throw new LearningScopeMigrationError(
    `Migration target is in an unexpected third state: ${targetPath}`,
    targetPath,
  );
}

async function publishReplacement(
  targetPath: string,
  target: MigrationTargetIntent,
): Promise<boolean> {
  const state = await classifyTarget(targetPath, target);
  if (state === "replacement") return false;
  if (!target.replacement.exists) return false;
  await replaceFileAtomically(targetPath, target.replacement.text);
  return true;
}

async function replayPreparedIntent(
  memoryDir: string,
  intentText: string,
  hooks?: MigrationTestHooks,
): Promise<void> {
  const intentPath = join(memoryDir, INTENT_FILE);
  const intent = parseIntent(intentText, intentPath);
  const activePath = join(memoryDir, LEARNINGS_FILE);
  const archivePath = join(memoryDir, ARCHIVE_FILE);
  validateLearningScopeMigrationReplacement(activePath, intent.targets.active);
  validateLearningScopeMigrationReplacement(archivePath, intent.targets.archive);
  await verifyBackup(join(memoryDir, ACTIVE_BACKUP_FILE), intent.targets.active.source, false);
  await verifyBackup(join(memoryDir, ARCHIVE_BACKUP_FILE), intent.targets.archive.source, false);
  await classifyTarget(activePath, intent.targets.active);
  await classifyTarget(archivePath, intent.targets.archive);

  const archiveReplaced = await publishReplacement(archivePath, intent.targets.archive);
  if (archiveReplaced) hooks?.afterCheckpoint?.("archive-replaced");
  await publishReplacement(activePath, intent.targets.active);

  if ((await classifyTarget(archivePath, intent.targets.archive)) !== "replacement") {
    throw new LearningScopeMigrationError(
      "Archive migration replacement did not persist.",
      archivePath,
    );
  }
  if ((await classifyTarget(activePath, intent.targets.active)) !== "replacement") {
    throw new LearningScopeMigrationError(
      "Active migration replacement did not persist.",
      activePath,
    );
  }

  const marker: LearningScopeMigrationMarkerV1 = {
    version: VERSION,
    intentSha256: sha256(intentText),
    completedAt: new Date().toISOString(),
    expectedBackups: {
      active: intent.targets.active.source.exists,
      archive: intent.targets.archive.source.exists,
    },
    counts: intent.counts,
  };
  const markerPath = join(memoryDir, MARKER_FILE);
  const markerText = jsonText(marker);
  const created = await createFileAtomically(markerPath, markerText);
  if (created === "exists") {
    const existing = await readOptionalText(markerPath);
    if (existing !== markerText) {
      throw new LearningScopeMigrationError(
        `Migration marker already exists: ${markerPath}`,
        markerPath,
      );
    }
  }
  reportMigrationCounts(intent.counts);
}

async function prepareFreshMigration(memoryDir: string, hooks?: MigrationTestHooks): Promise<void> {
  const activePath = join(memoryDir, LEARNINGS_FILE);
  const archivePath = join(memoryDir, ARCHIVE_FILE);
  const [activeSource, archiveSource] = await Promise.all([
    loadLearningSourceForMutation(activePath),
    loadLearningSourceForMutation(archivePath),
  ]);
  const active = parseMigrationTarget(activePath, activeSource);
  const archive = parseMigrationTarget(archivePath, archiveSource);
  const counts = emptyCounts();
  const [backup, summaries] = await Promise.all([
    loadOptionalHistory(join(memoryDir, OPTIONAL_HISTORY_FILE), counts),
    listSummaries(memoryDir),
  ]);
  const summaryIndex = buildSummaryIndex(summaries);
  const activeEntries = migrateEntries(
    active.entries,
    "active",
    summaryIndex,
    backup,
    archive.entries,
    counts,
  );
  const archiveEntries = migrateEntries(
    archive.entries,
    "archive",
    summaryIndex,
    backup,
    archive.entries,
    counts,
  );
  const activeReplacement = active.exists
    ? renderValidatedLearnings(activePath, activeEntries)
    : undefined;
  const archiveReplacement = archive.exists
    ? renderValidatedLearnings(archivePath, archiveEntries)
    : undefined;
  const intent: LearningScopeMigrationIntentV1 = {
    version: VERSION,
    targets: {
      active: targetIntent(activeSource, activeReplacement),
      archive: targetIntent(archiveSource, archiveReplacement),
    },
    counts,
  };
  const intentText = jsonText(intent);

  await ensureBackup(join(memoryDir, ACTIVE_BACKUP_FILE), activeSource);
  await ensureBackup(join(memoryDir, ARCHIVE_BACKUP_FILE), archiveSource);

  const currentActive = await loadLearningSourceForMutation(activePath);
  const currentArchive = await loadLearningSourceForMutation(archivePath);
  if (
    !Bun.deepEquals(currentActive, activeSource) ||
    !Bun.deepEquals(currentArchive, archiveSource)
  ) {
    throw new LearningScopeMigrationError("Learning storage changed during migration preparation.");
  }
  await verifyBackup(join(memoryDir, ACTIVE_BACKUP_FILE), intent.targets.active.source, true);
  await verifyBackup(join(memoryDir, ARCHIVE_BACKUP_FILE), intent.targets.archive.source, true);

  const intentPath = join(memoryDir, INTENT_FILE);
  const created = await createFileAtomically(intentPath, intentText);
  if (created === "exists") {
    const existing = await readOptionalText(intentPath);
    if (existing !== intentText) {
      throw new LearningScopeMigrationError(
        `Migration intent already exists: ${intentPath}`,
        intentPath,
      );
    }
  }
  hooks?.afterCheckpoint?.("intent-published");
  await replayPreparedIntent(memoryDir, intentText, hooks);
}

/** Establish v1 scope-migration readiness while the caller holds the learning lock. */
export async function ensureLegacyScopeMigratedUnderLock(
  memoryDir: string,
  hooks?: MigrationTestHooks,
): Promise<void> {
  const markerPath = join(memoryDir, MARKER_FILE);
  const markerText = await readOptionalText(markerPath);
  if (markerText !== undefined) {
    parseMarker(markerText, markerPath);
    return;
  }

  const intentPath = join(memoryDir, INTENT_FILE);
  const intentText = await readOptionalText(intentPath);
  if (intentText !== undefined) {
    await replayPreparedIntent(memoryDir, intentText, hooks);
    return;
  }
  await prepareFreshMigration(memoryDir, hooks);
}
