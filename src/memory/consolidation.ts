/**
 * Consolidation: duplicate detection, contradiction resolution, and metadata merging.
 *
 * Used by `shaka memory consolidate` to clean up the learnings file.
 * Operates via LLM prompts that identify duplicates/contradictions,
 * then applies mechanical merge and resolution rules.
 */

import type { Exposure, LearningEntry } from "./learnings";

// --- Types ---

export interface DuplicateGroup {
  readonly keep: number; // 0-based index
  readonly drop: number[];
}

export interface ContradictionPair {
  readonly a: number; // 0-based index
  readonly b: number;
}

// --- Shared helpers ---

type MutableEntry = ReturnType<typeof toMutable>;

function toMutable(e: LearningEntry) {
  return { ...e, cwds: [...e.cwds], exposures: [...e.exposures] };
}

function isValidIndex(idx: number, length: number): boolean {
  return idx >= 0 && idx < length;
}

// --- Duplicate Detection (Pass 1) ---

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

function absorbDropEntry(
  keep: { cwds: string[]; exposures: Exposure[]; nonglobal: boolean },
  drop: LearningEntry,
): void {
  keep.cwds = [...new Set([...keep.cwds, ...drop.cwds])];
  const seen = new Set(keep.exposures.map((e) => `${e.date}@${e.sessionHash}`));
  for (const e of drop.exposures) {
    const key = `${e.date}@${e.sessionHash}`;
    if (!seen.has(key)) {
      keep.exposures.push(e);
      seen.add(key);
    }
  }
  if (drop.nonglobal) keep.nonglobal = true;
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

// --- Contradiction Detection (Pass 2) ---

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
