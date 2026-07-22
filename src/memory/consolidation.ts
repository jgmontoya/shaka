/**
 * Consolidation: duplicate detection, contradiction resolution, condensation,
 * and metadata merging.
 *
 * Used by `shaka memory consolidate` and the maintenance pipeline.
 * Operates via LLM prompts that identify duplicates/contradictions/clusters,
 * then applies mechanical merge and resolution rules.
 */

import { inference } from "../inference";
import type { ProviderName } from "../providers/types";
import {
  effectiveSourceCwds,
  independentPositiveRoots,
  narrowScopeForExclusions,
  validateLearningScope,
} from "./learning-scope";
import {
  type Exposure,
  type LearningEntry,
  type PromotionEvidence,
  mergeLearningCwds,
  mergePromotionEvidence,
} from "./learnings";
import { arePathsRelated } from "./utils";

// --- Types ---

export interface DuplicateGroup {
  readonly keep: number; // 0-based index
  readonly drop: number[];
}

export interface ContradictionPair {
  readonly a: number; // 0-based index
  readonly b: number;
}

export interface DuplicateApplicationResult {
  readonly entries: LearningEntry[];
  readonly mergedCount: number;
  readonly scopeNarrowedCount: number;
  readonly unresolvedCount: number;
  readonly overlappingNoopCount: number;
}

export interface ContradictionApplicationResult {
  readonly entries: LearningEntry[];
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly overlappingNoopCount: number;
}

// --- Shared helpers ---

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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergePrimaryExposures(entries: readonly LearningEntry[]): Exposure[] {
  const byKey = new Map<string, Exposure>();
  for (const exposure of entries.flatMap((entry) => entry.exposures)) {
    byKey.set(`${exposure.date}@${exposure.sessionHash}`, { ...exposure });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareCodeUnits(left.date, right.date) ||
      compareCodeUnits(left.sessionHash, right.sessionHash),
  );
}

interface MergedDuplicate {
  readonly entry: LearningEntry;
  readonly scopeNarrowed: boolean;
}

function mergeDuplicateEvidence(sources: readonly LearningEntry[]): PromotionEvidence | undefined {
  const suppliedEvidence = mergePromotionEvidence(
    ...sources.map((entry) => entry.promotionEvidence),
  );
  if (!suppliedEvidence) return undefined;

  const scopedEvidenceFreeRoots = sources.flatMap((entry) =>
    entry.promotionEvidence === undefined && entry.cwds[0] !== "*" ? entry.cwds : [],
  );
  return {
    ...suppliedEvidence,
    sourceCwds: [...new Set([...suppliedEvidence.sourceCwds, ...scopedEvidenceFreeRoots])].sort(
      compareCodeUnits,
    ),
  };
}

function chooseMergedDuplicateCwds(
  sources: readonly LearningEntry[],
  nonglobal: boolean,
  promotionEvidence: PromotionEvidence | undefined,
): string[] {
  const exclusions = promotionEvidence?.excludedCwds ?? [];
  const hasWildcard = sources.some((entry) => entry.cwds[0] === "*");
  const wildcardVetoed = hasWildcard && (nonglobal || exclusions.length > 0);
  if (hasWildcard && !wildcardVetoed) return ["*"];

  const mergedScopedCwds = mergeLearningCwds(
    ...sources.filter((entry) => entry.cwds[0] !== "*").map((entry) => entry.cwds),
  );
  const activeScopeMatchesExclusion = mergedScopedCwds.some((cwd) =>
    exclusions.some((exclusion) => arePathsRelated(cwd, exclusion)),
  );
  if (!wildcardVetoed && !activeScopeMatchesExclusion) {
    return independentPositiveRoots(mergedScopedCwds);
  }

  const knownPositiveRoots = promotionEvidence
    ? effectiveSourceCwds(promotionEvidence)
    : independentPositiveRoots(mergedScopedCwds);
  return independentPositiveRoots(knownPositiveRoots);
}

function mergeDuplicateEntries(
  keep: LearningEntry,
  drops: readonly LearningEntry[],
): MergedDuplicate | undefined {
  const sources = [keep, ...drops];
  if (sources.some((entry) => !validateLearningScope(entry).ok)) return undefined;

  const nonglobal = sources.some((entry) => entry.nonglobal);
  const hasUnknownGlobal = sources.some(
    (entry) => entry.cwds[0] === "*" && entry.promotionEvidence === undefined,
  );
  const promotionEvidence = mergeDuplicateEvidence(sources);
  const cwds = chooseMergedDuplicateCwds(sources, nonglobal, promotionEvidence);

  if (cwds.length === 0) return undefined;
  const entry: LearningEntry = {
    ...keep,
    cwds,
    exposures: mergePrimaryExposures(sources),
    nonglobal,
    ...(promotionEvidence ? { promotionEvidence } : {}),
  };
  if (!validateLearningScope(entry).ok) return undefined;

  return {
    entry,
    scopeNarrowed: hasUnknownGlobal && cwds[0] !== "*",
  };
}

function duplicateGroupIndices(group: DuplicateGroup, length: number): number[] | undefined {
  const indices = [group.keep, ...group.drop];
  if (
    group.drop.length === 0 ||
    indices.some((index) => !Number.isInteger(index) || !isValidIndex(index, length)) ||
    new Set(indices).size !== indices.length
  ) {
    return undefined;
  }
  return indices;
}

/**
 * Apply duplicate merges. KEEP entry absorbs metadata from DROP entries.
 * Safe against out-of-range indices and overlapping groups.
 */
export function applyDuplicateMerges(
  entries: LearningEntry[],
  groups: DuplicateGroup[],
): DuplicateApplicationResult {
  const replacements = new Map<number, LearningEntry>();
  const dropped = new Set<number>();
  const claimed = new Set<number>();
  let mergedCount = 0;
  let scopeNarrowedCount = 0;
  let unresolvedCount = 0;
  let overlappingNoopCount = 0;

  for (const group of groups) {
    const indices = duplicateGroupIndices(group, entries.length);
    if (!indices) {
      unresolvedCount++;
      continue;
    }
    if (indices.some((index) => claimed.has(index))) {
      overlappingNoopCount++;
      continue;
    }

    const keepEntry = entries[group.keep];
    if (!keepEntry) {
      unresolvedCount++;
      continue;
    }
    const drops = group.drop.flatMap((index) => {
      const entry = entries[index];
      return entry ? [entry] : [];
    });
    const merged = mergeDuplicateEntries(keepEntry, drops);
    if (!merged) {
      unresolvedCount++;
      continue;
    }
    replacements.set(group.keep, merged.entry);
    for (const index of indices) claimed.add(index);
    for (const dropIdx of group.drop) dropped.add(dropIdx);
    mergedCount += group.drop.length;
    if (merged.scopeNarrowed) scopeNarrowedCount++;
  }

  return {
    entries: entries.flatMap((entry, index) => {
      if (dropped.has(index)) return [];
      return [replacements.get(index) ?? entry];
    }),
    mergedCount,
    scopeNarrowedCount,
    unresolvedCount,
    overlappingNoopCount,
  };
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

function isNewerEntry(a: LearningEntry, b: LearningEntry): boolean {
  const dateA = lastExposureDate(a);
  const dateB = lastExposureDate(b);
  if (dateA !== dateB) return dateA > dateB;
  // Tiebreak: more exposures wins, then B wins
  return a.exposures.length > b.exposures.length;
}

function contradictionPairIndices(
  pair: ContradictionPair,
  length: number,
): readonly [number, number] | undefined {
  if (
    !Number.isInteger(pair.a) ||
    !Number.isInteger(pair.b) ||
    pair.a === pair.b ||
    !isValidIndex(pair.a, length) ||
    !isValidIndex(pair.b, length)
  ) {
    return undefined;
  }
  return [pair.a, pair.b];
}

function hasClaimedIndex(indices: readonly number[], claimed: ReadonlySet<number>): boolean {
  return indices.some((index) => claimed.has(index));
}

function relatedSubtractionRoots(older: LearningEntry, newer: LearningEntry): string[] {
  if (newer.cwds[0] === "*") return ["*"];
  if (older.cwds[0] === "*") return [...new Set(newer.cwds)].sort(compareCodeUnits);
  return [
    ...new Set(newer.cwds.filter((cwd) => older.cwds.some((root) => arePathsRelated(root, cwd)))),
  ].sort(compareCodeUnits);
}

type ContradictionProposalOutcome =
  | { readonly kind: "noop" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "overlap" }
  | { readonly kind: "remove"; readonly olderIndex: number }
  | { readonly kind: "replace"; readonly olderIndex: number; readonly entry: LearningEntry };

function evaluateContradictionProposal(
  entryA: LearningEntry,
  indexA: number,
  entryB: LearningEntry,
  indexB: number,
): ContradictionProposalOutcome {
  if (!validateLearningScope(entryA).ok || !validateLearningScope(entryB).ok) {
    return { kind: "unresolved" };
  }

  const [older, olderIndex, newer] = isNewerEntry(entryA, entryB)
    ? [entryB, indexB, entryA]
    : [entryA, indexA, entryB];
  const subtractionRoots = relatedSubtractionRoots(older, newer);
  if (subtractionRoots.length === 0) return { kind: "noop" };
  if (subtractionRoots[0] === "*") return { kind: "remove", olderIndex };

  const narrowed = narrowScopeForExclusions(older, subtractionRoots, {
    supportingExposures: older.exposures,
  });
  if (!narrowed.ok) {
    return narrowed.issue.code === "no-effective-sources"
      ? { kind: "remove", olderIndex }
      : { kind: "unresolved" };
  }
  return {
    kind: "replace",
    olderIndex,
    entry: {
      ...older,
      cwds: [...narrowed.state.cwds],
      promotionEvidence: narrowed.state.promotionEvidence,
      nonglobal: narrowed.state.nonglobal,
    },
  };
}

function evaluateIndexedContradiction(
  entries: readonly LearningEntry[],
  pair: ContradictionPair,
  claimed: ReadonlySet<number>,
): ContradictionProposalOutcome {
  const indices = contradictionPairIndices(pair, entries.length);
  if (!indices) return { kind: "unresolved" };
  if (hasClaimedIndex(indices, claimed)) return { kind: "overlap" };

  const entryA = entries[pair.a];
  const entryB = entries[pair.b];
  return entryA && entryB
    ? evaluateContradictionProposal(entryA, pair.a, entryB, pair.b)
    : { kind: "unresolved" };
}

/**
 * Resolve contradictions by CWD overlap. Newer entry wins in overlapping CWDs.
 * Safe against false positives (no overlap = no-op) and hallucinated indices.
 */
export function resolveContradictions(
  entries: LearningEntry[],
  pairs: ContradictionPair[],
): ContradictionApplicationResult {
  const replacements = new Map<number, LearningEntry>();
  const removed = new Set<number>();
  const claimed = new Set<number>();
  let resolvedCount = 0;
  let unresolvedCount = 0;
  let overlappingNoopCount = 0;

  for (const pair of pairs) {
    const outcome = evaluateIndexedContradiction(entries, pair, claimed);
    if (outcome.kind === "overlap") {
      overlappingNoopCount++;
      continue;
    }
    if (outcome.kind === "noop") continue;
    if (outcome.kind === "unresolved") {
      unresolvedCount++;
      continue;
    }
    if (outcome.kind === "remove") removed.add(outcome.olderIndex);
    if (outcome.kind === "replace") replacements.set(outcome.olderIndex, outcome.entry);

    claimed.add(pair.a);
    claimed.add(pair.b);
    resolvedCount++;
  }

  return {
    entries: entries.flatMap((entry, index) =>
      removed.has(index) ? [] : [replacements.get(index) ?? entry],
    ),
    resolvedCount,
    unresolvedCount,
    overlappingNoopCount,
  };
}

// --- Condensation: Types ---

export interface CondensationCandidate {
  readonly cwd: string;
  readonly entries: LearningEntry[];
  readonly indices: number[]; // positions in the original entries array
}

export interface CondensationCluster {
  readonly indices: number[]; // 0-based into candidate.entries array
  readonly label: string; // topic label from LLM
  readonly title: string; // synthesized title
  readonly body: string; // synthesized body
}

export interface CandidateWithClusters {
  readonly candidate: CondensationCandidate;
  readonly clusters: CondensationCluster[];
}

export interface CondensationResult {
  readonly entries: LearningEntry[]; // updated list
  readonly archived: LearningEntry[]; // entries to write to archive
  readonly compoundsCreated: number; // for logging
}

// --- Condensation: Constants ---

const CONDENSATION_EXPOSURE_MIN = 2;
const CONDENSATION_CLUSTER_MIN = 2;

// --- Condensation: Cluster Detection (Pass 3) ---

/** Group entries by CWD. Multi-CWD entries appear in multiple groups. Global entries excluded. */
export function groupByCwd(entries: LearningEntry[]): Map<string, LearningEntry[]> {
  const groups = new Map<string, LearningEntry[]>();

  for (const entry of entries) {
    if (entry.cwds.includes("*") || entry.promotionEvidence || entry.nonglobal) continue;
    for (const cwd of entry.cwds) {
      const group = groups.get(cwd);
      if (group) {
        group.push(entry);
      } else {
        groups.set(cwd, [entry]);
      }
    }
  }

  return groups;
}

/**
 * Find CWD groups with enough high-exposure entries to warrant condensation.
 * Entries need CONDENSATION_EXPOSURE_MIN exposures; groups need CONDENSATION_CLUSTER_MIN entries.
 */
export function findCondensationCandidates(entries: LearningEntry[]): CondensationCandidate[] {
  const groups = groupByCwd(entries);
  const candidates: CondensationCandidate[] = [];

  for (const [cwd, groupEntries] of groups) {
    const highExposure: { entry: LearningEntry; originalIndex: number }[] = [];

    for (const groupEntry of groupEntries) {
      if (groupEntry.exposures.length >= CONDENSATION_EXPOSURE_MIN) {
        const originalIndex = entries.indexOf(groupEntry);
        highExposure.push({ entry: groupEntry, originalIndex });
      }
    }

    if (highExposure.length >= CONDENSATION_CLUSTER_MIN) {
      candidates.push({
        cwd,
        entries: highExposure.map((h) => h.entry),
        indices: highExposure.map((h) => h.originalIndex),
      });
    }
  }

  return candidates;
}

// --- Condensation: Prompt Building ---

/** Build prompt for condensation clustering. Entries numbered [1]...[N]. */
export function buildCondensationPrompt(entries: LearningEntry[]): string {
  const numbered = entries
    .map((e, i) => `[${i + 1}] (${e.category}) ${e.title}\n${e.body}`)
    .join("\n\n");

  return `These entries are all frequently used in the same project. Identify groups of 2+
entries that address the SAME topic and could be merged into one richer learning.

## Entries

${numbered}

## Instructions

For each cluster, output:
CLUSTER [N, N] — topic label
TITLE: <merged title, concise>
BODY: <merged body, 1-5 sentences. Preserve BOTH the directive AND the reason/story
behind it. "Use X" is weaker than "Use X because Y happened when we didn't.">

If no entries form a meaningful cluster, output:
NO CLUSTERS`;
}

// --- Condensation: Output Parsing ---

const CLUSTER_LINE_RE = /^CLUSTER\s*\[([0-9,\s]+)\]\s*[-–—]\s*(.+)$/;
const TITLE_LINE_RE = /^TITLE:\s*(.+)$/;
const BODY_LINE_RE = /^BODY:\s*(.*)$/;

/**
 * State-machine parser for CLUSTER/TITLE/BODY blocks.
 * Handles multi-line BODY text. Flushes on new CLUSTER line or EOF.
 * Returns 0-based indices (prompt uses 1-based).
 */
interface ParserState {
  indices: number[] | null;
  label: string;
  title: string;
  bodyLines: string[];
  inBody: boolean;
}

function emptyParserState(): ParserState {
  return { indices: null, label: "", title: "", bodyLines: [], inBody: false };
}

function flushCluster(state: ParserState, clusters: CondensationCluster[]): void {
  if (state.indices && state.title) {
    clusters.push({
      indices: state.indices,
      label: state.label,
      title: state.title,
      body: state.bodyLines.join("\n").trim(),
    });
  }
}

function parseClusterLine(line: string): { indices: number[]; label: string } | null {
  const match = line.match(CLUSTER_LINE_RE);
  if (!match?.[1] || !match[2]) return null;

  const indices = match[1]
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10) - 1)
    .filter((n) => !Number.isNaN(n) && n >= 0);

  return { indices, label: match[2].trim() };
}

function processLine(line: string, state: ParserState, clusters: CondensationCluster[]): void {
  const cluster = parseClusterLine(line);
  if (cluster) {
    flushCluster(state, clusters);
    Object.assign(state, emptyParserState(), cluster);
    return;
  }

  if (!state.indices) return;

  const titleMatch = line.match(TITLE_LINE_RE);
  if (titleMatch?.[1]) {
    state.title = titleMatch[1].trim();
    return;
  }

  const bodyMatch = line.match(BODY_LINE_RE);
  if (bodyMatch) {
    state.inBody = true;
    if (bodyMatch[1]) state.bodyLines.push(bodyMatch[1]);
    return;
  }

  if (state.inBody) state.bodyLines.push(line);
}

/**
 * Parse LLM condensation output into structured clusters.
 * State-machine parser for multi-line BODY text.
 * Returns 0-based indices (prompt uses 1-based).
 */
export function parseCondensationOutput(raw: string): CondensationCluster[] {
  if (raw.trim() === "NO CLUSTERS") return [];

  const clusters: CondensationCluster[] = [];
  const state = emptyParserState();

  for (const line of raw.split("\n")) {
    processLine(line, state, clusters);
  }

  flushCluster(state, clusters);
  return clusters;
}

// --- Condensation: Apply ---

const CATEGORY_PRIORITY: Record<string, number> = {
  pattern: 0,
  correction: 1,
  preference: 2,
  fact: 3,
};

function pickCategory(entries: LearningEntry[]): LearningEntry["category"] {
  let best: LearningEntry["category"] = "fact";
  let bestPriority = CATEGORY_PRIORITY.fact ?? 3;

  for (const entry of entries) {
    const priority = CATEGORY_PRIORITY[entry.category] ?? 3;
    if (priority < bestPriority) {
      best = entry.category;
      bestPriority = priority;
    }
  }

  return best;
}

function mergeExposures(entries: LearningEntry[]): Exposure[] {
  const seen = new Set<string>();
  const merged: Exposure[] = [];

  for (const entry of entries) {
    for (const exp of entry.exposures) {
      const key = `${exp.date}@${exp.sessionHash}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(exp);
      }
    }
  }

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

// --- Condensation: Apply helpers ---

interface ApplyState {
  readonly consumed: Set<number>;
  readonly insertions: Map<number, LearningEntry[]>;
  readonly archivedIndices: Set<number>;
  readonly narrowed: Map<number, string[]>;
  compoundsCreated: number;
}

function resolveClusterIndices(
  cluster: CondensationCluster,
  candidate: CondensationCandidate,
  candidateConsumed: Set<number>,
  globalConsumed: Set<number>,
): number[] | null {
  const originalIndices: number[] = [];

  for (const localIdx of cluster.indices) {
    if (!isValidIndex(localIdx, candidate.entries.length)) continue;
    const originalIdx = candidate.indices[localIdx];
    if (originalIdx === undefined) continue;
    if (candidateConsumed.has(originalIdx) || globalConsumed.has(originalIdx)) continue;
    originalIndices.push(originalIdx);
  }

  return originalIndices.length >= CONDENSATION_CLUSTER_MIN ? originalIndices : null;
}

function processCluster(
  cluster: CondensationCluster,
  candidate: CondensationCandidate,
  originalIndices: number[],
  entries: LearningEntry[],
  state: ApplyState,
  candidateConsumed: Set<number>,
): void {
  const sourceEntries = originalIndices.flatMap((idx) => {
    const entry = entries[idx];
    return entry ? [entry] : [];
  });
  if (sourceEntries.length < CONDENSATION_CLUSTER_MIN) return;
  if (sourceEntries.some((entry) => entry.promotionEvidence || entry.nonglobal)) return;

  const compound: LearningEntry = {
    category: pickCategory(sourceEntries),
    cwds: [candidate.cwd],
    exposures: mergeExposures(sourceEntries),
    nonglobal: sourceEntries.some((e) => e.nonglobal),
    title: cluster.title,
    body: cluster.body,
  };

  const insertAt = Math.min(...originalIndices);
  const existing = state.insertions.get(insertAt);
  if (existing) {
    existing.push(compound);
  } else {
    state.insertions.set(insertAt, [compound]);
  }
  state.compoundsCreated++;

  for (const originalIdx of originalIndices) {
    const entry = entries[originalIdx];
    if (!entry) continue;
    state.archivedIndices.add(originalIdx);
    candidateConsumed.add(originalIdx);
    narrowOrConsumeEntry(originalIdx, entry, candidate.cwd, state);
  }
}

function narrowOrConsumeEntry(
  idx: number,
  entry: LearningEntry,
  candidateCwd: string,
  state: ApplyState,
): void {
  // Use the already-narrowed CWD list if this entry was processed by a previous candidate,
  // otherwise start from the original entry's CWDs.
  const currentCwds = state.narrowed.get(idx) ?? entry.cwds;
  const remaining = currentCwds.filter((c) => c !== candidateCwd);

  if (remaining.length > 0) {
    state.narrowed.set(idx, remaining);
  } else {
    state.consumed.add(idx);
  }
}

function buildResultArray(entries: LearningEntry[], state: ApplyState): LearningEntry[] {
  const result: LearningEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const compounds = state.insertions.get(i);
    if (compounds) result.push(...compounds);
    if (state.consumed.has(i)) continue;

    const remainingCwds = state.narrowed.get(i);
    if (remainingCwds) {
      if (remainingCwds.length === 0) continue;
      const entry = entries[i];
      if (entry) result.push({ ...entry, cwds: remainingCwds });
      continue;
    }

    const entry = entries[i];
    if (entry) result.push(entry);
  }

  return result;
}

/**
 * Apply condensation clusters to produce a new entries array.
 * No I/O — all state changes are internal. Handles multi-CWD narrowing,
 * overlapping clusters, and insertion-point ordering.
 */
export function applyCondensation(
  entries: LearningEntry[],
  candidatesWithClusters: CandidateWithClusters[],
): CondensationResult {
  const state: ApplyState = {
    consumed: new Set(),
    insertions: new Map(),
    archivedIndices: new Set(),
    narrowed: new Map(),
    compoundsCreated: 0,
  };

  for (const { candidate, clusters } of candidatesWithClusters) {
    const candidateConsumed = new Set<number>();

    for (const cluster of clusters) {
      const originalIndices = resolveClusterIndices(
        cluster,
        candidate,
        candidateConsumed,
        state.consumed,
      );
      if (!originalIndices) continue;
      processCluster(cluster, candidate, originalIndices, entries, state, candidateConsumed);
    }
  }

  const archived = [...state.archivedIndices]
    .sort((a, b) => a - b)
    .flatMap((idx) => {
      const entry = entries[idx];
      return entry ? [entry] : [];
    });

  return {
    entries: buildResultArray(entries, state),
    archived,
    compoundsCreated: state.compoundsCreated,
  };
}

// --- Orchestration ---

const CONSOLIDATION_THRESHOLD = 20;

/** Pass 1: Identify and merge duplicate entries via LLM. */
export async function deduplicateEntries(
  entries: LearningEntry[],
  provider?: ProviderName,
): Promise<DuplicateApplicationResult> {
  const prompt = buildDuplicatePrompt(entries);
  const result = await inference({ userPrompt: prompt, provider, timeout: 30000 });

  if (!result.success || !result.text) return applyDuplicateMerges(entries, []);

  const groups = parseDuplicateOutput(result.text);
  return applyDuplicateMerges(entries, groups);
}

/** Pass 2: Identify and resolve contradicting entries via LLM. */
export async function resolveEntryContradictions(
  entries: LearningEntry[],
  provider?: ProviderName,
): Promise<ContradictionApplicationResult> {
  const prompt = buildContradictionPrompt(entries);
  const result = await inference({ userPrompt: prompt, provider, timeout: 30000 });

  if (!result.success || !result.text) return resolveContradictions(entries, []);

  const pairs = parseContradictionOutput(result.text);
  return resolveContradictions(entries, pairs);
}

/**
 * Pass 3: Condensation. Groups high-exposure entries by CWD, asks the LLM
 * to cluster related entries, then merges each cluster into a compound entry.
 */
export async function condenseEntries(
  entries: LearningEntry[],
  provider?: ProviderName,
): Promise<CondensationResult> {
  const candidates = findCondensationCandidates(entries);
  if (candidates.length === 0) {
    return { entries, archived: [], compoundsCreated: 0 };
  }

  const candidatesWithClusters: CandidateWithClusters[] = [];

  for (const candidate of candidates) {
    const prompt = buildCondensationPrompt(candidate.entries);
    const result = await inference({ userPrompt: prompt, provider, timeout: 30000 });

    if (!result.success || !result.text) {
      console.error(`Condensation inference failed for ${candidate.cwd}. Skipping.`);
      continue;
    }

    const clusters = parseCondensationOutput(result.text);
    if (clusters.length === 0) {
      console.error(`No clusters found for ${candidate.cwd}.`);
      continue;
    }

    candidatesWithClusters.push({ candidate, clusters });
  }

  if (candidatesWithClusters.length === 0) {
    return { entries, archived: [], compoundsCreated: 0 };
  }

  return applyCondensation(entries, candidatesWithClusters);
}

/** Result of running all consolidation passes. */
export interface ConsolidationResult {
  readonly entries: LearningEntry[];
  readonly archived: LearningEntry[];
  readonly compoundsCreated: number;
  readonly deduplicatedCount: number;
  readonly duplicateScopeNarrowedCount: number;
  readonly unresolvedDuplicateCount: number;
  readonly duplicateOverlapNoopCount: number;
  readonly contradictionsResolved: number;
  readonly unresolvedContradictionCount: number;
  readonly contradictionOverlapNoopCount: number;
}

/**
 * Run all consolidation passes: dedup, contradictions, condensation.
 * Passes 1-2 are gated by CONSOLIDATION_THRESHOLD (20 entries).
 * Pass 3 always runs (cheap pure-code gate).
 *
 * Callers must publish `result.entries` and `result.archived` together through
 * the recoverable condensation commit so source entries cannot be lost or
 * archived twice across an interrupted two-file move.
 */
export async function runFullConsolidation(
  entries: LearningEntry[],
  provider?: ProviderName,
): Promise<ConsolidationResult> {
  let current = entries;
  let deduplicatedCount = 0;
  let duplicateScopeNarrowedCount = 0;
  let unresolvedDuplicateCount = 0;
  let duplicateOverlapNoopCount = 0;
  let contradictionsResolved = 0;
  let unresolvedContradictionCount = 0;
  let contradictionOverlapNoopCount = 0;

  if (current.length >= CONSOLIDATION_THRESHOLD) {
    const duplicateResult = await deduplicateEntries(current, provider);
    current = duplicateResult.entries;
    deduplicatedCount = duplicateResult.mergedCount;
    duplicateScopeNarrowedCount = duplicateResult.scopeNarrowedCount;
    unresolvedDuplicateCount = duplicateResult.unresolvedCount;
    duplicateOverlapNoopCount = duplicateResult.overlappingNoopCount;

    const contradictionResult = await resolveEntryContradictions(current, provider);
    current = contradictionResult.entries;
    contradictionsResolved = contradictionResult.resolvedCount;
    unresolvedContradictionCount = contradictionResult.unresolvedCount;
    contradictionOverlapNoopCount = contradictionResult.overlappingNoopCount;
  }

  const condensation = await condenseEntries(current, provider);

  return {
    entries: condensation.entries,
    archived: condensation.archived,
    compoundsCreated: condensation.compoundsCreated,
    deduplicatedCount,
    duplicateScopeNarrowedCount,
    unresolvedDuplicateCount,
    duplicateOverlapNoopCount,
    contradictionsResolved,
    unresolvedContradictionCount,
    contradictionOverlapNoopCount,
  };
}
