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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectLearningFileStatus, replaceFileAtomically } from "./learning-file";
import {
  type Exposure,
  type LearningScopeState,
  type PromotionEvidence,
  type PromotionReason,
  effectiveSourceCwds,
  generalizeLearningScope,
  independentPositiveRoots,
  normalizeCwdPath,
  validateLearningScope,
} from "./learning-scope";
import { type DirectoryLockOptions, withDirectoryLock } from "./lock";
import { arePathsRelated, hashSessionId } from "./utils";

export type { Exposure, PromotionEvidence, PromotionReason } from "./learning-scope";

// --- Types ---

export type LearningCategory = "correction" | "preference" | "pattern" | "fact";

const VALID_CATEGORIES = new Set<string>(["correction", "preference", "pattern", "fact"]);

export type LearningDiagnosticCode =
  | "malformed-learning-record"
  | "malformed-promotion-metadata"
  | "duplicate-promotion-metadata"
  | "invalid-learning-scope";

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
  "automatic-hierarchical-generalization",
  "contradiction-scope-subtraction",
  "legacy-source-reconstruction",
  "manual-common-ancestor-review",
  "manual-cross-project-review",
  "manual-global-review",
  "manual-scope-correction",
];
const PROMOTION_REASONS = new Set<PromotionReason>(PROMOTION_REASON_ORDER);
const PROMOTION_EVIDENCE_KEYS = new Set(["sourceCwds", "excludedCwds", "exposures", "reasons"]);

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
  if (raw.trim() === "none") return [];

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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePersistedPaths(cwds: readonly string[]): string[] {
  return [...new Set(cwds.map((cwd) => normalizeCwdPath(cwd) ?? cwd))].sort(compareCodeUnits);
}

function normalizePromotionEvidence(evidence: PromotionEvidence): PromotionEvidence {
  return {
    sourceCwds: normalizePersistedPaths(evidence.sourceCwds),
    excludedCwds: normalizePersistedPaths(evidence.excludedCwds),
    exposures: evidence.exposures.map((exposure) => ({ ...exposure })),
    reasons: [...new Set(evidence.reasons)].sort(compareCodeUnits),
  };
}

function toPromotionEvidence(value: unknown): PromotionEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !PROMOTION_EVIDENCE_KEYS.has(key))) return undefined;

  const { sourceCwds, excludedCwds, exposures, reasons } = value;
  const normalizedExcludedCwds = excludedCwds ?? [];
  if (
    !Array.isArray(sourceCwds) ||
    sourceCwds.length === 0 ||
    !sourceCwds.every((cwd) => typeof cwd === "string" && cwd.length > 0) ||
    !Array.isArray(normalizedExcludedCwds) ||
    !normalizedExcludedCwds.every((cwd) => typeof cwd === "string" && cwd.length > 0) ||
    !Array.isArray(exposures) ||
    !exposures.every(isExposure) ||
    !Array.isArray(reasons) ||
    reasons.length === 0 ||
    !reasons.every(isPromotionReason)
  ) {
    return undefined;
  }

  return normalizePromotionEvidence({
    sourceCwds: [...sourceCwds],
    excludedCwds: [...normalizedExcludedCwds],
    exposures: exposures.map((exposure) => ({ ...exposure })),
    reasons: [...reasons],
  });
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
  const normalized = normalizePromotionEvidence(evidence);
  const json = JSON.stringify({
    sourceCwds: normalized.sourceCwds,
    excludedCwds: normalized.excludedCwds,
    exposures: normalized.exposures,
    reasons: normalized.reasons,
  }).replaceAll("--", "\\u002d\\u002d");
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

function validateCurrentStorageScope(entry: LearningEntry, allowLegacyGlobalShape: boolean) {
  if (allowLegacyGlobalShape) {
    const wildcardCount = entry.cwds.filter((cwd) => cwd === "*").length;
    if (wildcardCount > 1) return validateLearningScope(entry);
    const exactCompanions = entry.cwds.filter((cwd) => cwd !== "*");
    if (entry.cwds.includes("*") && exactCompanions.length > 0) {
      const companions = validateLearningScope({ cwds: exactCompanions, nonglobal: false });
      if (!companions.ok) return companions;
    }
    const hasLegacyGlobalShape =
      entry.cwds.includes("*") && (entry.cwds.length !== 1 || entry.nonglobal);
    const state: LearningScopeState = hasLegacyGlobalShape
      ? { cwds: ["*"], promotionEvidence: entry.promotionEvidence, nonglobal: false }
      : entry;
    return validateLearningScope(state);
  }
  return validateLearningScope(entry);
}

function invalidLearningScope(title: string, message: string): LearningDiagnostic {
  return {
    code: "invalid-learning-scope",
    title,
    message: `Learning "${title}" has an invalid applicability scope. ${message}`,
  };
}

function promotionDiagnostic(title: string, code: LearningDiagnosticCode): LearningDiagnostic {
  return {
    code,
    title,
    message:
      code === "duplicate-promotion-metadata"
        ? `Learning "${title}" contains more than one promotion metadata record.`
        : `Learning "${title}" contains malformed promotion metadata.`,
  };
}

function scopeDiagnostic(
  entry: LearningEntry,
  allowLegacyGlobalShape: boolean,
): LearningDiagnostic | undefined {
  if (
    entry.exposures.length === 0 &&
    entry.cwds.includes("*") &&
    entry.nonglobal &&
    !entry.promotionEvidence
  ) {
    return invalidLearningScope(
      entry.title,
      "A legacy global learning cannot rely on nonglobal as its only durable state.",
    );
  }
  if (entry.exposures.length === 0 && !entry.promotionEvidence && !entry.nonglobal) {
    return invalidLearningScope(
      entry.title,
      "A learning without primary exposures must retain durable reviewed state.",
    );
  }

  const scope = validateCurrentStorageScope(entry, allowLegacyGlobalShape);
  return scope.ok ? undefined : invalidLearningScope(entry.title, scope.issue.message);
}

function entryDiagnostics(
  entry: LearningEntry,
  promotion: ParsedPromotionEvidence,
  allowLegacyGlobalShape: boolean,
): LearningDiagnostic[] {
  if (promotion.diagnosticCode) {
    return [promotionDiagnostic(entry.title, promotion.diagnosticCode)];
  }
  const diagnostic = scopeDiagnostic(entry, allowLegacyGlobalShape);
  return diagnostic ? [diagnostic] : [];
}

function isLearningBlockCandidate(titleIndex: number, metadataLines: readonly string[]): boolean {
  if (titleIndex !== -1) return true;
  return (
    metadataLines.some(isPrimaryMetadataCandidate) ||
    metadataLines.some(isPromotionMetadataCandidate)
  );
}

function parseTitledLearningBlock(
  lines: readonly string[],
  titleIndex: number,
  metadataLines: string[],
  allowLegacyGlobalShape: boolean,
): ParsedLearningBlock {
  const title = lines[titleIndex]?.trim().slice(4).trim();
  const metadata = parsePrimaryMetadata(metadataLines);
  if (!title || !metadata) return malformedLearningRecord(title || undefined);

  const body = lines
    .slice(titleIndex + 1)
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
  const promotion = parsePromotionEvidence(metadataLines);
  const entry: LearningEntry = {
    category: metadata.category,
    cwds: metadata.cwds,
    exposures: metadata.exposures,
    nonglobal: metadata.nonglobal,
    title,
    body,
    ...(promotion.evidence ? { promotionEvidence: promotion.evidence } : {}),
  };
  const diagnostics = entryDiagnostics(entry, promotion, allowLegacyGlobalShape);

  return {
    ...(diagnostics.length === 0 ? { entry } : {}),
    diagnostics,
  };
}

function parseBlock(block: string, allowLegacyGlobalShape: boolean): ParsedLearningBlock | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  const titleIndex = lines.findIndex((line) => TITLE_CANDIDATE_RE.test(line.trim()));
  const metadataLines = lines.slice(0, titleIndex === -1 ? lines.length : titleIndex);
  if (!isLearningBlockCandidate(titleIndex, metadataLines)) return null;
  if (titleIndex === -1) return malformedLearningRecord();
  return parseTitledLearningBlock(lines, titleIndex, metadataLines, allowLegacyGlobalShape);
}

function parseLearningsDocumentWithMode(
  content: string,
  allowLegacyGlobalShape: boolean,
): ParsedLearningsDocument {
  if (!content.trim()) return { entries: [], diagnostics: [] };

  const entries: LearningEntry[] = [];
  const diagnostics: LearningDiagnostic[] = [];
  let seenNonEmptyBlock = false;

  for (const block of content.split(/^---$/m)) {
    if (!block.trim()) continue;

    const isFirstNonEmptyBlock = !seenNonEmptyBlock;
    seenNonEmptyBlock = true;
    const parsed = parseBlock(block, allowLegacyGlobalShape);
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

/** Parse canonical learnings storage into tolerant entries plus loss-bearing diagnostics. */
export function parseLearningsDocument(content: string): ParsedLearningsDocument {
  return parseLearningsDocumentWithMode(content, false);
}

/** Parse the legacy wildcard shapes accepted only during the v1 scope migration. */
export function parseLegacyScopeMigrationDocument(content: string): ParsedLearningsDocument {
  return parseLearningsDocumentWithMode(content, true);
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
  const exposuresStr =
    entry.exposures.length === 0
      ? "none"
      : entry.exposures.map((e) => `${e.date}@${e.sessionHash}`).join(",");
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

export const LEARNINGS_FILE = "learnings.md";

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

export function learningEntriesEqual(
  left: readonly LearningEntry[],
  right: readonly LearningEntry[],
): boolean {
  return left.length === right.length && Bun.deepEquals(left, right);
}

export type UniqueLearningMatch =
  | { readonly status: "matched"; readonly index: number; readonly entry: LearningEntry }
  | { readonly status: "stale" }
  | { readonly status: "ambiguous" };

/** Find one full persisted representation without selecting an arbitrary duplicate. */
export function findUniqueLearningMatch(
  entries: readonly LearningEntry[],
  expected: LearningEntry,
): UniqueLearningMatch {
  const expectedContent = renderEntry(expected);
  const matches = entries.flatMap((entry, index) =>
    renderEntry(entry) === expectedContent ? [{ index, entry }] : [],
  );
  if (matches.length === 0) return { status: "stale" };
  if (matches.length !== 1) return { status: "ambiguous" };
  const match = matches[0];
  return match ? { status: "matched", ...match } : { status: "stale" };
}

export function renderValidatedLearnings(
  filePath: string,
  entries: readonly LearningEntry[],
): string {
  const mutableEntries = [...entries];
  if (mutableEntries.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new LearningsIntegrityError(filePath, [
      {
        code: "malformed-learning-record",
        message: "Replacement learning records cannot be represented without data loss.",
      },
    ]);
  }
  const content = renderLearnings(mutableEntries);
  const parsed = parseLearningsDocument(content);
  if (parsed.diagnostics.length > 0) {
    throw new LearningsIntegrityError(filePath, parsed.diagnostics);
  }
  if (!learningEntriesEqual(parsed.entries, mutableEntries)) {
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

async function loadLearningsDocument(filePath: string): Promise<LoadedLearningsDocument> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return { sourceText: "", entries: [], diagnostics: [] };

  const sourceText = await file.text();
  return { sourceText, ...parseLearningsDocument(sourceText) };
}

export interface LoadedLearningSource {
  readonly exists: boolean;
  readonly sourceText: string;
}

export async function loadLearningSourceForMutation(
  filePath: string,
): Promise<LoadedLearningSource> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind === "missing") return { exists: false, sourceText: "" };
  if (status.kind === "invalid") throw new LearningsStoragePathError(filePath, status.message);

  let sourceText: string;
  try {
    sourceText = await Bun.file(filePath).text();
  } catch {
    throw new LearningsStoragePathError(filePath, "Learning storage file could not be read.");
  }

  return { exists: true, sourceText };
}

export async function loadDocumentForMutation(filePath: string): Promise<LoadedLearningsDocument> {
  const source = await loadLearningSourceForMutation(filePath);
  if (!source.exists) return { sourceText: "", entries: [], diagnostics: [] };

  const document = { sourceText: source.sourceText, ...parseLearningsDocument(source.sourceText) };
  if (document.diagnostics.length > 0) {
    throw new LearningsIntegrityError(filePath, document.diagnostics);
  }
  return document;
}

export async function writeLearningsUnderLock(
  memoryDir: string,
  entries: readonly LearningEntry[],
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  const filePath = join(memoryDir, LEARNINGS_FILE);
  await replaceFileAtomically(filePath, renderValidatedLearnings(filePath, entries));
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

/** Run an operation while holding the process-shared learnings lock. */
export async function withLearningsLock<T>(
  memoryDir: string,
  operation: () => Promise<T>,
  lockOptions?: DirectoryLockOptions,
): Promise<T> {
  await mkdir(memoryDir, { recursive: true });
  return await withDirectoryLock(join(memoryDir, ".learnings.lock"), operation, lockOptions);
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
  return Math.max(0, Math.min((entry.exposures.length - 1) / REINFORCEMENT_SATURATE, 1.0));
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
    return normalizePromotionEvidence(item);
  }

  const sourceCwds = normalizePersistedPaths(evidence.flatMap((item) => item.sourceCwds));
  const excludedCwds = normalizePersistedPaths(evidence.flatMap((item) => item.excludedCwds));
  const exposuresByKey = new Map<string, Exposure>();
  for (const exposure of evidence.flatMap((item) => item.exposures)) {
    exposuresByKey.set(`${exposure.date}@${exposure.sessionHash}`, { ...exposure });
  }
  const exposures = [...exposuresByKey.values()].sort(
    (a, b) => compareCodeUnits(a.date, b.date) || compareCodeUnits(a.sessionHash, b.sessionHash),
  );
  const presentReasons = new Set(evidence.flatMap((item) => item.reasons));
  const reasons = PROMOTION_REASON_ORDER.filter((reason) => presentReasons.has(reason)).sort(
    compareCodeUnits,
  );

  return { sourceCwds, excludedCwds, exposures, reasons };
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
export function buildExtractionPromptSection(existingTitles: readonly string[]): string {
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

If nothing in the transcript is worth persisting, return exactly \`None.\` under Learnings.
The default is 0 learnings. Extract only when something genuinely surprising was learned.

Format learnings as:

## Learnings

### (category) Title

Body text (1-3 sentences).

Or, when there are no learnings:

## Learnings

None.

Where category is one of: correction, preference, pattern, fact`;
}

export interface SessionLearningDraft {
  readonly category: LearningCategory;
  readonly title: string;
  readonly body: string;
}

export type ExtractedLearningsResult =
  | { readonly status: "valid"; readonly entries: readonly SessionLearningDraft[] }
  | { readonly status: "missing" }
  | { readonly status: "malformed"; readonly issues: readonly string[] };

type LearningsSectionResult =
  | { readonly status: "found"; readonly section: string }
  | Extract<ExtractedLearningsResult, { readonly status: "missing" | "malformed" }>;

function extractLearningsSection(raw: string): LearningsSectionResult {
  const headings = [...raw.matchAll(/^## Learnings[ \t]*$/gm)];
  if (headings.length === 0) return { status: "missing" };
  if (headings.length !== 1) {
    return { status: "malformed", issues: ["Expected exactly one Learnings section."] };
  }

  const heading = headings[0];
  if (!heading || heading.index === undefined) {
    return { status: "malformed", issues: ["Learnings section position is unavailable."] };
  }
  const remainder = raw.slice(heading.index + heading[0].length);
  const nextSectionOffset = remainder.search(/^##(?!#)(?:[ \t]+.*)?$/m);
  return {
    status: "found",
    section: (nextSectionOffset === -1 ? remainder : remainder.slice(0, nextSectionOffset)).trim(),
  };
}

type ParsedDraft =
  | { readonly ok: true; readonly entry: SessionLearningDraft }
  | { readonly ok: false; readonly issue: string };

function parseLearningDraft(
  section: string,
  headings: readonly RegExpMatchArray[],
  index: number,
): ParsedDraft {
  const heading = headings[index];
  const headingText = heading?.[0].slice(3).trim() ?? "";
  const parsedHeading = heading?.[0].match(/^###[ \t]+\((\w+)\)[ \t]+(.+?)[ \t]*$/);
  if (!heading || !parsedHeading || !VALID_CATEGORIES.has(parsedHeading[1] ?? "")) {
    return {
      ok: false,
      issue: `Invalid learning heading: ${headingText || heading?.[0] || "unknown"}`,
    };
  }
  const title = parsedHeading[2]?.trim() ?? "";
  if (!title) return { ok: false, issue: `Invalid learning heading: ${headingText}` };

  const bodyStart = (heading.index ?? 0) + heading[0].length;
  const bodyEnd = headings[index + 1]?.index ?? section.length;
  return {
    ok: true,
    entry: {
      category: parsedHeading[1] as LearningCategory,
      title,
      body: section.slice(bodyStart, bodyEnd).trim(),
    },
  };
}

function parseLearningDrafts(section: string): ExtractedLearningsResult {
  if (section === "" || section === "None.") return { status: "valid", entries: [] };
  const headings = [...section.matchAll(/^###(?!#)[^\r\n]*/gm)];
  const firstHeading = headings[0];
  if (
    !firstHeading ||
    firstHeading.index === undefined ||
    section.slice(0, firstHeading.index).trim()
  ) {
    return { status: "malformed", issues: ["Learnings section contains unknown text."] };
  }

  const parsed = headings.map((_, index) => parseLearningDraft(section, headings, index));
  const issues = parsed.flatMap((result) => (result.ok ? [] : [result.issue]));
  if (issues.length > 0) return { status: "malformed", issues };
  return {
    status: "valid",
    entries: parsed.flatMap((result) => (result.ok ? [result.entry] : [])),
  };
}

/** Parse the complete, bounded ## Learnings section without keeping a valid subset. */
export function parseExtractedLearnings(raw: string): ExtractedLearningsResult {
  const section = extractLearningsSection(raw);
  return section.status === "found" ? parseLearningDrafts(section.section) : section;
}

// --- Promotion ---

const SCOPE_REVIEW_SOURCE_THRESHOLD = 3;

export interface LearningScopeGeneralizationResult {
  readonly entries: LearningEntry[];
  readonly generalized: number;
}

/** Apply the pure hierarchy transition to every entry without mutating the input array. */
export function generalizeLearningScopes(
  entries: readonly LearningEntry[],
  forbiddenRoots: readonly string[],
): LearningScopeGeneralizationResult {
  let generalized = 0;
  const nextEntries = entries.map((entry) => {
    const transition = generalizeLearningScope(
      {
        cwds: entry.cwds,
        nonglobal: entry.nonglobal,
        ...(entry.promotionEvidence ? { promotionEvidence: entry.promotionEvidence } : {}),
      },
      entry.exposures,
      forbiddenRoots,
    );
    if (!transition.ok) {
      throw new Error(`Cannot generalize learning "${entry.title}": ${transition.issue.message}`);
    }
    if (!transition.changed) return entry;

    generalized++;
    const { promotionEvidence: _previousEvidence, ...entryWithoutEvidence } = entry;
    return {
      ...entryWithoutEvidence,
      cwds: [...transition.state.cwds],
      nonglobal: transition.state.nonglobal,
      ...(transition.state.promotionEvidence
        ? { promotionEvidence: transition.state.promotionEvidence }
        : {}),
    };
  });

  return { entries: nextEntries, generalized };
}

/** Find entries eligible for interactive ancestor or global scope review. */
export function findScopeReviewCandidates(entries: LearningEntry[]): LearningEntry[] {
  return entries.filter((entry) => {
    if (entry.nonglobal || entry.cwds.includes("*")) return false;
    if ((entry.promotionEvidence?.excludedCwds.length ?? 0) > 0) return false;

    const positiveCwds = entry.promotionEvidence
      ? effectiveSourceCwds(entry.promotionEvidence)
      : entry.cwds;
    return independentPositiveRoots(positiveCwds).length >= SCOPE_REVIEW_SOURCE_THRESHOLD;
  });
}

/** Promote an entry to global while preserving the evidence for its former scope. */
export function promoteToGlobal(
  entry: LearningEntry,
  reason: PromotionReason,
): LearningEntry & { readonly promotionEvidence: PromotionEvidence } {
  const existing = entry.promotionEvidence;
  const promotionEvidence = normalizePromotionEvidence({
    sourceCwds: existing?.sourceCwds ?? [...entry.cwds],
    excludedCwds: existing?.excludedCwds ?? [],
    exposures: existing?.exposures ?? entry.exposures.map((exposure) => ({ ...exposure })),
    reasons: [...(existing?.reasons ?? []), reason],
  });

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

export async function appendToArchiveUnderLock(
  memoryDir: string,
  existing: readonly LearningEntry[],
  entries: readonly LearningEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const archivePath = join(memoryDir, ARCHIVE_FILE);
  const merged = [...existing, ...entries];
  await replaceFileAtomically(archivePath, renderValidatedLearnings(archivePath, merged));
}

// Re-export for hooks
export { hashSessionId } from "./utils";
