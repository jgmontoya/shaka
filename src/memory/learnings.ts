/**
 * Learnings: parse, render, storage, scoring, undo-and-rewrite, merge,
 * extraction prompts, and consolidation.
 *
 * A learning is a reusable insight extracted from session transcripts —
 * corrections, preferences, patterns, or facts worth persisting.
 * Stored in a single markdown file with HTML comment metadata per entry.
 */

import { mkdir, rename } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { hashSessionId } from "./utils";

// --- Types ---

export type LearningCategory = "correction" | "preference" | "pattern" | "fact";

const VALID_CATEGORIES = new Set<string>(["correction", "preference", "pattern", "fact"]);

export interface Exposure {
  readonly date: string; // YYYY-MM-DD
  readonly sessionHash: string; // first 8 chars of SHA-256(sessionId)
}

export interface LearningEntry {
  readonly category: LearningCategory;
  readonly cwds: string[]; // absolute paths, or ["*"] for global
  readonly exposures: Exposure[]; // ordered: first = creation, last = most recent
  readonly nonglobal: boolean; // user opted out of global promotion
  readonly title: string;
  readonly body: string; // 1-3 sentences
}

// --- Scoring constants ---

const RECENCY_WINDOW_DAYS = 90;
const REINFORCEMENT_SATURATE = 4;
const DEFAULT_BUDGET = 6000;

// --- Parsing ---

const METADATA_RE =
  /^<!--\s*(\w+)\s*\|\s*cwd:\s*(.+?)\s*\|\s*exposures:\s*(.+?)(?:\s*\|\s*nonglobal)?\s*-->$/;

function isNonglobal(line: string): boolean {
  return /\|\s*nonglobal\s*-->$/.test(line);
}

function parseExposures(raw: string): Exposure[] {
  return raw.split(",").reduce<Exposure[]>((acc, part) => {
    const trimmed = part.trim();
    const atIndex = trimmed.indexOf("@");
    if (atIndex === -1) return acc;

    const date = trimmed.slice(0, atIndex);
    const sessionHash = trimmed.slice(atIndex + 1);
    if (date && sessionHash) {
      acc.push({ date, sessionHash });
    }
    return acc;
  }, []);
}

function parseCwds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBlock(block: string): LearningEntry | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  const metaLine = lines.find((l) => l.trim().startsWith("<!--") && l.trim().endsWith("-->"));
  if (!metaLine) return null;

  const match = metaLine.trim().match(METADATA_RE);
  if (!match) return null;

  const [, categoryStr, cwdStr, exposuresStr] = match;
  if (!categoryStr || !cwdStr || !exposuresStr) return null;
  if (!VALID_CATEGORIES.has(categoryStr)) return null;

  const titleLine = lines.find((l) => l.trim().startsWith("### "));
  if (!titleLine) return null;
  const title = titleLine.trim().slice(4).trim();
  if (!title) return null;

  const titleIndex = lines.indexOf(titleLine);
  const body = lines
    .slice(titleIndex + 1)
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();

  return {
    category: categoryStr as LearningCategory,
    cwds: parseCwds(cwdStr),
    exposures: parseExposures(exposuresStr),
    nonglobal: isNonglobal(metaLine.trim()),
    title,
    body,
  };
}

/** Parse learnings.md content into structured entries. */
export function parseLearnings(content: string): LearningEntry[] {
  if (!content.trim()) return [];

  return content
    .split(/^---$/m)
    .map(parseBlock)
    .filter((e): e is LearningEntry => e !== null);
}

// --- Rendering ---

/** Render a single entry to markdown format. */
export function renderEntry(entry: LearningEntry): string {
  const cwdStr = entry.cwds.join(", ");
  const exposuresStr = entry.exposures.map((e) => `${e.date}@${e.sessionHash}`).join(",");
  const nonglobalStr = entry.nonglobal ? " | nonglobal" : "";

  const meta = `<!-- ${entry.category} | cwd: ${cwdStr} | exposures: ${exposuresStr}${nonglobalStr} -->`;
  const title = `### ${entry.title}`;

  if (!entry.body) return `${meta}\n\n${title}`;
  return `${meta}\n\n${title}\n\n${entry.body}`;
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

/** Read and parse learnings from disk. Returns empty array if file missing. */
export async function loadLearnings(memoryDir: string): Promise<LearningEntry[]> {
  const filePath = join(memoryDir, LEARNINGS_FILE);
  const file = Bun.file(filePath);

  if (!(await file.exists())) return [];

  try {
    const content = await file.text();
    return parseLearnings(content);
  } catch {
    return [];
  }
}

/**
 * Write the full learnings file atomically (temp file + rename).
 * Prevents data loss from crashes during write.
 */
export async function writeLearnings(memoryDir: string, entries: LearningEntry[]): Promise<void> {
  await mkdir(memoryDir, { recursive: true });

  const filePath = join(memoryDir, LEARNINGS_FILE);
  const tmpPath = join(memoryDir, `.${LEARNINGS_FILE}.tmp.${process.pid}`);
  const content = renderLearnings(entries);

  await Bun.write(tmpPath, content);
  await rename(tmpPath, filePath);
}

// --- Scoring ---

function daysBetween(dateStr: string, now: Date): number {
  const date = new Date(dateStr);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return RECENCY_WINDOW_DAYS;
  return Math.max(0, (now.getTime() - ms) / (1000 * 60 * 60 * 24));
}

function recencyScore(entry: LearningEntry, now: Date): number {
  if (entry.exposures.length === 0) return 0;
  const lastExposure = entry.exposures[entry.exposures.length - 1];
  if (!lastExposure) return 0;
  const days = daysBetween(lastExposure.date, now);
  return Math.max(0, 1.0 - days / RECENCY_WINDOW_DAYS);
}

function reinforcementScore(entry: LearningEntry): number {
  return Math.min((entry.exposures.length - 1) / REINFORCEMENT_SATURATE, 1.0);
}

function matchesCwd(entry: LearningEntry, cwd: string): boolean {
  if (entry.cwds.includes("*")) return true;
  return entry.cwds.some((parent) => {
    const rel = relative(parent, cwd);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** Score a single entry for context loading. Range: 0.0 to 2.0. */
export function scoreEntry(entry: LearningEntry, now = new Date()): number {
  return recencyScore(entry, now) + reinforcementScore(entry);
}

/** Select entries for context loading within a character budget. */
export function selectLearnings(
  entries: LearningEntry[],
  cwd: string,
  budget = DEFAULT_BUDGET,
): LearningEntry[] {
  // Pre-filter: only global entries and CWD-matching entries are candidates.
  // Scoped entries for unrelated projects are excluded before scoring
  const relevant = entries.filter((e) => matchesCwd(e, cwd));

  const scored = relevant
    .map((entry) => ({ entry, score: scoreEntry(entry) }))
    .sort((a, b) => b.score - a.score);

  const selected: LearningEntry[] = [];
  let chars = 0;

  for (const { entry } of scored) {
    const size = renderEntry(entry).length;
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

    const mergedCwds = [...new Set([...match.cwds, ...newEntry.cwds])];
    const mergedExposures = [...match.exposures, ...newEntry.exposures];

    result[matchIndex] = {
      ...match,
      cwds: mergedCwds,
      exposures: mergedExposures,
    };
  }

  return result;
}

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
   persisting for future sessions. Return 0-3 learnings.

Do NOT extract:
- Obvious programming knowledge anyone would know
- One-time debugging steps that won't recur
- One-time decisions that won't recur
- Information already in the project's config files or README
- Speculative observations without clear evidence in the transcript
- Very specific observations that won't be useful for future sessions

DO extract:
- User corrections ("no, do X instead of Y")
- Stated preferences ("I always want X")
- Project conventions discovered by reading code
- Non-obvious environment facts ("this project uses X for Y")
- User clarifications that are likely to be useful for future sessions

If a learning matches an existing entry below, use its EXACT title
character-for-character (this enables automatic reinforcement tracking):

${titlesBlock}

If nothing in the transcript is worth persisting, return an empty Learnings section.
We expect most sessions to have 0 learnings and some to have 1 learning.
More than 2 learnings from one session is suspicious.

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

// --- Consolidation: Pass 1 (Duplicate Detection) ---

export interface DuplicateGroup {
  readonly keep: number; // 0-based index
  readonly drop: number[];
}

/** Build prompt for duplicate detection. Entries numbered [1]...[N]. */
export function buildDuplicatePrompt(entries: LearningEntry[]): string {
  const numbered = entries
    .map((e, i) => `[${i + 1}] (${e.category}) ${e.title}\n${e.body}`)
    .join("\n\n");

  return `Identify entries that describe the SAME knowledge. For each duplicate group,
indicate which entry to KEEP (the more specific, actionable one) and which to DROP.

## Entries

${numbered}

## Instructions

For each group of duplicate entries, output one line:
KEEP [N] DROP [N, N, ...] — reason

If there are no duplicates, output exactly:
NO DUPLICATES

Do not output entries that have no duplicates.
Do not invent new entries.
Do not modify any entry's content.`;
}

/**
 * Parse KEEP/DROP groups from duplicate detection output.
 * Returns 0-based indices.
 */
export function parseDuplicateOutput(raw: string): DuplicateGroup[] {
  if (raw.trim() === "NO DUPLICATES") return [];

  const groups: DuplicateGroup[] = [];
  const lineRe = /KEEP\s*\[(\d+)\]\s*DROP\s*\[([0-9,\s]+)\]/;

  for (const line of raw.split("\n")) {
    const match = line.match(lineRe);
    if (!match) continue;

    const keep = Number.parseInt(match[1] ?? "", 10) - 1;
    const dropStr = match[2];
    if (!dropStr || Number.isNaN(keep)) continue;

    const drop = dropStr
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .filter((n) => !Number.isNaN(n));

    if (drop.length > 0) {
      groups.push({ keep, drop });
    }
  }

  return groups;
}

function isValidIndex(idx: number, length: number): boolean {
  return idx >= 0 && idx < length;
}

function absorbDropEntry(
  keep: { cwds: string[]; exposures: Exposure[]; nonglobal: boolean },
  drop: LearningEntry,
): void {
  keep.cwds = [...new Set([...keep.cwds, ...drop.cwds])];
  keep.exposures = [...keep.exposures, ...drop.exposures];
  if (drop.nonglobal) keep.nonglobal = true;
}

type MutableEntry = ReturnType<typeof toMutable>;

function toMutable(e: LearningEntry) {
  return { ...e, cwds: [...e.cwds], exposures: [...e.exposures] };
}

function applyGroup(result: MutableEntry[], group: DuplicateGroup, dropped: Set<number>): void {
  if (!isValidIndex(group.keep, result.length) || dropped.has(group.keep)) return;

  const keepEntry = result[group.keep];
  if (!keepEntry) return;

  for (const dropIdx of group.drop) {
    if (!isValidIndex(dropIdx, result.length) || dropped.has(dropIdx)) continue;
    if (dropIdx === group.keep) continue;

    const dropEntry = result[dropIdx];
    if (!dropEntry) continue;

    absorbDropEntry(keepEntry, dropEntry);
    dropped.add(dropIdx);
  }

  keepEntry.exposures.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Apply duplicate merges. KEEP entry absorbs metadata from DROP entries.
 * Safe against out-of-range indices and overlapping groups.
 */
export function applyDuplicateMerges(
  entries: LearningEntry[],
  groups: DuplicateGroup[],
): LearningEntry[] {
  const result = entries.map(toMutable);
  const dropped = new Set<number>();

  for (const group of groups) {
    applyGroup(result, group, dropped);
  }

  return result.filter((_, i) => !dropped.has(i));
}

// --- Consolidation: Pass 2 (Contradiction Detection) ---

export interface ContradictionPair {
  readonly a: number; // 0-based index
  readonly b: number;
}

/** Build prompt for contradiction detection. Entries numbered [1]...[M]. */
export function buildContradictionPrompt(entries: LearningEntry[]): string {
  const numbered = entries
    .map((e, i) => `[${i + 1}] (${e.category}) ${e.title}\n${e.body}`)
    .join("\n\n");

  return `Identify entries that give OPPOSITE advice for the SAME situation.
Only flag genuine contradictions — entries that cannot both be true simultaneously.
Do NOT flag entries that are merely different topics.

## Entries

${numbered}

## Instructions

For each contradiction pair, output one line:
[N] CONTRADICTS [N] — reason

If there are no contradictions, output exactly:
NO CONTRADICTIONS

Do not modify any entry's content.
Do not resolve contradictions — just identify them.`;
}

/**
 * Parse contradiction pairs from detection output.
 * Returns 0-based indices.
 */
export function parseContradictionOutput(raw: string): ContradictionPair[] {
  if (raw.trim() === "NO CONTRADICTIONS") return [];

  const pairs: ContradictionPair[] = [];
  const lineRe = /\[(\d+)\]\s*CONTRADICTS\s*\[(\d+)\]/;

  for (const line of raw.split("\n")) {
    const match = line.match(lineRe);
    if (!match) continue;

    const a = Number.parseInt(match[1] ?? "", 10) - 1;
    const b = Number.parseInt(match[2] ?? "", 10) - 1;
    if (Number.isNaN(a) || Number.isNaN(b)) continue;

    pairs.push({ a, b });
  }

  return pairs;
}

function lastExposureDate(entry: LearningEntry): string {
  return entry.exposures[entry.exposures.length - 1]?.date ?? "";
}

function cwdsOverlap(a: string[], b: string[]): string[] {
  if (a.includes("*") || b.includes("*")) return ["*"];
  return a.filter((cwd) => b.includes(cwd));
}

function isNewerEntry(a: LearningEntry, b: LearningEntry): boolean {
  const dateA = lastExposureDate(a);
  const dateB = lastExposureDate(b);
  if (dateA !== dateB) return dateA > dateB;
  // Tiebreak: more exposures wins, then B wins
  return a.exposures.length > b.exposures.length;
}

function narrowCwds(
  older: MutableEntry,
  olderIdx: number,
  overlap: string[],
  removed: Set<number>,
): void {
  if (overlap.includes("*")) {
    removed.add(olderIdx);
    return;
  }
  const remaining = older.cwds.filter((c) => !overlap.includes(c));
  if (remaining.length === 0) {
    removed.add(olderIdx);
  } else {
    older.cwds = remaining;
  }
}

function resolvePair(result: MutableEntry[], pair: ContradictionPair, removed: Set<number>): void {
  if (!isValidIndex(pair.a, result.length) || !isValidIndex(pair.b, result.length)) return;
  if (removed.has(pair.a) || removed.has(pair.b)) return;

  const entryA = result[pair.a];
  const entryB = result[pair.b];
  if (!entryA || !entryB) return;

  const overlap = cwdsOverlap(entryA.cwds, entryB.cwds);
  if (overlap.length === 0) return; // False positive — no-op

  const [older, olderIdx] = isNewerEntry(entryA, entryB) ? [entryB, pair.b] : [entryA, pair.a];

  narrowCwds(older, olderIdx, overlap, removed);
}

/**
 * Resolve contradictions by CWD overlap. Newer entry wins in overlapping CWDs.
 * Safe against false positives (no overlap = no-op) and hallucinated indices.
 */
export function resolveContradictions(
  entries: LearningEntry[],
  pairs: ContradictionPair[],
): LearningEntry[] {
  const result = entries.map(toMutable);
  const removed = new Set<number>();

  for (const pair of pairs) {
    resolvePair(result, pair, removed);
  }

  return result.filter((_, i) => !removed.has(i));
}

// --- Promotion ---

/** Find entries eligible for CWD-to-global promotion. */
export function findPromotionCandidates(entries: LearningEntry[]): LearningEntry[] {
  return entries.filter((e) => !e.nonglobal && !e.cwds.includes("*") && e.cwds.length >= 3);
}

/** Promote an entry to global. */
export function promoteToGlobal(entry: LearningEntry): LearningEntry {
  return { ...entry, cwds: ["*"] };
}

/** Mark an entry as nonglobal to prevent future promotion prompts. */
export function markNonglobal(entry: LearningEntry): LearningEntry {
  return { ...entry, nonglobal: true };
}

// Re-export for hooks
export { hashSessionId } from "./utils";
