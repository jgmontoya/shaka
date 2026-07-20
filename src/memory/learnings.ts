/**
 * Core learnings module: types, parsing, rendering, storage, scoring,
 * selection, undo-and-rewrite, merge, promotion, extraction prompts,
 * quality assessment, and filtering.
 *
 * A learning is a reusable insight extracted from session transcripts —
 * corrections, preferences, patterns, or facts worth persisting.
 * Stored in a single markdown file with HTML comment metadata per entry.
 *
 * See also: consolidation.ts for duplicate/contradiction detection.
 */

import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectLearningFileStatus } from "./learning-file";
import { type DirectoryLockOptions, withDirectoryLock } from "./lock";
import { arePathsRelated, hashSessionId } from "./utils";

// --- Types ---

export type LearningCategory = "correction" | "preference" | "pattern" | "fact";

const VALID_CATEGORIES = new Set<string>(["correction", "preference", "pattern", "fact"]);

export interface Exposure {
  readonly date: string; // YYYY-MM-DD
  readonly sessionHash: string; // first 8 chars of SHA-256(sessionId)
}

export type PromotionReason = "automatic-cross-project-threshold" | "manual-cross-project-review";

export interface PromotionEvidence {
  readonly sourceCwds: readonly string[];
  readonly exposures: readonly Exposure[];
  readonly reasons: readonly PromotionReason[];
}

export type LearningDiagnosticCode =
  | "malformed-learning-record"
  | "malformed-promotion-metadata"
  | "duplicate-promotion-metadata";

export interface LearningDiagnostic {
  readonly code: LearningDiagnosticCode;
  readonly title?: string;
  readonly message: string;
}

export interface ParsedLearningsDocument {
  readonly entries: LearningEntry[];
  readonly diagnostics: LearningDiagnostic[];
}

export interface LearningEntry {
  readonly category: LearningCategory;
  readonly cwds: string[]; // absolute paths, or ["*"] for global
  readonly exposures: Exposure[]; // ordered: first = creation, last = most recent
  readonly nonglobal: boolean; // user opted out of global promotion
  readonly title: string;
  readonly body: string; // 1-3 sentences
  readonly promotionEvidence?: PromotionEvidence;
}

// --- Scoring constants ---

const DEFAULT_RECENCY_WINDOW_DAYS = 90;
const REINFORCEMENT_SATURATE = 4;
const DEFAULT_BUDGET = 6000;

// --- Parsing ---

const METADATA_RE =
  /^<!--\s*(\w+)\s*\|\s*cwd:\s*(.+?)\s*\|\s*exposures:\s*(.+?)(?:\s*\|\s*nonglobal)?\s*-->$/;
const TITLE_CANDIDATE_RE = /^###(?:\s|$)/;
const PRIMARY_METADATA_CATEGORY_RE = /^<!--\s*(?:correction|preference|pattern|fact)\b/;
const PRIMARY_METADATA_SHAPE_RE = /^<!--\s*\w+\s*\|/;
const PRIMARY_METADATA_FIELD_RE = /\b(?:cwd|exposures)\s*:/;
const PROMOTION_CANDIDATE_RE = /^<!--\s*promotion\b/i;
const PROMOTION_PREFIX = "<!-- promotion: ";
const PROMOTION_SUFFIX = " -->";
const PROMOTION_REASON_ORDER: readonly PromotionReason[] = [
  "automatic-cross-project-threshold",
  "manual-cross-project-review",
];
const PROMOTION_REASONS = new Set<PromotionReason>(PROMOTION_REASON_ORDER);
const PROMOTION_EVIDENCE_KEYS = new Set(["sourceCwds", "exposures", "reasons"]);

function isNonglobal(line: string): boolean {
  return /\|\s*nonglobal\s*-->$/.test(line);
}

function isPrimaryMetadataCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("<!--")) return false;
  return (
    PRIMARY_METADATA_CATEGORY_RE.test(trimmed) ||
    PRIMARY_METADATA_SHAPE_RE.test(trimmed) ||
    PRIMARY_METADATA_FIELD_RE.test(trimmed)
  );
}

function isPromotionMetadataCandidate(line: string): boolean {
  return PROMOTION_CANDIDATE_RE.test(line.trim());
}

function parseExposures(raw: string): Exposure[] | undefined {
  const exposures: Exposure[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    const atIndex = trimmed.indexOf("@");
    if (atIndex <= 0 || atIndex === trimmed.length - 1) return undefined;

    const date = trimmed.slice(0, atIndex);
    const sessionHash = trimmed.slice(atIndex + 1);
    exposures.push({ date, sessionHash });
  }
  return exposures;
}

function parseCwds(raw: string): string[] | undefined {
  const cwds = raw.split(",").map((cwd) => cwd.trim());
  return cwds.every(Boolean) ? cwds : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExposure(value: unknown): value is Exposure {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    value.date.length > 0 &&
    typeof value.sessionHash === "string" &&
    value.sessionHash.length > 0
  );
}

function isPromotionReason(value: unknown): value is PromotionReason {
  return typeof value === "string" && PROMOTION_REASONS.has(value as PromotionReason);
}

function toPromotionEvidence(value: unknown): PromotionEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !PROMOTION_EVIDENCE_KEYS.has(key))) return undefined;

  const { sourceCwds, exposures, reasons } = value;
  if (
    !Array.isArray(sourceCwds) ||
    sourceCwds.length === 0 ||
    !sourceCwds.every((cwd) => typeof cwd === "string" && cwd.length > 0) ||
    !Array.isArray(exposures) ||
    exposures.length === 0 ||
    !exposures.every(isExposure) ||
    !Array.isArray(reasons) ||
    reasons.length === 0 ||
    !reasons.every(isPromotionReason)
  ) {
    return undefined;
  }

  return {
    sourceCwds: [...sourceCwds],
    exposures: exposures.map((exposure) => ({ ...exposure })),
    reasons: [...reasons],
  };
}

interface ParsedPromotionEvidence {
  readonly evidence?: PromotionEvidence;
  readonly diagnosticCode?: LearningDiagnosticCode;
}

function parsePromotionEvidence(lines: string[]): ParsedPromotionEvidence {
  const comments = lines
    .map((line) => line.trim())
    .filter((line) => PROMOTION_CANDIDATE_RE.test(line));
  if (comments.length === 0) return {};
  if (comments.length > 1) return { diagnosticCode: "duplicate-promotion-metadata" };

  const comment = comments[0];
  if (!comment?.startsWith(PROMOTION_PREFIX) || !comment.endsWith(PROMOTION_SUFFIX)) {
    return { diagnosticCode: "malformed-promotion-metadata" };
  }

  try {
    const evidence = toPromotionEvidence(
      JSON.parse(comment.slice(PROMOTION_PREFIX.length, -PROMOTION_SUFFIX.length)),
    );
    return evidence ? { evidence } : { diagnosticCode: "malformed-promotion-metadata" };
  } catch {
    return { diagnosticCode: "malformed-promotion-metadata" };
  }
}

function renderPromotionEvidence(evidence: PromotionEvidence): string {
  const json = JSON.stringify(evidence).replaceAll("--", "\\u002d\\u002d");
  return `${PROMOTION_PREFIX}${json}${PROMOTION_SUFFIX}`;
}

interface ParsedLearningBlock {
  readonly entry?: LearningEntry;
  readonly diagnostics: LearningDiagnostic[];
}

function malformedLearningRecord(title?: string): ParsedLearningBlock {
  return {
    diagnostics: [
      {
        code: "malformed-learning-record",
        ...(title ? { title } : {}),
        message: title
          ? `Learning "${title}" has malformed primary metadata.`
          : "Learning record has malformed primary metadata or title.",
      },
    ],
  };
}

function orphanedLearningContent(): LearningDiagnostic {
  return {
    code: "malformed-learning-record",
    message: "Learning storage contains content outside a complete learning record.",
  };
}

function isLearningsPreamble(block: string): boolean {
  return block.trim().split("\n")[0]?.trim() === "# Learnings";
}

interface ParsedPrimaryMetadata {
  readonly category: LearningCategory;
  readonly cwds: string[];
  readonly exposures: Exposure[];
  readonly nonglobal: boolean;
}

function parsePrimaryMetadata(lines: string[]): ParsedPrimaryMetadata | undefined {
  const candidates = lines.filter(isPrimaryMetadataCandidate);
  if (candidates.length !== 1) return undefined;

  const line = candidates[0];
  const match = line?.trim().match(METADATA_RE);
  if (!line || !match) return undefined;

  const [, category, rawCwds, rawExposures] = match;
  if (!category || !rawCwds || !rawExposures || !VALID_CATEGORIES.has(category)) return undefined;

  const cwds = parseCwds(rawCwds);
  const exposures = parseExposures(rawExposures);
  if (!cwds || !exposures) return undefined;

  return {
    category: category as LearningCategory,
    cwds,
    exposures,
    nonglobal: isNonglobal(line.trim()),
  };
}

function parseBlock(block: string): ParsedLearningBlock | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  const titleIndex = lines.findIndex((line) => TITLE_CANDIDATE_RE.test(line.trim()));
  const metadataLines = lines.slice(0, titleIndex === -1 ? lines.length : titleIndex);
  const entryLike =
    titleIndex !== -1 ||
    metadataLines.some(isPrimaryMetadataCandidate) ||
    metadataLines.some(isPromotionMetadataCandidate);
  if (!entryLike) return null;
  if (titleIndex === -1) return malformedLearningRecord();

  const title = lines[titleIndex]?.trim().slice(4).trim();
  const metadata = parsePrimaryMetadata(metadataLines);
  if (!title || !metadata) return malformedLearningRecord(title || undefined);

  const body = lines
    .slice(titleIndex + 1)
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();
  const promotion = parsePromotionEvidence(metadataLines);
  const diagnostics: LearningDiagnostic[] = promotion.diagnosticCode
    ? [
        {
          code: promotion.diagnosticCode,
          title,
          message:
            promotion.diagnosticCode === "duplicate-promotion-metadata"
              ? `Learning "${title}" contains more than one promotion metadata record.`
              : `Learning "${title}" contains malformed promotion metadata.`,
        },
      ]
    : [];

  return {
    entry: {
      category: metadata.category,
      cwds: metadata.cwds,
      exposures: metadata.exposures,
      nonglobal: metadata.nonglobal,
      title,
      body,
      ...(promotion.evidence ? { promotionEvidence: promotion.evidence } : {}),
    },
    diagnostics,
  };
}

/** Parse learnings storage into tolerant domain entries plus loss-bearing diagnostics. */
export function parseLearningsDocument(content: string): ParsedLearningsDocument {
  if (!content.trim()) return { entries: [], diagnostics: [] };

  const entries: LearningEntry[] = [];
  const diagnostics: LearningDiagnostic[] = [];
  let seenNonEmptyBlock = false;

  for (const block of content.split(/^---$/m)) {
    if (!block.trim()) continue;

    const isFirstNonEmptyBlock = !seenNonEmptyBlock;
    seenNonEmptyBlock = true;
    const parsed = parseBlock(block);
    if (!parsed) {
      if (isFirstNonEmptyBlock && isLearningsPreamble(block)) continue;
      diagnostics.push(orphanedLearningContent());
      continue;
    }
    if (parsed.entry) entries.push(parsed.entry);
    diagnostics.push(...parsed.diagnostics);
  }

  return { entries, diagnostics };
}

/** Parse learnings.md content into structured entries for tolerant read-only use. */
export function parseLearnings(content: string): LearningEntry[] {
  return parseLearningsDocument(content).entries;
}

// --- Rendering ---

/**
 * Render an entry for LLM context injection — title and body only, no metadata.
 * The HTML comment carries bookkeeping (category, cwds, exposures) used by the
 * parser and scorer; injecting it would just spend tokens on opaque session
 * hashes and absolute paths the model can't act on.
 */
export function renderEntryForContext(entry: LearningEntry): string {
  const title = `### ${entry.title}`;
  return entry.body ? `${title}\n\n${entry.body}` : title;
}

/**
 * Render an entry for on-disk storage in `learnings.md`.
 * The metadata comment is load-bearing — `parseLearnings` round-trips through it.
 */
export function renderEntry(entry: LearningEntry): string {
  const cwdStr = entry.cwds.join(", ");
  const exposuresStr = entry.exposures.map((e) => `${e.date}@${e.sessionHash}`).join(",");
  const nonglobalStr = entry.nonglobal ? " | nonglobal" : "";

  const meta = `<!-- ${entry.category} | cwd: ${cwdStr} | exposures: ${exposuresStr}${nonglobalStr} -->`;
  const promotionMeta = entry.promotionEvidence
    ? `\n${renderPromotionEvidence(entry.promotionEvidence)}`
    : "";
  return `${meta}${promotionMeta}\n\n${renderEntryForContext(entry)}`;
}

/** Render entries into a complete learnings.md file. */
export function renderLearnings(entries: LearningEntry[]): string {
  const header = "# Learnings\n\nAutomatically captured preferences, corrections, and patterns.";

  if (entries.length === 0) return `${header}\n`;

  const rendered = entries.map(renderEntry).join("\n\n---\n\n");
  return `${header}\n\n---\n\n${rendered}\n`;
}

// --- Storage ---

const LEARNINGS_FILE = "learnings.md";

export interface LoadedLearningsDocument extends ParsedLearningsDocument {
  readonly sourceText: string;
}

export class LearningsIntegrityError extends Error {
  readonly filePath: string;
  readonly diagnostics: readonly LearningDiagnostic[];

  constructor(filePath: string, diagnostics: readonly LearningDiagnostic[]) {
    const details = diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    super(`Cannot rewrite ${filePath}: invalid learning storage. ${details}`);
    this.name = "LearningsIntegrityError";
    this.filePath = filePath;
    this.diagnostics = diagnostics;
  }
}

export class LearningsStoragePathError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`Cannot rewrite ${filePath}: ${message}`);
    this.name = "LearningsStoragePathError";
    this.filePath = filePath;
  }
}

function learningEntriesEqual(left: LearningEntry[], right: LearningEntry[]): boolean {
  return left.length === right.length && Bun.deepEquals(left, right);
}

function renderValidatedLearnings(filePath: string, entries: LearningEntry[]): string {
  const content = renderLearnings(entries);
  const parsed = parseLearningsDocument(content);
  if (parsed.diagnostics.length > 0) {
    throw new LearningsIntegrityError(filePath, parsed.diagnostics);
  }
  if (!learningEntriesEqual(parsed.entries, entries)) {
    throw new LearningsIntegrityError(filePath, [
      {
        code: "malformed-learning-record",
        message: "Replacement learning records cannot be represented without data loss.",
      },
    ]);
  }
  return content;
}

/** Reject entries that the Markdown storage format cannot round-trip losslessly. */
export function assertLearningsRepresentable(filePath: string, entries: LearningEntry[]): void {
  renderValidatedLearnings(filePath, entries);
}

async function writeLearningFileAtomically(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.tmp.${process.pid}`);
  await Bun.write(tmpPath, content);
  await rename(tmpPath, filePath);
}

async function loadLearningsDocument(filePath: string): Promise<LoadedLearningsDocument> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return { sourceText: "", entries: [], diagnostics: [] };

  const sourceText = await file.text();
  return { sourceText, ...parseLearningsDocument(sourceText) };
}

async function loadDocumentForMutation(filePath: string): Promise<LoadedLearningsDocument> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind === "missing") return { sourceText: "", entries: [], diagnostics: [] };
  if (status.kind === "invalid") throw new LearningsStoragePathError(filePath, status.message);

  let sourceText: string;
  try {
    sourceText = await Bun.file(filePath).text();
  } catch {
    throw new LearningsStoragePathError(filePath, "Learning storage file could not be read.");
  }

  const document = { sourceText, ...parseLearningsDocument(sourceText) };
  if (document.diagnostics.length > 0) {
    throw new LearningsIntegrityError(filePath, document.diagnostics);
  }
  return document;
}

/**
 * Load a lossless, validated snapshot for a mutation workflow.
 * Callers performing read-modify-write must hold the learnings lock.
 */
export async function loadLearningsForMutation(
  memoryDir: string,
): Promise<LoadedLearningsDocument> {
  return await loadDocumentForMutation(join(memoryDir, LEARNINGS_FILE));
}

/** Read and parse learnings from disk. Returns empty array if file missing. */
export async function loadLearnings(memoryDir: string): Promise<LearningEntry[]> {
  try {
    return (await loadLearningsDocument(join(memoryDir, LEARNINGS_FILE))).entries;
  } catch {
    return [];
  }
}

/**
 * Write the full learnings file atomically (temp file + rename).
 * Prevents data loss from crashes during write.
 */
export async function writeLearnings(memoryDir: string, entries: LearningEntry[]): Promise<void> {
  await loadLearningsForMutation(memoryDir);
  await mkdir(memoryDir, { recursive: true });

  const filePath = join(memoryDir, LEARNINGS_FILE);
  const content = renderValidatedLearnings(filePath, entries);
  await writeLearningFileAtomically(filePath, content);
}

/** Run an operation while holding the process-shared learnings lock. */
export async function withLearningsLock<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  lockOptions?: DirectoryLockOptions,
): Promise<T> {
  await mkdir(memoryDir, { recursive: true });
  return await withDirectoryLock(join(memoryDir, ".learnings.lock"), operation, lockOptions);
}

/** Serialize a complete learnings read-modify-write transaction. */
export async function mutateLearnings(
  memoryDir: string,
  mutation: (entries: LearningEntry[]) => LearningEntry[] | Promise<LearningEntry[]>,
  lockOptions?: DirectoryLockOptions,
): Promise<LearningEntry[]> {
  return await withLearningsLock(
    memoryDir,
    async () => {
      const { entries } = await loadLearningsForMutation(memoryDir);
      const updated = await mutation(entries);
      await writeLearnings(memoryDir, updated);
      return updated;
    },
    lockOptions,
  );
}

/** Replace a previously read snapshot only if no concurrent mutation changed it. */
export async function replaceLearningsIfUnchanged(
  memoryDir: string,
  expected: LearningEntry[],
  replacement: LearningEntry[],
  beforeWrite?: () => Promise<void>,
): Promise<boolean> {
  return await withLearningsLock(memoryDir, async () => {
    const { entries: current } = await loadLearningsForMutation(memoryDir);
    if (!learningEntriesEqual(current, expected)) return false;

    const filePath = join(memoryDir, LEARNINGS_FILE);
    const content = renderValidatedLearnings(filePath, replacement);
    await beforeWrite?.();
    await loadDocumentForMutation(filePath);
    await writeLearningFileAtomically(filePath, content);
    return true;
  });
}

export interface LearningRemovalResult {
  readonly removed: boolean;
  readonly entries: LearningEntry[];
}

/** Remove exactly one reviewed entry, provided its persisted representation has not changed. */
export async function removeLearningIfUnchanged(
  memoryDir: string,
  expected: LearningEntry,
): Promise<LearningRemovalResult> {
  const expectedContent = renderEntry(expected);
  let removed = false;
  const entries = await mutateLearnings(memoryDir, (current) => {
    const index = current.findIndex((entry) => renderEntry(entry) === expectedContent);
    if (index === -1) return current;
    removed = true;
    return current.toSpliced(index, 1);
  });
  return { removed, entries };
}

// --- Scoring ---

function daysBetween(dateStr: string, now: Date, windowDays: number): number {
  const date = new Date(dateStr);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return windowDays;
  return Math.max(0, (now.getTime() - ms) / (1000 * 60 * 60 * 24));
}

function recencyScore(entry: LearningEntry, now: Date, windowDays: number): number {
  if (windowDays <= 0) return 0;
  if (entry.exposures.length === 0) return 0;
  const lastExposure = entry.exposures[entry.exposures.length - 1];
  if (!lastExposure) return 0;
  const days = daysBetween(lastExposure.date, now, windowDays);
  return Math.max(0, 1.0 - days / windowDays);
}

function reinforcementScore(entry: LearningEntry): number {
  return Math.min((entry.exposures.length - 1) / REINFORCEMENT_SATURATE, 1.0);
}

export function matchesCwd(entry: LearningEntry, cwd: string): boolean {
  if (entry.cwds.includes("*")) return true;
  return entry.cwds.some((entryCwd) => arePathsRelated(entryCwd, cwd));
}

/** Score a single entry for context loading. Range: 0.0 to 2.0. */
export function scoreEntry(
  entry: LearningEntry,
  now = new Date(),
  recencyWindowDays = DEFAULT_RECENCY_WINDOW_DAYS,
): number {
  return recencyScore(entry, now, recencyWindowDays) + reinforcementScore(entry);
}

/** Select entries for context loading within a character budget. */
export function selectLearnings(
  entries: LearningEntry[],
  cwd: string,
  budget = DEFAULT_BUDGET,
  recencyWindowDays = DEFAULT_RECENCY_WINDOW_DAYS,
): LearningEntry[] {
  // Pre-filter: only global entries and CWD-matching entries are candidates.
  // Scoped entries for unrelated projects are excluded before scoring
  const relevant = entries.filter((e) => matchesCwd(e, cwd));

  const now = new Date();
  const scored = relevant
    .map((entry) => ({ entry, score: scoreEntry(entry, now, recencyWindowDays) }))
    .sort((a, b) => b.score - a.score);

  const selected: LearningEntry[] = [];
  let chars = 0;

  for (const { entry } of scored) {
    // Probe against the context render — that's what actually ships to the LLM,
    // and the budget should reflect the real injection size.
    const size = renderEntryForContext(entry).length;
    if (chars + size > budget && selected.length > 0) break;
    selected.push(entry);
    chars += size;
  }

  return selected;
}

// --- Undo-and-Rewrite (opencode dedup) ---

/**
 * Remove all contributions from a specific session hash.
 * - Entries where this session is the ONLY exposure -> removed entirely
 * - Entries with multiple exposures -> this session's exposure removed
 */
export function undoSessionLearnings(
  entries: LearningEntry[],
  sessionHash: string,
): LearningEntry[] {
  return entries.reduce<LearningEntry[]>((acc, entry) => {
    const hasSession = entry.exposures.some((e) => e.sessionHash === sessionHash);
    if (!hasSession) {
      acc.push(entry);
      return acc;
    }

    const remaining = entry.exposures.filter((e) => e.sessionHash !== sessionHash);
    if (remaining.length === 0) return acc;

    acc.push({ ...entry, exposures: remaining });
    return acc;
  }, []);
}

// --- Reinforcement ---

/** Merge learning scopes while preserving global scope as the canonical form. */
export function mergeLearningCwds(...groups: readonly (readonly string[])[]): string[] {
  const merged = [...new Set(groups.flat())];
  return merged.includes("*") ? ["*"] : merged;
}

/** Combine the evidence supporting a global learning into one deterministic snapshot. */
export function mergePromotionEvidence(
  ...items: readonly (PromotionEvidence | undefined)[]
): PromotionEvidence | undefined {
  const evidence = items.filter((item): item is PromotionEvidence => item !== undefined);
  if (evidence.length === 0) return undefined;
  if (evidence.length === 1) {
    const [item] = evidence;
    if (!item) return undefined;
    return {
      sourceCwds: [...item.sourceCwds],
      exposures: item.exposures.map((exposure) => ({ ...exposure })),
      reasons: [...item.reasons],
    };
  }

  const sourceCwds = [...new Set(evidence.flatMap((item) => item.sourceCwds))].sort();
  const exposuresByKey = new Map<string, Exposure>();
  for (const exposure of evidence.flatMap((item) => item.exposures)) {
    exposuresByKey.set(`${exposure.date}@${exposure.sessionHash}`, { ...exposure });
  }
  const exposures = [...exposuresByKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sessionHash.localeCompare(b.sessionHash),
  );
  const presentReasons = new Set(evidence.flatMap((item) => item.reasons));
  const reasons = PROMOTION_REASON_ORDER.filter((reason) => presentReasons.has(reason));

  return { sourceCwds, exposures, reasons };
}

/**
 * Merge new learnings into existing ones.
 * Exact title match -> reinforce (add exposure, union CWDs).
 * No match -> append as new entry.
 */
export function mergeNewLearnings(
  existing: LearningEntry[],
  extracted: LearningEntry[],
): LearningEntry[] {
  const result = [...existing];

  for (const newEntry of extracted) {
    const matchIndex = result.findIndex((e) => e.title === newEntry.title);

    if (matchIndex === -1) {
      result.push(newEntry);
      continue;
    }

    const match = result[matchIndex];
    if (!match) continue;

    const mergedCwds = mergeLearningCwds(match.cwds, newEntry.cwds);
    const mergedExposures = [...match.exposures, ...newEntry.exposures];
    const promotionEvidence = mergePromotionEvidence(
      match.promotionEvidence,
      newEntry.promotionEvidence,
    );

    result[matchIndex] = {
      ...match,
      cwds: mergedCwds,
      exposures: mergedExposures,
      ...(promotionEvidence ? { promotionEvidence } : {}),
    };
  }

  return result;
}

// --- Shared quality criteria ---

/**
 * Single source of truth for what makes a learning worth keeping.
 * Used by both extraction (session-end) and quality assessment (review --prune).
 */

const QUALITY_GATES = `\
- NON-OBVIOUS: Would an experienced engineer or LLM get this wrong without being told?
- RECURRING: Will this exact situation come up again in a future session?
- BEHAVIOR-CHANGING: Would it change the LLM's default behavior? Vague truisms ("validate early") don't — but project-specific gotchas do, even if narrow.`;

const LOW_QUALITY_PATTERNS = `\
- General engineering wisdom (DRY, test through public interfaces, validate early, etc.)
- One-time code review findings — the fix is now in the code, the learning is redundant
- Architectural descriptions of how a codebase works — these belong in project docs, not learnings
- Meta-observations about your own reasoning process or approach
- Process advice (how to plan, how to review, how to evaluate ideas)
- Patterns that any senior engineer would apply without being told
- Information already in the project's config files, README, or CLAUDE.md
- Speculative observations without clear evidence in the transcript
- One-time debugging steps or decisions that won't recur`;

const HIGH_QUALITY_PATTERNS = `\
- User corrections where the LLM got something wrong ("no, do X instead of Y")
- Stated user preferences ("I always want X", "never do Y")
- Non-obvious project conventions that contradict common defaults
- Environment gotchas that would cause real bugs (wrong units, surprising config values)
- Framework/library behaviors that are counterintuitive or version-specific`;

// --- Extraction (session-end) ---

/**
 * Build the learnings extraction section for the summarization prompt.
 * Includes existing titles for exact-match reuse instruction.
 */
export function buildExtractionPromptSection(existingTitles: string[]): string {
  const titlesBlock =
    existingTitles.length > 0
      ? existingTitles.map((t) => `- ${t}`).join("\n")
      : "No existing learnings yet.";

  return `
7. Reusable learnings: corrections, preferences, patterns, and environment facts worth
   persisting for future sessions. Return 0-2 learnings. Most sessions should have 0.

The bar for extraction is HIGH. A learning must pass ALL three tests:
${QUALITY_GATES}

If a candidate fails ANY test, do not extract it.

Do NOT extract:
${LOW_QUALITY_PATTERNS}

DO extract:
${HIGH_QUALITY_PATTERNS}

If a learning matches an existing entry below, use its EXACT title
character-for-character (this enables automatic reinforcement tracking):

${titlesBlock}

If nothing in the transcript is worth persisting, return an empty Learnings section.
The default is 0 learnings. Extract only when something genuinely surprising was learned.

Format learnings as:

## Learnings

### (category) Title

Body text (1-3 sentences).

Where category is one of: correction, preference, pattern, fact`;
}

/**
 * Parse learnings from the inference output's ## Learnings section.
 * Attaches session metadata to each extracted entry.
 */
export function parseExtractedLearnings(
  raw: string,
  metadata: { date: string; cwd: string; sessionHash: string },
): LearningEntry[] {
  // Find the ## Learnings section
  const learningsMatch = raw.match(/^## Learnings\s*$/m);
  if (!learningsMatch || learningsMatch.index === undefined) return [];

  const learningsSection = raw.slice(learningsMatch.index + learningsMatch[0].length);

  // Split on ### headings
  const entryBlocks = learningsSection.split(/^### /m).filter((b) => b.trim());

  const entries: LearningEntry[] = [];

  for (const block of entryBlocks) {
    const lines = block.trim().split("\n");
    const headerLine = lines[0];
    if (!headerLine) continue;

    // Parse (category) title
    const headerMatch = headerLine.match(/^\((\w+)\)\s+(.+)$/);
    if (!headerMatch) continue;

    const [, categoryStr, title] = headerMatch;
    if (!categoryStr || !title) continue;
    if (!VALID_CATEGORIES.has(categoryStr)) continue;

    const body = lines.slice(1).join("\n").trim();

    entries.push({
      category: categoryStr as LearningCategory,
      cwds: [metadata.cwd],
      exposures: [{ date: metadata.date, sessionHash: metadata.sessionHash }],
      nonglobal: false,
      title: title.trim(),
      body,
    });
  }

  return entries;
}

// --- Promotion ---

const PROMOTION_CWD_THRESHOLD = 3;

/** Find entries eligible for CWD-to-global promotion. */
export function findPromotionCandidates(entries: LearningEntry[]): LearningEntry[] {
  return entries.filter(
    (e) => !e.nonglobal && !e.cwds.includes("*") && e.cwds.length >= PROMOTION_CWD_THRESHOLD,
  );
}

/** Promote an entry to global while preserving the evidence for its former scope. */
export function promoteToGlobal(
  entry: LearningEntry,
  reason: PromotionReason,
): LearningEntry & { readonly promotionEvidence: PromotionEvidence } {
  const promotionEvidence = entry.promotionEvidence ?? {
    sourceCwds: [...entry.cwds],
    exposures: entry.exposures.map((exposure) => ({ ...exposure })),
    reasons: [reason],
  };

  return { ...entry, cwds: ["*"], promotionEvidence };
}

/** Mark an entry as nonglobal to prevent future promotion prompts. */
export function markNonglobal(entry: LearningEntry): LearningEntry {
  return { ...entry, nonglobal: true };
}

// --- Quality Assessment (review --prune) ---

export interface QualityVerdict {
  readonly index: number; // 0-based
  readonly reason: string;
}

/** Build prompt for AI quality assessment. Returns indices of low-quality entries. */
export function buildQualityAssessmentPrompt(entries: LearningEntry[]): string {
  const numbered = entries
    .map(
      (e, i) =>
        `[${i + 1}] (${e.category}) ${e.title} [${e.exposures.length} exposure(s)]\n${e.body}`,
    )
    .join("\n\n");

  return `Evaluate each learning entry for future-session utility. Flag entries that are LOW QUALITY.

A learning is low quality if it fails ANY of these tests:
${QUALITY_GATES}

Common low-quality patterns:
${LOW_QUALITY_PATTERNS}

High-quality entries to KEEP (do NOT flag these):
${HIGH_QUALITY_PATTERNS}

## Entries

${numbered}

## Instructions

For each LOW QUALITY entry, output one line:
LOW [N] — reason (one sentence)

If all entries are high quality, output exactly:
ALL HIGH QUALITY

Do not modify any entry. Only flag entries you are confident are low quality.`;
}

/** Parse quality assessment output into verdicts. Returns 0-based indices. */
export function parseQualityAssessmentOutput(raw: string): QualityVerdict[] {
  if (raw.trim() === "ALL HIGH QUALITY") return [];

  const verdicts: QualityVerdict[] = [];
  const lineRe = /^LOW\s*\[(\d+)\]\s*[-–—]\s*(.+)$/;

  for (const line of raw.split("\n")) {
    const match = line.trim().match(lineRe);
    if (!match) continue;

    const index = Number.parseInt(match[1] ?? "", 10) - 1;
    const reason = match[2]?.trim() ?? "";
    if (!(index >= 0) || !reason) continue;

    verdicts.push({ index, reason });
  }

  return verdicts;
}

// --- Ranking (auto-prune) ---

/**
 * Build prompt to rank pre-filtered entries by quality for auto-pruning.
 * Caller is responsible for filtering (CWD, exposure count, age).
 * Uses the same quality criteria as buildQualityAssessmentPrompt.
 *
 * Returns null if entries is empty.
 */
export function buildRankingPrompt(entries: LearningEntry[]): string | null {
  if (entries.length === 0) return null;

  const numbered = entries
    .map(
      (e, i) =>
        `[${i + 1}] (${e.category}) ${e.title} [${e.exposures.length} exposure(s)]\n${e.body}`,
    )
    .join("\n\n");

  return `Rank these entries from LOWEST to HIGHEST future-session utility.

A learning is low quality if it fails ANY of these tests:
${QUALITY_GATES}

Common low-quality patterns:
${LOW_QUALITY_PATTERNS}

High-quality entries — do NOT include these in the ranking:
${HIGH_QUALITY_PATTERNS}

## Entries

${numbered}

## Instructions

List ONLY entries that fail at least one quality test, ranked from worst to least-worst:
RANK 1 [N] — reason (which quality test it fails)
RANK 2 [N] — reason
...

If all entries pass all quality tests, output exactly:
ALL ACCEPTABLE`;
}

/**
 * Parse ranking output into verdicts sorted by rank (worst first).
 * Returns 0-based indices. Sorts by the RANK number rather than
 * trusting LLM line ordering.
 */
export function parseRankingOutput(raw: string): QualityVerdict[] {
  if (raw.trim() === "ALL ACCEPTABLE") return [];

  const parsed: { rank: number; index: number; reason: string }[] = [];
  const lineRe = /^RANK\s+(\d+)\s*\[(\d+)\]\s*[-–—]\s*(.+)$/;

  for (const line of raw.split("\n")) {
    const match = line.trim().match(lineRe);
    if (!match) continue;

    const rank = Number.parseInt(match[1] ?? "", 10);
    const index = Number.parseInt(match[2] ?? "", 10) - 1;
    const reason = match[3]?.trim() ?? "";
    if (Number.isNaN(rank) || !(index >= 0) || !reason) continue;

    parsed.push({ rank, index, reason });
  }

  return parsed.sort((a, b) => a.rank - b.rank).map(({ index, reason }) => ({ index, reason }));
}

// --- Filtering ---

/** Filter entries by free-text query. Global entries always included. */
export function filterLearnings(entries: LearningEntry[], query: string): LearningEntry[] {
  if (!query || query.toLowerCase() === "all") return entries;

  const q = query.toLowerCase();
  const isGlobalQuery = q === "global";

  return entries.filter((entry) => {
    // Global entries always appear in any filter
    if (entry.cwds.includes("*")) return true;

    // "global" keyword shows only global entries
    if (isGlobalQuery) return false;

    // Match against CWD paths, title, body
    const cwdMatch = entry.cwds.some((cwd) => cwd.toLowerCase().includes(q));
    const titleMatch = entry.title.toLowerCase().includes(q);
    const bodyMatch = entry.body.toLowerCase().includes(q);

    return cwdMatch || titleMatch || bodyMatch;
  });
}

/** Sort entries by exposure count, highest first. */
export function sortByExposures(entries: LearningEntry[]): LearningEntry[] {
  return [...entries].sort((a, b) => b.exposures.length - a.exposures.length);
}

// --- Archive ---

export const ARCHIVE_FILE = "learnings-archive.md";

/** Append archived entries to learnings-archive.md. Atomic write via temp + rename. */
export async function appendToArchive(memoryDir: string, entries: LearningEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const archivePath = join(memoryDir, ARCHIVE_FILE);
  const { entries: existing } = await loadDocumentForMutation(archivePath);

  const merged = [...existing, ...entries];
  const content = renderValidatedLearnings(archivePath, merged);
  await writeLearningFileAtomically(archivePath, content);
}

// Re-export for hooks
export { hashSessionId } from "./utils";
