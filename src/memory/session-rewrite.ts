import { type Exposure, normalizeCwdPath } from "./learning-scope";
import type { LearningCategory, LearningEntry, SessionLearningDraft } from "./learnings";
import { arePathsRelated, isPathRelated } from "./utils";

const VALID_CATEGORIES = new Set<LearningCategory>(["correction", "preference", "pattern", "fact"]);

export interface SessionRewriteContext {
  readonly date: string;
  readonly sessionHash: string;
  readonly currentCwd: string;
}

export interface SessionRewriteCounts {
  readonly appended: number;
  readonly rewritten: number;
  readonly reinforced: number;
  readonly suppressed: number;
  readonly ambiguousTitles: number;
  readonly primaryExposuresRemoved: number;
  readonly orphansRemoved: number;
  readonly durableEntriesRetained: number;
}

export interface SessionRewriteResult {
  readonly entries: readonly LearningEntry[];
  readonly counts: SessionRewriteCounts;
}

export type SessionRewriteValidationIssueCode =
  | "invalid-draft"
  | "unknown-draft-field"
  | "invalid-category"
  | "invalid-title"
  | "invalid-body"
  | "invalid-date"
  | "invalid-session-hash"
  | "invalid-current-cwd";

export interface SessionRewriteValidationIssue {
  readonly code: SessionRewriteValidationIssueCode;
  readonly message: string;
  readonly draftIndex?: number;
}

export type SessionRewriteValidationResult =
  | {
      readonly ok: true;
      readonly extracted: readonly SessionLearningDraft[];
      readonly context: SessionRewriteContext;
    }
  | { readonly ok: false; readonly issues: readonly SessionRewriteValidationIssue[] };

export class SessionRewriteValidationError extends Error {
  readonly issues: readonly SessionRewriteValidationIssue[];

  constructor(issues: readonly SessionRewriteValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "SessionRewriteValidationError";
    this.issues = issues;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeCwdPath(value) ?? value))].sort(
    compareCodeUnits,
  );
}

function exposureKey(exposure: { readonly date: string; readonly sessionHash: string }): string {
  return JSON.stringify([exposure.date, exposure.sessionHash]);
}

function mergeExposures(
  exposures: readonly { readonly date: string; readonly sessionHash: string }[],
): { date: string; sessionHash: string }[] {
  const byIdentity = new Map(
    exposures.map((exposure) => [exposureKey(exposure), { ...exposure }] as const),
  );
  return [...byIdentity.values()].sort(
    (left, right) =>
      compareCodeUnits(left.date, right.date) ||
      compareCodeUnits(left.sessionHash, right.sessionHash),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDraft(value: unknown, draftIndex: number): SessionRewriteValidationIssue[] {
  if (!isRecord(value)) {
    return [{ code: "invalid-draft", draftIndex, message: "A learning draft must be an object." }];
  }

  const issues: SessionRewriteValidationIssue[] = [];
  if (Object.keys(value).some((key) => key !== "category" && key !== "title" && key !== "body")) {
    issues.push({
      code: "unknown-draft-field",
      draftIndex,
      message: "A learning draft may contain only category, title, and body.",
    });
  }
  if (
    typeof value.category !== "string" ||
    !VALID_CATEGORIES.has(value.category as LearningCategory)
  ) {
    issues.push({
      code: "invalid-category",
      draftIndex,
      message: "A learning draft must use a supported category.",
    });
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    issues.push({
      code: "invalid-title",
      draftIndex,
      message: "A learning draft must have a non-empty title.",
    });
  }
  if (typeof value.body !== "string") {
    issues.push({
      code: "invalid-body",
      draftIndex,
      message: "A learning draft body must be a string.",
    });
  }
  return issues;
}

interface ContextValidation {
  readonly currentCwd?: string;
  readonly issues: readonly SessionRewriteValidationIssue[];
}

function validateContext(context: SessionRewriteContext): ContextValidation {
  const issues: SessionRewriteValidationIssue[] = [];
  if (typeof context.date !== "string" || !isCalendarDate(context.date)) {
    issues.push({
      code: "invalid-date",
      message: "The rewrite date must be a valid YYYY-MM-DD date.",
    });
  }
  if (typeof context.sessionHash !== "string" || context.sessionHash.length === 0) {
    issues.push({
      code: "invalid-session-hash",
      message: "The rewrite session hash must be non-empty.",
    });
  }

  const currentCwd =
    typeof context.currentCwd === "string" ? normalizeCwdPath(context.currentCwd) : undefined;
  if (!currentCwd) {
    issues.push({
      code: "invalid-current-cwd",
      message: "The rewrite CWD must be a normalizable absolute path.",
    });
  }
  return { currentCwd, issues };
}

export function validateSessionRewriteInput(
  extracted: readonly SessionLearningDraft[],
  context: SessionRewriteContext,
): SessionRewriteValidationResult {
  const draftIssues = extracted.flatMap((draft, index) => validateDraft(draft, index));
  const contextValidation = validateContext(context);
  const issues = [...draftIssues, ...contextValidation.issues];

  if (issues.length > 0 || !contextValidation.currentCwd) return { ok: false, issues };
  return {
    ok: true,
    extracted,
    context: { ...context, currentCwd: contextValidation.currentCwd },
  };
}

type EntrySlot = LearningEntry | undefined;
type MutableCounts = {
  -readonly [Key in keyof SessionRewriteCounts]: SessionRewriteCounts[Key];
};

interface RetractionResult {
  readonly entries: EntrySlot[];
  readonly primaryExposuresRemoved: number;
  readonly durableRetentionCandidates: ReadonlySet<number>;
  readonly orphanCandidates: ReadonlySet<number>;
}

function groupEntryIndexes(entries: readonly LearningEntry[]): ReadonlyMap<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const [index, entry] of entries.entries()) {
    const group = groups.get(entry.title) ?? [];
    group.push(index);
    groups.set(entry.title, group);
  }
  return groups;
}

function collapseDrafts(drafts: readonly SessionLearningDraft[]): SessionLearningDraft[] {
  const collapsed: SessionLearningDraft[] = [];
  const titles = new Set<string>();
  for (const draft of drafts) {
    if (titles.has(draft.title)) continue;
    titles.add(draft.title);
    collapsed.push(draft);
  }
  return collapsed;
}

function retractPrimaryExposures(
  existing: readonly LearningEntry[],
  sessionHash: string,
): RetractionResult {
  let primaryExposuresRemoved = 0;
  const durableRetentionCandidates = new Set<number>();
  const orphanCandidates = new Set<number>();
  const entries = existing.map<EntrySlot>((entry, index) => {
    const remaining = entry.exposures.filter((item) => item.sessionHash !== sessionHash);
    const removed = entry.exposures.length - remaining.length;
    primaryExposuresRemoved += removed;
    if (removed === 0) return entry;
    if (remaining.length > 0) return { ...entry, exposures: remaining };
    if (entry.promotionEvidence || entry.nonglobal) {
      durableRetentionCandidates.add(index);
      return { ...entry, exposures: [] };
    }
    orphanCandidates.add(index);
    return undefined;
  });
  return {
    entries,
    primaryExposuresRemoved,
    durableRetentionCandidates,
    orphanCandidates,
  };
}

function entryFromDraft(
  draft: SessionLearningDraft,
  currentCwd: string,
  exposure: Exposure,
): LearningEntry {
  return {
    category: draft.category,
    cwds: [currentCwd],
    exposures: [exposure],
    nonglobal: false,
    title: draft.title,
    body: draft.body,
  };
}

function reinforceEntry(
  entry: LearningEntry,
  currentCwd: string,
  exposure: Exposure,
): LearningEntry {
  const promotionEvidence = entry.promotionEvidence
    ? {
        ...entry.promotionEvidence,
        sourceCwds: normalizedStrings([...entry.promotionEvidence.sourceCwds, currentCwd]),
        exposures: mergeExposures([...entry.promotionEvidence.exposures, exposure]),
      }
    : undefined;
  const cwds =
    entry.cwds.includes("*") || entry.cwds.some((cwd) => isPathRelated(cwd, currentCwd))
      ? entry.cwds
      : normalizedStrings([...entry.cwds, currentCwd]);
  return {
    ...entry,
    cwds: [...cwds],
    exposures: mergeExposures([...entry.exposures, exposure]),
    ...(promotionEvidence ? { promotionEvidence } : {}),
  };
}

interface DraftApplicationState {
  readonly existing: readonly LearningEntry[];
  readonly entries: EntrySlot[];
  readonly titleGroups: ReadonlyMap<string, readonly number[]>;
  readonly currentCwd: string;
  readonly exposure: Exposure;
  readonly counts: MutableCounts;
}

function applyDraft(draft: SessionLearningDraft, state: DraftApplicationState): void {
  const group = state.titleGroups.get(draft.title);
  if (!group) {
    state.counts.appended++;
    state.entries.push(entryFromDraft(draft, state.currentCwd, state.exposure));
    return;
  }
  if (group.length !== 1) {
    state.counts.ambiguousTitles++;
    return;
  }

  const index = group[0];
  const original = index === undefined ? undefined : state.existing[index];
  if (!original || index === undefined) return;
  if (
    original.promotionEvidence?.excludedCwds.some((excludedCwd) =>
      arePathsRelated(excludedCwd, state.currentCwd),
    )
  ) {
    state.counts.suppressed++;
    return;
  }

  const entry = state.entries[index];
  if (!entry) {
    state.counts.rewritten++;
    state.entries[index] = entryFromDraft(draft, state.currentCwd, state.exposure);
    return;
  }
  state.counts.reinforced++;
  state.entries[index] = reinforceEntry(entry, state.currentCwd, state.exposure);
}

function countFinalCandidates(
  entries: readonly EntrySlot[],
  candidates: ReadonlySet<number>,
  predicate: (entry: EntrySlot) => boolean,
): number {
  let count = 0;
  for (const index of candidates) {
    if (predicate(entries[index])) count++;
  }
  return count;
}

export function rewriteSessionLearnings(
  existing: readonly LearningEntry[],
  extracted: readonly SessionLearningDraft[],
  context: SessionRewriteContext,
): SessionRewriteResult {
  const validation = validateSessionRewriteInput(extracted, context);
  if (!validation.ok) throw new SessionRewriteValidationError(validation.issues);
  const rewriteContext = validation.context;
  const currentCwd = rewriteContext.currentCwd;
  const exposure = { date: rewriteContext.date, sessionHash: rewriteContext.sessionHash };
  const retraction = retractPrimaryExposures(existing, rewriteContext.sessionHash);
  const counts: MutableCounts = {
    appended: 0,
    rewritten: 0,
    reinforced: 0,
    suppressed: 0,
    ambiguousTitles: 0,
    primaryExposuresRemoved: retraction.primaryExposuresRemoved,
    orphansRemoved: 0,
    durableEntriesRetained: 0,
  };
  const state: DraftApplicationState = {
    existing,
    entries: retraction.entries,
    titleGroups: groupEntryIndexes(existing),
    currentCwd,
    exposure,
    counts,
  };
  for (const draft of collapseDrafts(extracted)) applyDraft(draft, state);

  counts.durableEntriesRetained = countFinalCandidates(
    state.entries,
    retraction.durableRetentionCandidates,
    (entry) => entry?.exposures.length === 0,
  );
  counts.orphansRemoved = countFinalCandidates(
    state.entries,
    retraction.orphanCandidates,
    (entry) => entry === undefined,
  );

  return {
    entries: state.entries.filter((entry): entry is LearningEntry => entry !== undefined),
    counts,
  };
}
