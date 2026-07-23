import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { arePathsRelated, isPathRelated } from "./utils";

export interface Exposure {
  readonly date: string;
  readonly sessionHash: string;
}

export type PromotionReason =
  | "automatic-cross-project-threshold"
  | "automatic-hierarchical-generalization"
  | "manual-cross-project-review"
  | "legacy-source-reconstruction"
  | "manual-global-review"
  | "manual-common-ancestor-review"
  | "manual-scope-correction"
  | "contradiction-scope-subtraction";

export interface PromotionEvidence {
  readonly sourceCwds: readonly string[];
  readonly excludedCwds: readonly string[];
  readonly exposures: readonly Exposure[];
  readonly reasons: readonly PromotionReason[];
}

export interface LearningScopeState {
  readonly cwds: readonly string[];
  readonly promotionEvidence?: PromotionEvidence;
  readonly nonglobal: boolean;
}

export type ScopeValidationIssueCode =
  | "already-inapplicable"
  | "no-effective-sources"
  | "invalid-path"
  | "invalid-ancestor"
  | "scope-matches-exclusion"
  | "exclusion-not-found"
  | "ambiguous-exclusion"
  | "not-eligible"
  | "invalid-global-shape"
  | "invalid-evidence"
  | "invalid-persisted-state";

export interface ScopeValidationIssue {
  readonly code: ScopeValidationIssueCode;
  readonly message: string;
}

export type ScopeTransitionResult =
  | { readonly ok: true; readonly state: LearningScopeState }
  | { readonly ok: false; readonly issue: ScopeValidationIssue };

export type ScopeGeneralizationResult =
  | {
      readonly ok: true;
      readonly state: LearningScopeState;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly issue: ScopeValidationIssue };

export type ScopeChoice =
  | { readonly kind: "exact-sources" }
  | {
      readonly kind: "confirmed-ancestor";
      readonly cwd: string;
      readonly forbiddenRoots: readonly string[];
    };

export interface NarrowScopeOptions {
  readonly assertedSourceCwds?: readonly string[];
  readonly supportingExposures?: readonly Exposure[];
  readonly scopeChoice?: ScopeChoice;
}

export interface NarrowScopeForExclusionsOptions {
  readonly supportingExposures?: readonly Exposure[];
}

export type ReviewedScopeChoice =
  | { readonly kind: "global" }
  | { readonly kind: "keep-current" }
  | {
      readonly kind: "confirmed-ancestor";
      readonly cwd: string;
      readonly forbiddenRoots: readonly string[];
    };

function withoutTrailingSeparator(path: string): string {
  return path === parse(path).root || !path.endsWith(sep) ? path : path.slice(0, -1);
}

/** Normalize a lexical CWD without consulting the filesystem. */
export function normalizeCwdPath(cwd: string, baseCwd?: string): string | undefined {
  if (cwd.length === 0) return undefined;
  if (isAbsolute(cwd)) return withoutTrailingSeparator(normalize(cwd));
  if (!baseCwd || !isAbsolute(baseCwd)) return undefined;
  return withoutTrailingSeparator(normalize(resolve(baseCwd, cwd)));
}

function pathDepth(path: string): number {
  const fromRoot = relative(parse(path).root, path);
  return fromRoot.length === 0 ? 0 : fromRoot.split(sep).length;
}

/** Collapse equal and ancestor/descendant paths to their shallowest covering roots. */
export function independentPositiveRoots(cwds: readonly string[]): string[] {
  const normalized = [...new Set(cwds.flatMap((cwd) => normalizeCwdPath(cwd) ?? []))].sort(
    (left, right) =>
      pathDepth(left) - pathDepth(right) || (left < right ? -1 : left > right ? 1 : 0),
  );

  const roots: string[] = [];
  for (const cwd of normalized) {
    if (!roots.some((root) => arePathsRelated(root, cwd))) roots.push(cwd);
  }
  return roots.sort();
}

/** Return normalized positive evidence not invalidated by any related exclusion. */
export function effectiveSourceCwds(evidence: PromotionEvidence): string[] {
  const sources = [...new Set(evidence.sourceCwds.flatMap((cwd) => normalizeCwdPath(cwd) ?? []))];
  const exclusions = [
    ...new Set(evidence.excludedCwds.flatMap((cwd) => normalizeCwdPath(cwd) ?? [])),
  ];
  return sources
    .filter((source) => !exclusions.some((exclusion) => arePathsRelated(source, exclusion)))
    .sort();
}

function pathComparisonKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Propose the deepest shared lexical ancestor, excluding exact forbidden roots. */
export function findCommonAncestorCandidate(
  cwds: readonly string[],
  forbiddenRoots: readonly string[],
): string | undefined {
  if (cwds.length === 0) return undefined;

  const normalized = cwds.map((cwd) => normalizeCwdPath(cwd));
  if (normalized.some((cwd) => cwd === undefined)) return undefined;
  const paths = normalized as string[];
  const root = parse(paths[0] ?? "").root;
  if (!root) return undefined;
  const rootKey = pathComparisonKey(root);
  if (paths.some((cwd) => pathComparisonKey(parse(cwd).root) !== rootKey)) return undefined;

  const segmentLists = paths.map((cwd) => {
    const fromRoot = relative(parse(cwd).root, cwd);
    return fromRoot.length === 0 ? [] : fromRoot.split(sep);
  });
  const firstSegments = segmentLists[0] ?? [];
  const commonSegments: string[] = [];
  for (let index = 0; index < firstSegments.length; index++) {
    const segment = firstSegments[index];
    if (
      segment === undefined ||
      segmentLists.some(
        (segments) => pathComparisonKey(segments[index] ?? "") !== pathComparisonKey(segment),
      )
    )
      break;
    commonSegments.push(segment);
  }

  const candidate = normalizeCwdPath(join(root, ...commonSegments));
  if (!candidate || candidate === parse(candidate).root) return undefined;

  const forbidden = forbiddenRoots.map((cwd) => normalizeCwdPath(cwd));
  if (
    forbidden.some(
      (cwd) => cwd === undefined || pathComparisonKey(cwd) === pathComparisonKey(candidate),
    )
  )
    return undefined;
  return candidate;
}

type ScopeValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issue: ScopeValidationIssue };

function invalidScope(code: ScopeValidationIssueCode, message: string): ScopeValidationResult {
  return { ok: false, issue: { code, message } };
}

function isCanonicalPathArray(cwds: readonly string[]): boolean {
  if (cwds.some((cwd) => normalizeCwdPath(cwd) !== cwd)) return false;
  const canonical = [...new Set(cwds)].sort();
  return canonical.length === cwds.length && canonical.every((cwd, index) => cwd === cwds[index]);
}

function validateActiveScope(state: LearningScopeState): ScopeValidationResult {
  if (state.cwds.length === 0) {
    return invalidScope("invalid-persisted-state", "A learning must have an active CWD scope.");
  }
  if (state.cwds.includes("*") && (state.cwds.length !== 1 || state.cwds[0] !== "*")) {
    return invalidScope("invalid-global-shape", 'Global scope must be represented only as ["*"].');
  }
  if (state.cwds.some((cwd) => cwd !== "*" && normalizeCwdPath(cwd) !== cwd)) {
    return invalidScope(
      "invalid-path",
      "Persisted learning scopes must use normalized absolute paths.",
    );
  }
  if (state.cwds[0] === "*" && state.nonglobal) {
    return invalidScope("invalid-persisted-state", "A global learning cannot be marked nonglobal.");
  }
  return { ok: true };
}

function validateEvidence(evidence: PromotionEvidence | undefined): ScopeValidationResult {
  if (!evidence) return { ok: true };
  if (evidence.sourceCwds.length === 0 || evidence.reasons.length === 0) {
    return invalidScope(
      "invalid-evidence",
      "Promotion evidence requires at least one positive source and one reason.",
    );
  }
  if (!isCanonicalPathArray(evidence.sourceCwds) || !isCanonicalPathArray(evidence.excludedCwds)) {
    return invalidScope(
      "invalid-evidence",
      "Promotion evidence paths must be normalized, absolute, unique, and sorted.",
    );
  }
  return { ok: true };
}

function validateEvidenceCoverage(state: LearningScopeState): ScopeValidationResult {
  const evidence = state.promotionEvidence;
  if (!evidence) return { ok: true };
  if (state.cwds.includes("*") && evidence.excludedCwds.length > 0) {
    return invalidScope(
      "scope-matches-exclusion",
      "A global learning cannot retain an excluded CWD.",
    );
  }
  if (
    evidence.excludedCwds.some((exclusion) =>
      state.cwds.some((cwd) => arePathsRelated(cwd, exclusion)),
    )
  ) {
    return invalidScope(
      "scope-matches-exclusion",
      "An active learning scope cannot be related to an excluded CWD.",
    );
  }
  if (state.cwds[0] === "*") return { ok: true };

  const effectiveSources = effectiveSourceCwds(evidence);
  if (effectiveSources.length === 0) {
    return invalidScope(
      "invalid-evidence",
      "Promotion evidence must retain at least one effective positive source.",
    );
  }
  if (
    effectiveSources.some(
      (source) => !state.cwds.some((activeCwd) => isPathRelated(activeCwd, source)),
    )
  ) {
    return invalidScope(
      "invalid-persisted-state",
      "The active scope must cover every effective positive source.",
    );
  }
  return { ok: true };
}

/** Validate the persisted relationship between active scope and supporting evidence. */
export function validateLearningScope(state: LearningScopeState): ScopeValidationResult {
  const active = validateActiveScope(state);
  if (!active.ok) return active;

  const evidence = validateEvidence(state.promotionEvidence);
  if (!evidence.ok) return evidence;

  return validateEvidenceCoverage(state);
}

function transitionFailure(
  code: ScopeValidationIssueCode,
  message: string,
): Extract<ScopeTransitionResult, { readonly ok: false }> {
  return { ok: false, issue: { code, message } };
}

function normalizedAbsolutePath(cwd: string): string | undefined {
  return isAbsolute(cwd) ? normalizeCwdPath(cwd) : undefined;
}

function canonicalPaths(cwds: readonly string[]): string[] | undefined {
  const normalized = cwds.map(normalizedAbsolutePath);
  if (normalized.some((cwd) => cwd === undefined)) return undefined;
  return [...new Set(normalized as string[])].sort();
}

/** Canonicalize evidence collections before a validated state transition is persisted. */
export function normalizePromotionEvidence(evidence: PromotionEvidence): PromotionEvidence {
  return {
    sourceCwds: canonicalPaths(evidence.sourceCwds) ?? [],
    excludedCwds: canonicalPaths(evidence.excludedCwds) ?? [],
    exposures: evidence.exposures.map((exposure) => ({ ...exposure })),
    reasons: [...new Set(evidence.reasons)].sort(),
  };
}

function activeScopeMatches(state: LearningScopeState, cwd: string): boolean {
  return state.cwds[0] === "*" || state.cwds.some((activeCwd) => arePathsRelated(activeCwd, cwd));
}

function chooseActiveScope(
  effectiveSources: readonly string[],
  exclusions: readonly string[],
  choice: ScopeChoice | undefined,
):
  | { readonly ok: true; readonly cwds: readonly string[] }
  | { readonly ok: false; readonly issue: ScopeValidationIssue } {
  if (!choice || choice.kind === "exact-sources") {
    return { ok: true, cwds: independentPositiveRoots(effectiveSources) };
  }

  const requestedAncestor = normalizedAbsolutePath(choice.cwd);
  const candidate = findCommonAncestorCandidate(effectiveSources, choice.forbiddenRoots);
  if (!requestedAncestor || !candidate || requestedAncestor !== candidate) {
    return {
      ok: false,
      issue: {
        code: "invalid-ancestor",
        message: "The confirmed CWD is not the current common-ancestor candidate.",
      },
    };
  }
  if (exclusions.some((exclusion) => arePathsRelated(candidate, exclusion))) {
    return {
      ok: false,
      issue: {
        code: "scope-matches-exclusion",
        message: "The common ancestor would reactivate an excluded CWD.",
      },
    };
  }
  return { ok: true, cwds: [candidate] };
}

type PreparedEvidence =
  | {
      readonly ok: true;
      readonly evidence: PromotionEvidence;
      readonly effectiveSources: readonly string[];
    }
  | { readonly ok: false; readonly issue: ScopeValidationIssue };

type EvidenceResult =
  | { readonly ok: true; readonly evidence: PromotionEvidence }
  | { readonly ok: false; readonly issue: ScopeValidationIssue };

function anyPathsRelated(leftPaths: readonly string[], rightPaths: readonly string[]): boolean {
  return leftPaths.some((left) => rightPaths.some((right) => arePathsRelated(left, right)));
}

function correctionEvidenceBase(
  state: LearningScopeState,
  assertedSources: readonly string[],
  supportingExposures: readonly Exposure[] | undefined,
): EvidenceResult {
  if (state.promotionEvidence) return { ok: true, evidence: state.promotionEvidence };

  const bootstrappedSources = state.cwds[0] === "*" ? [] : canonicalPaths(state.cwds);
  if (!bootstrappedSources) {
    return transitionFailure(
      "invalid-persisted-state",
      "Scoped learning paths must be absolute before evidence can be created.",
    );
  }
  if (bootstrappedSources.length + assertedSources.length === 0) {
    return transitionFailure(
      "no-effective-sources",
      "Narrowing this learning requires at least one explicit positive source.",
    );
  }
  if (supportingExposures === undefined) {
    return transitionFailure(
      "invalid-evidence",
      "Creating correction evidence requires an explicit supporting exposure snapshot.",
    );
  }
  return {
    ok: true,
    evidence: {
      sourceCwds: bootstrappedSources,
      excludedCwds: [],
      exposures: supportingExposures.map((exposure) => ({ ...exposure })),
      reasons: ["manual-scope-correction"],
    },
  };
}

function prepareCorrectionEvidence(
  state: LearningScopeState,
  exclusion: string,
  options: NarrowScopeOptions,
): PreparedEvidence {
  const assertedSources = canonicalPaths(options.assertedSourceCwds ?? []);
  if (!assertedSources) {
    return transitionFailure("invalid-path", "Asserted source CWDs must be absolute paths.");
  }

  const base = correctionEvidenceBase(state, assertedSources, options.supportingExposures);
  if (!base.ok) return base;
  const baseEvidence = base.evidence;
  const exclusions = canonicalPaths([...baseEvidence.excludedCwds, exclusion]) ?? [];
  const assertionConflicts = anyPathsRelated(assertedSources, exclusions);
  if (assertionConflicts) {
    return transitionFailure(
      "scope-matches-exclusion",
      "An asserted positive source cannot be related to an excluded CWD.",
    );
  }

  const evidence = normalizePromotionEvidence({
    ...baseEvidence,
    sourceCwds: [...baseEvidence.sourceCwds, ...assertedSources],
    excludedCwds: exclusions,
    reasons: [...baseEvidence.reasons, "manual-scope-correction"],
  });
  const effectiveSources = effectiveSourceCwds(evidence);
  return effectiveSources.length > 0
    ? { ok: true, evidence, effectiveSources }
    : transitionFailure(
        "no-effective-sources",
        "The exclusion would remove every known positive source.",
      );
}

function validatedTransition(state: LearningScopeState): ScopeTransitionResult {
  const validation = validateLearningScope(state);
  return validation.ok
    ? { ok: true, state }
    : transitionFailure(validation.issue.code, validation.issue.message);
}

/** Derive a scoped correction without mutating the persisted state. */
export function narrowScopeForExclusion(
  state: LearningScopeState,
  excludedCwd: string,
  options: NarrowScopeOptions = {},
): ScopeTransitionResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) return transitionFailure("invalid-persisted-state", persisted.issue.message);

  const exclusion = normalizedAbsolutePath(excludedCwd);
  if (!exclusion) {
    return transitionFailure("invalid-path", "An excluded CWD must be an absolute path.");
  }
  if (state.promotionEvidence?.excludedCwds.includes(exclusion)) {
    return { ok: true, state };
  }
  if (!activeScopeMatches(state, exclusion)) {
    return transitionFailure(
      "already-inapplicable",
      "The target CWD is already outside the active learning scope.",
    );
  }

  const prepared = prepareCorrectionEvidence(state, exclusion, options);
  if (!prepared.ok) return { ok: false, issue: prepared.issue };

  const activeScope = chooseActiveScope(
    prepared.effectiveSources,
    prepared.evidence.excludedCwds,
    options.scopeChoice,
  );
  if (!activeScope.ok) return { ok: false, issue: activeScope.issue };

  const nextState: LearningScopeState = {
    cwds: activeScope.cwds,
    promotionEvidence: prepared.evidence,
    nonglobal: true,
  };
  return validatedTransition(nextState);
}

/** Atomically subtract exact contradiction roots without changing reviewed widening intent. */
export function narrowScopeForExclusions(
  state: LearningScopeState,
  excludedCwds: readonly string[],
  options: NarrowScopeForExclusionsOptions = {},
): ScopeTransitionResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) return transitionFailure("invalid-persisted-state", persisted.issue.message);

  const exclusionsToAdd = canonicalPaths(excludedCwds);
  if (!exclusionsToAdd) {
    return transitionFailure("invalid-path", "Excluded CWDs must be absolute paths.");
  }
  if (exclusionsToAdd.length === 0) return { ok: true, state };

  const existingExclusions = state.promotionEvidence?.excludedCwds ?? [];
  const newExclusions = exclusionsToAdd.filter(
    (exclusion) => !existingExclusions.includes(exclusion),
  );
  if (newExclusions.length === 0) return { ok: true, state };
  if (newExclusions.some((exclusion) => !activeScopeMatches(state, exclusion))) {
    return transitionFailure(
      "already-inapplicable",
      "At least one subtraction CWD is outside the active learning scope.",
    );
  }

  const bootstrappedSources = state.cwds[0] === "*" ? [] : canonicalPaths(state.cwds);
  if (!state.promotionEvidence && bootstrappedSources?.length && !options.supportingExposures) {
    return transitionFailure(
      "invalid-evidence",
      "Creating contradiction evidence requires an explicit supporting exposure snapshot.",
    );
  }
  const baseEvidence: PromotionEvidence | undefined =
    state.promotionEvidence ??
    (bootstrappedSources && bootstrappedSources.length > 0
      ? {
          sourceCwds: bootstrappedSources,
          excludedCwds: [],
          exposures: (options.supportingExposures ?? []).map((exposure) => ({ ...exposure })),
          reasons: ["contradiction-scope-subtraction"],
        }
      : undefined);
  if (!baseEvidence) {
    return transitionFailure(
      "no-effective-sources",
      "Contradiction subtraction requires known positive sources.",
    );
  }

  const evidence = normalizePromotionEvidence({
    ...baseEvidence,
    excludedCwds: [...baseEvidence.excludedCwds, ...newExclusions],
    reasons: [...baseEvidence.reasons, "contradiction-scope-subtraction"],
  });
  const effectiveSources = effectiveSourceCwds(evidence);
  if (effectiveSources.length === 0) {
    return transitionFailure(
      "no-effective-sources",
      "The subtraction would remove every known positive source.",
    );
  }

  const nextState: LearningScopeState = {
    cwds: independentPositiveRoots(effectiveSources),
    promotionEvidence: evidence,
    nonglobal: state.nonglobal,
  };
  return validatedTransition(nextState);
}

/** Derive the state produced by removing one exact stored exclusion. */
export function includeCwdInScope(
  state: LearningScopeState,
  targetCwd: string,
  exclusionToRemove: string,
): ScopeTransitionResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) return transitionFailure("invalid-persisted-state", persisted.issue.message);

  const target = normalizedAbsolutePath(targetCwd);
  const selectedExclusion = normalizedAbsolutePath(exclusionToRemove);
  if (!target || !selectedExclusion) {
    return transitionFailure(
      "invalid-path",
      "Included CWDs and selected exclusions must be absolute paths.",
    );
  }

  const existingEvidence = state.promotionEvidence;
  if (!existingEvidence) {
    return transitionFailure(
      "exclusion-not-found",
      "The selected exclusion does not affect the target CWD.",
    );
  }
  if (!existingEvidence.excludedCwds.includes(selectedExclusion)) {
    const matchingExclusions = existingEvidence.excludedCwds.filter((exclusion) =>
      arePathsRelated(target, exclusion),
    );
    return matchingExclusions.length > 1
      ? transitionFailure(
          "ambiguous-exclusion",
          "More than one stored exclusion affects the target; select one exact record.",
        )
      : transitionFailure(
          "exclusion-not-found",
          "The selected exclusion does not affect the target CWD.",
        );
  }
  if (!arePathsRelated(target, selectedExclusion)) {
    return transitionFailure(
      "exclusion-not-found",
      "The selected exclusion does not affect the target CWD.",
    );
  }

  const sourceChanged = !existingEvidence.sourceCwds.includes(target);
  const evidence = normalizePromotionEvidence({
    ...existingEvidence,
    sourceCwds: sourceChanged
      ? [...existingEvidence.sourceCwds, target]
      : existingEvidence.sourceCwds,
    excludedCwds: existingEvidence.excludedCwds.filter(
      (exclusion) => exclusion !== selectedExclusion,
    ),
    reasons: sourceChanged
      ? [...existingEvidence.reasons, "manual-scope-correction"]
      : existingEvidence.reasons,
  });

  const activeCwds = [...state.cwds];
  for (const source of effectiveSourceCwds(evidence)) {
    if (!activeCwds.some((activeCwd) => isPathRelated(activeCwd, source))) {
      activeCwds.push(source);
    }
  }
  const nextState: LearningScopeState = {
    cwds: independentPositiveRoots(activeCwds),
    promotionEvidence: evidence,
    nonglobal: state.nonglobal,
  };
  return validatedTransition(nextState);
}

/** Re-enable explicit widening review without changing the current scope. */
export function allowScopeWidening(state: LearningScopeState): ScopeTransitionResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) return transitionFailure("invalid-persisted-state", persisted.issue.message);
  if (!state.nonglobal) return { ok: true, state };

  return { ok: true, state: { ...state, nonglobal: false } };
}

function mergeExposureSnapshots(
  existing: readonly Exposure[],
  supporting: readonly Exposure[],
): Exposure[] {
  const byKey = new Map<string, Exposure>();
  for (const exposure of [...existing, ...supporting]) {
    byKey.set(`${exposure.date}@${exposure.sessionHash}`, { ...exposure });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      (left.date < right.date ? -1 : left.date > right.date ? 1 : 0) ||
      (left.sessionHash < right.sessionHash ? -1 : left.sessionHash > right.sessionHash ? 1 : 0),
  );
}

const AUTOMATIC_GENERALIZATION_BRANCH_THRESHOLD = 3;

interface EvidencePathNode {
  readonly cwd: string;
  readonly children: Map<string, EvidencePathNode>;
  directlySupported: boolean;
}

function insertEvidencePath(root: EvidencePathNode, source: string): void {
  const fromRoot = relative(parse(source).root, source);
  const segments = fromRoot.length === 0 ? [] : fromRoot.split(sep);
  let node = root;

  for (const segment of segments) {
    const segmentKey = pathComparisonKey(segment);
    let child = node.children.get(segmentKey);
    if (!child) {
      child = {
        cwd: join(node.cwd, segment),
        children: new Map(),
        directlySupported: false,
      };
      node.children.set(segmentKey, child);
    }
    node = child;
  }

  node.directlySupported = true;
}

function isForbiddenNode(cwd: string, forbiddenRoots: readonly string[]): boolean {
  const key = pathComparisonKey(cwd);
  return forbiddenRoots.some((root) => pathComparisonKey(root) === key);
}

function collapseEvidenceTree(
  node: EvidencePathNode,
  forbiddenRoots: readonly string[],
): { readonly cwds: readonly string[]; readonly rootQualified: boolean } {
  if (node.directlySupported) return { cwds: [node.cwd], rootQualified: false };

  if (
    node.children.size >= AUTOMATIC_GENERALIZATION_BRANCH_THRESHOLD &&
    !isForbiddenNode(node.cwd, forbiddenRoots)
  ) {
    return node.cwd === parse(node.cwd).root
      ? { cwds: [], rootQualified: true }
      : { cwds: [node.cwd], rootQualified: false };
  }

  return {
    cwds: [...node.children.values()].flatMap(
      (child) => collapseEvidenceTree(child, forbiddenRoots).cwds,
    ),
    rootQualified: false,
  };
}

function deriveGeneralizedScope(
  sources: readonly string[],
  forbiddenRoots: readonly string[],
): readonly string[] {
  const trees = new Map<string, EvidencePathNode>();

  for (const source of sources) {
    const pathRoot = parse(source).root;
    const rootKey = pathComparisonKey(pathRoot);
    let tree = trees.get(rootKey);
    if (!tree) {
      tree = { cwd: pathRoot, children: new Map(), directlySupported: false };
      trees.set(rootKey, tree);
    }
    insertEvidencePath(tree, source);
  }

  if (trees.size >= AUTOMATIC_GENERALIZATION_BRANCH_THRESHOLD) return ["*"];

  const collapsed = [...trees.values()].map((tree) => collapseEvidenceTree(tree, forbiddenRoots));
  if (collapsed.some((result) => result.rootQualified)) return ["*"];
  return independentPositiveRoots(collapsed.flatMap((result) => result.cwds));
}

function canonicalActiveScope(cwds: readonly string[]): readonly string[] {
  return cwds[0] === "*" ? ["*"] : independentPositiveRoots(cwds);
}

function sameActiveScope(left: readonly string[], right: readonly string[]): boolean {
  const canonicalLeft = canonicalActiveScope(left);
  const canonicalRight = canonicalActiveScope(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((cwd, index) => cwd === canonicalRight[index])
  );
}

/** Widen an eligible learning through independently supported child branches. */
export function generalizeLearningScope(
  state: LearningScopeState,
  supportingExposures: readonly Exposure[],
  forbiddenRoots: readonly string[],
): ScopeGeneralizationResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) {
    return {
      ok: false,
      issue: { code: "invalid-persisted-state", message: persisted.issue.message },
    };
  }

  if (
    state.cwds[0] === "*" ||
    state.nonglobal ||
    (state.promotionEvidence?.excludedCwds.length ?? 0) > 0
  ) {
    return { ok: true, state, changed: false };
  }

  const normalizedForbiddenRoots = canonicalPaths(forbiddenRoots);
  if (!normalizedForbiddenRoots) {
    return {
      ok: false,
      issue: { code: "invalid-path", message: "Forbidden roots must be absolute paths." },
    };
  }

  const sourceCwds = state.promotionEvidence?.sourceCwds ?? canonicalPaths(state.cwds);
  if (!sourceCwds) {
    return {
      ok: false,
      issue: {
        code: "invalid-persisted-state",
        message: "Scoped learning paths must be absolute before they can be generalized.",
      },
    };
  }

  const generalizedScope = deriveGeneralizedScope(sourceCwds, normalizedForbiddenRoots);
  const nextCwds =
    generalizedScope[0] === "*"
      ? ["*"]
      : independentPositiveRoots([...state.cwds, ...generalizedScope]);
  if (sameActiveScope(nextCwds, state.cwds)) return { ok: true, state, changed: false };

  const existingEvidence = state.promotionEvidence;
  const evidence = normalizePromotionEvidence({
    sourceCwds,
    excludedCwds: existingEvidence?.excludedCwds ?? [],
    exposures: mergeExposureSnapshots(existingEvidence?.exposures ?? [], supportingExposures),
    reasons: [...(existingEvidence?.reasons ?? []), "automatic-hierarchical-generalization"],
  });
  const nextState: LearningScopeState = {
    cwds: nextCwds,
    promotionEvidence: evidence,
    nonglobal: false,
  };
  const validation = validateLearningScope(nextState);
  return validation.ok
    ? { ok: true, state: nextState, changed: true }
    : { ok: false, issue: validation.issue };
}

/** Apply one explicit widening-review decision without mutating the input state. */
export function reviewScopeWidening(
  state: LearningScopeState,
  supportingExposures: readonly Exposure[],
  choice: ReviewedScopeChoice,
): ScopeTransitionResult {
  const persisted = validateLearningScope(state);
  if (!persisted.ok) return transitionFailure("invalid-persisted-state", persisted.issue.message);
  if (state.cwds[0] === "*" || (state.promotionEvidence?.excludedCwds.length ?? 0) > 0) {
    return transitionFailure(
      "not-eligible",
      "Global or excluded learning scopes are not widening candidates.",
    );
  }

  const sourceCwds = state.promotionEvidence?.sourceCwds ?? canonicalPaths(state.cwds);
  if (!sourceCwds || independentPositiveRoots(sourceCwds).length < 3) {
    return transitionFailure(
      "not-eligible",
      "Scope widening requires three independent positive CWD roots.",
    );
  }
  if (choice.kind === "keep-current") {
    return { ok: true, state: { ...state, nonglobal: true } };
  }

  const reason: PromotionReason =
    choice.kind === "global" ? "manual-global-review" : "manual-common-ancestor-review";
  const existing = state.promotionEvidence;
  const evidence = normalizePromotionEvidence({
    sourceCwds,
    excludedCwds: [],
    exposures: mergeExposureSnapshots(existing?.exposures ?? [], supportingExposures),
    reasons: [...(existing?.reasons ?? []), reason],
  });

  if (choice.kind === "global") {
    return validatedTransition({ cwds: ["*"], promotionEvidence: evidence, nonglobal: false });
  }

  const activeScope = chooseActiveScope(effectiveSourceCwds(evidence), [], choice);
  if (!activeScope.ok) return { ok: false, issue: activeScope.issue };
  return validatedTransition({
    cwds: activeScope.cwds,
    promotionEvidence: evidence,
    nonglobal: true,
  });
}
