/**
 * Interactive review UI for learnings.
 *
 * Two modes:
 * - Browse: filter, paginate, view details, delete entries
 * - Prune (--prune): AI flags low-quality entries, user confirms each
 *
 * Every delete persists immediately through the shared learnings transaction lock.
 */

import { join } from "node:path";
import { inference } from "../../inference";
import {
  type LearningScopeState,
  type ScopeChoice,
  type ScopeTransitionResult,
  allowScopeWidening,
  effectiveSourceCwds,
  findCommonAncestorCandidate,
  includeCwdInScope,
  narrowScopeForExclusion,
  normalizeCwdPath,
} from "../../memory/learning-scope";
import {
  prepareLearningStoreForMutation,
  removeLearningIfUnchanged,
  updateLearningIfUnchanged,
} from "../../memory/learning-store";
import {
  type LearningEntry,
  type QualityVerdict,
  buildQualityAssessmentPrompt,
  filterLearnings,
  parseQualityAssessmentOutput,
  sortByExposures,
} from "../../memory/learnings";
import { arePathsRelated } from "../../memory/utils";
import { promptUser } from "./index";

const PAGE_SIZE = 10;

// --- State ---

/** Mutable state for the learnings collection. Shared across review modes. */
interface ReviewState {
  readonly memoryDir: string;
  readonly targetCwd: string;
  readonly forbiddenAncestorRoots: readonly string[];
  readonly prompt: ReviewPrompt;
  entries: LearningEntry[];
}

/** Mutable view state for the interactive review loop. */
interface ViewState {
  filtered: LearningEntry[];
  filterText: string;
  page: number;
}

// --- Entry point ---

export async function runReview(
  memoryDir: string,
  options: {
    prune?: boolean;
    filter?: string;
    cwd?: string;
    forbiddenAncestorRoots?: readonly string[];
  },
  prompt: ReviewPrompt = promptUser,
): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("Review requires an interactive terminal (TTY).");
    return;
  }

  const readiness = await prepareLearningStoreForMutation(memoryDir, ["active"]);
  const document = readiness.active?.document;
  if (!document) throw new Error("Active learning readiness was not established");
  const entries = document.entries;
  if (entries.length === 0) {
    console.log("No learnings found.");
    return;
  }

  // Backup before any changes
  const backupPath = join(memoryDir, "learnings.backup.md");
  await Bun.write(backupPath, document.sourceText);

  console.log(`Learnings: ${entries.length} entries (backup saved)`);

  const targetCwd = normalizeCwdPath(options.cwd ?? process.cwd());
  if (!targetCwd) throw new Error("Review CWD must be an absolute path");
  const review: ReviewState = {
    memoryDir,
    targetCwd,
    forbiddenAncestorRoots: options.forbiddenAncestorRoots ?? [],
    prompt,
    entries,
  };

  if (options.prune) {
    await runPruneReview(review, options.filter);
  } else {
    await runInteractiveReview(review, options.filter);
  }
}

export type ReviewPrompt = (question: string) => Promise<string>;

// --- Shared helpers ---

function shortenCwd(cwd: string): string {
  if (cwd === "*") return "global";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? cwd : `.../${parts.slice(-2).join("/")}`;
}

function formatEntryLine(entry: LearningEntry, index: number): string {
  const num = String(index + 1).padStart(3);
  const exposures = entry.exposures.length;
  const lastDate = entry.exposures[entry.exposures.length - 1]?.date ?? "unknown";
  const cwds = entry.cwds.map(shortenCwd).join(", ");
  return `${num}. [${entry.category}] ${entry.title}\n     ${exposures} exposure(s) | last: ${lastDate} | ${cwds}`;
}

function showPage(entries: LearningEntry[], page: number): void {
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, entries.length);
  const totalPages = Math.ceil(entries.length / PAGE_SIZE);

  console.log();
  for (let i = start; i < end; i++) {
    const entry = entries[i];
    if (!entry) continue;
    console.log(formatEntryLine(entry, i));
  }
  console.log(`\n  Page ${page + 1}/${totalPages} (${entries.length} entries)`);
}

function showEntryDetail(entry: LearningEntry): void {
  const sourceCwds = entry.promotionEvidence?.sourceCwds.join(", ");
  console.log();
  console.log(`  [${entry.category}] ${entry.title}`);
  console.log(`  Active CWDs: ${entry.cwds.join(", ")}`);
  console.log(
    `  Source CWDs: ${sourceCwds ?? (entry.cwds[0] === "*" ? "unknown" : entry.cwds.join(", "))}`,
  );
  console.log(`  Excluded CWDs: ${entry.promotionEvidence?.excludedCwds.join(", ") || "none"}`);
  console.log(`  Evidence reasons: ${entry.promotionEvidence?.reasons.join(", ") || "none"}`);
  console.log(
    `  Exposures: ${entry.exposures.map((e) => `${e.date}@${e.sessionHash}`).join(", ")}`,
  );
  console.log();
  console.log(`  ${entry.body}`);
  console.log();
}

async function deleteEntry(review: ReviewState, entry: LearningEntry): Promise<boolean> {
  const result = await removeLearningIfUnchanged(review.memoryDir, entry);
  review.entries = result.entries;
  return result.status === "removed";
}

function refreshView(review: ReviewState, view: ViewState): void {
  view.filtered = applyFilter(review, view.filterText);
  const totalPages = Math.ceil(view.filtered.length / PAGE_SIZE);
  if (view.page >= totalPages && view.page > 0) view.page--;
}

function applyFilter(review: ReviewState, filterText: string): LearningEntry[] {
  const base = filterText ? filterLearnings(review.entries, filterText) : review.entries;
  return sortByExposures(base);
}

async function deleteAndRefresh(
  review: ReviewState,
  view: ViewState,
  entry: LearningEntry,
): Promise<void> {
  const deleted = await deleteEntry(review, entry);
  refreshView(review, view);
  console.log(
    deleted
      ? `  Deleted. (${review.entries.length} remaining)`
      : "  Not deleted: the learning changed while it was being reviewed.",
  );
  showPage(view.filtered, view.page);
}

// --- Prune review ---

async function runPruneReview(review: ReviewState, initialFilter?: string): Promise<void> {
  const candidates = applyFilter(review, initialFilter ?? "");

  if (candidates.length === 0) {
    console.log("\nNo candidates to assess.");
    return;
  }

  console.log(`\nAnalyzing ${candidates.length} learnings for quality...`);

  const prompt = buildQualityAssessmentPrompt(candidates);
  const result = await inference({ userPrompt: prompt, timeout: 60000 });

  if (!result.success || !result.text) {
    console.log("Quality assessment inference failed.");
    return;
  }

  const verdicts = parseQualityAssessmentOutput(result.text);

  if (verdicts.length === 0) {
    console.log("AI found no low-quality entries. All entries look good.");
    return;
  }

  console.log(`\nAI flagged ${verdicts.length} entries as low-quality:\n`);

  let deleted = 0;
  let kept = 0;

  for (const verdict of verdicts) {
    const entry = candidates[verdict.index];
    if (!entry) continue;

    const action = await presentPruneVerdict(review, entry, verdict);
    if (action === "quit") break;
    if (action === "deleted") deleted++;
    else kept++;
  }

  console.log(
    `\nDone. Reviewed ${deleted + kept} of ${verdicts.length} flagged: ${deleted} deleted, ${kept} kept. ${review.entries.length} entries remaining.`,
  );
}

async function presentPruneVerdict(
  review: ReviewState,
  entry: LearningEntry,
  verdict: QualityVerdict,
): Promise<"deleted" | "kept" | "quit"> {
  console.log(`  [${entry.category}] ${entry.title}`);
  console.log(`  ${entry.exposures.length} exposure(s) | ${entry.cwds.map(shortenCwd).join(", ")}`);
  console.log(`  Reason: ${verdict.reason}`);

  const answer = await review.prompt("  [k]eep  [d]elete  [v]iew  [q]uit? ");
  const cmd = answer.toLowerCase();

  if (cmd === "q") return "quit";

  if (cmd === "v") {
    showEntryDetail(entry);
    const answer2 = await review.prompt("  [k]eep  [d]elete? ");
    if (answer2.toLowerCase() === "d") {
      const deleted = await deleteEntry(review, entry);
      console.log(
        deleted
          ? `  Deleted. (${review.entries.length} remaining)\n`
          : "  Not deleted: the learning changed while it was being reviewed.\n",
      );
      return deleted ? "deleted" : "kept";
    }
    console.log("  Kept.\n");
    return "kept";
  }

  if (cmd === "d") {
    const deleted = await deleteEntry(review, entry);
    console.log(
      deleted
        ? `  Deleted. (${review.entries.length} remaining)\n`
        : "  Not deleted: the learning changed while it was being reviewed.\n",
    );
    return deleted ? "deleted" : "kept";
  }

  console.log("  Kept.\n");
  return "kept";
}

// --- Interactive review ---

async function runInteractiveReview(review: ReviewState, initialFilter?: string): Promise<void> {
  const view: ViewState = {
    filtered: applyFilter(review, initialFilter ?? ""),
    filterText: initialFilter ?? "",
    page: 0,
  };

  if (view.filterText) {
    console.log(`Filter: "${view.filterText}"`);
  }

  showPage(view.filtered, view.page);

  while (true) {
    const answer = await review.prompt(
      "\n# to view, [d]# to delete, [n]ext, [p]rev, [f]ilter, [q]uit: ",
    );
    const cmd = answer.trim().toLowerCase();

    if (cmd === "q" || cmd === "quit") break;

    const handled = await handleCommand(cmd, review, view);
    if (!handled) {
      console.log(
        "Unknown command. Use # to view, d# to delete, n/p to navigate, f to filter, q to quit.",
      );
    }
  }
}

async function handleCommand(cmd: string, review: ReviewState, view: ViewState): Promise<boolean> {
  if (cmd === "n" || cmd === "next") return handleNavigation(view, 1);
  if (cmd === "p" || cmd === "prev") return handleNavigation(view, -1);
  if (cmd === "f" || cmd === "filter") return handleFilter(review, view);

  const deleteMatch = cmd.match(/^d\s*(\d+)$/);
  if (deleteMatch) return handleDelete(review, view, deleteMatch);

  const viewMatch = cmd.match(/^(\d+)$/);
  if (viewMatch) return handleView(review, view, viewMatch);

  return false;
}

function handleNavigation(view: ViewState, direction: number): boolean {
  const totalPages = Math.ceil(view.filtered.length / PAGE_SIZE);
  const newPage = view.page + direction;

  if (newPage < 0 || newPage >= totalPages) {
    console.log(direction > 0 ? "Already on the last page." : "Already on the first page.");
    return true;
  }

  view.page = newPage;
  showPage(view.filtered, view.page);
  return true;
}

async function handleFilter(review: ReviewState, view: ViewState): Promise<boolean> {
  const answer = await review.prompt('Filter (text, "global", or Enter for all): ');
  view.filterText = answer.trim();
  view.filtered = applyFilter(review, view.filterText);
  view.page = 0;

  if (view.filterText) {
    console.log(`Filter: "${view.filterText}"`);
  }
  showPage(view.filtered, view.page);
  return true;
}

async function handleDelete(
  review: ReviewState,
  view: ViewState,
  match: RegExpMatchArray,
): Promise<boolean> {
  const idx = Number.parseInt(match[1] ?? "", 10) - 1;
  const entry = view.filtered[idx];
  if (!entry) {
    console.log("Invalid entry number.");
    return true;
  }

  showEntryDetail(entry);
  const answer = await review.prompt("  Delete this entry? [y/N] ");
  if (answer.toLowerCase() === "y") {
    await deleteAndRefresh(review, view, entry);
  } else {
    console.log("  Kept.");
  }
  return true;
}

async function handleView(
  review: ReviewState,
  view: ViewState,
  match: RegExpMatchArray,
): Promise<boolean> {
  const idx = Number.parseInt(match[1] ?? "", 10) - 1;
  const entry = view.filtered[idx];
  if (!entry) {
    console.log("Invalid entry number.");
    return true;
  }

  showEntryDetail(entry);
  const action = await review.prompt("  [k]eep  [d]elete  [s]cope  [b]ack: ");
  if (action.toLowerCase() === "d") {
    await deleteAndRefresh(review, view, entry);
  } else if (action.toLowerCase() === "s") {
    await reviewEntryScope(review, entry);
    refreshView(review, view);
    showPage(view.filtered, view.page);
  } else {
    showPage(view.filtered, view.page);
  }
  return true;
}

function entryScopeState(entry: LearningEntry): LearningScopeState {
  return {
    cwds: entry.cwds,
    nonglobal: entry.nonglobal,
    ...(entry.promotionEvidence ? { promotionEvidence: entry.promotionEvidence } : {}),
  };
}

function applyEntryScope(entry: LearningEntry, state: LearningScopeState): LearningEntry {
  const { promotionEvidence: _discarded, ...withoutEvidence } = entry;
  return {
    ...withoutEvidence,
    cwds: [...state.cwds],
    nonglobal: state.nonglobal,
    ...(state.promotionEvidence ? { promotionEvidence: state.promotionEvidence } : {}),
  };
}

function showScopePreview(state: LearningScopeState): void {
  console.log(`  Resulting active CWDs: ${state.cwds.join(", ")}`);
  console.log(`  Positive sources: ${state.promotionEvidence?.sourceCwds.join(", ") ?? "none"}`);
  console.log(`  Exclusions: ${state.promotionEvidence?.excludedCwds.join(", ") || "none"}`);
}

async function persistScopeTransition(
  review: ReviewState,
  expected: LearningEntry,
  derive: (entry: LearningEntry) => ScopeTransitionResult,
): Promise<boolean> {
  const result = await updateLearningIfUnchanged(review.memoryDir, expected, (fresh) => {
    const transition = derive(fresh);
    if (!transition.ok) {
      throw new Error(`Reviewed scope transition became invalid: ${transition.issue.message}`);
    }
    return applyEntryScope(fresh, transition.state);
  });
  review.entries = result.entries;
  if (result.status === "updated") return true;
  console.log(
    result.status === "ambiguous"
      ? "  Scope unchanged: the reviewed representation is ambiguous."
      : "  Scope unchanged: the learning changed while it was being reviewed.",
  );
  return false;
}

function parseAssertedRoots(raw: string): string[] | undefined {
  const roots = raw
    .split(",")
    .map((part) => normalizeCwdPath(part.trim()))
    .filter((cwd): cwd is string => cwd !== undefined);
  if (roots.length === 0 || roots.length !== raw.split(",").length) return undefined;
  return [...new Set(roots)].sort();
}

async function choosePositiveRootsOrDelete(
  review: ReviewState,
  entry: LearningEntry,
): Promise<readonly string[] | "deleted" | undefined> {
  const action = (
    await review.prompt("  No positive source would remain. [r]oots  [d]elete  [c]ancel: ")
  )
    .trim()
    .toLowerCase();
  if (action === "d") {
    const deleted = await deleteEntry(review, entry);
    console.log(deleted ? "  Deleted." : "  Not deleted: the learning changed.");
    return deleted ? "deleted" : undefined;
  }
  if (action !== "r") return undefined;

  while (true) {
    const raw = await review.prompt(
      "  Positive source CWDs (absolute, comma-separated; [c]ancel): ",
    );
    if (raw.trim().toLowerCase() === "c" || raw.trim() === "") return undefined;
    const roots = parseAssertedRoots(raw);
    if (roots) return roots;
    console.log("  Enter one or more absolute CWDs, or c to cancel.");
  }
}

interface ExclusionPlan {
  readonly assertedSourceCwds?: readonly string[];
  readonly scopeChoice: ScopeChoice;
  readonly transition: Extract<ScopeTransitionResult, { readonly ok: true }>;
}

async function prepareExactExclusion(
  review: ReviewState,
  entry: LearningEntry,
): Promise<ExclusionPlan | undefined> {
  let assertedSourceCwds: readonly string[] | undefined;
  let transition = narrowScopeForExclusion(entryScopeState(entry), review.targetCwd, {
    supportingExposures: entry.exposures,
  });
  if (!transition.ok && transition.issue.code === "no-effective-sources") {
    const roots = await choosePositiveRootsOrDelete(review, entry);
    if (!roots || roots === "deleted") return undefined;
    assertedSourceCwds = roots;
    transition = narrowScopeForExclusion(entryScopeState(entry), review.targetCwd, {
      assertedSourceCwds,
      supportingExposures: entry.exposures,
    });
  }
  if (!transition.ok) {
    console.log(`  Scope unchanged: ${transition.issue.message}`);
    return undefined;
  }
  return { transition, assertedSourceCwds, scopeChoice: { kind: "exact-sources" } };
}

async function chooseExclusionScope(
  review: ReviewState,
  entry: LearningEntry,
  exact: ExclusionPlan,
): Promise<ExclusionPlan | undefined> {
  const evidence = exact.transition.state.promotionEvidence;
  const ancestor = evidence
    ? findCommonAncestorCandidate(effectiveSourceCwds(evidence), review.forbiddenAncestorRoots)
    : undefined;
  if (!ancestor) return exact;

  const scopeChoice: ScopeChoice = {
    kind: "confirmed-ancestor",
    cwd: ancestor,
    forbiddenRoots: review.forbiddenAncestorRoots,
  };
  const transition = narrowScopeForExclusion(entryScopeState(entry), review.targetCwd, {
    assertedSourceCwds: exact.assertedSourceCwds,
    supportingExposures: entry.exposures,
    scopeChoice,
  });
  if (!transition.ok) return exact;

  const choice = (await review.prompt(`  [a] use ${ancestor}  [e] exact sources  [c]ancel: `))
    .trim()
    .toLowerCase();
  if (choice === "a") {
    return { ...exact, scopeChoice, transition };
  }
  if (choice === "e") return exact;
  if (choice !== "c") console.log("  Scope unchanged: unknown choice.");
  return undefined;
}

async function reviewExclusion(review: ReviewState, entry: LearningEntry): Promise<void> {
  const confirmed = (
    await review.prompt(`  Exclude ${review.targetCwd} from this learning? [y/N] `)
  )
    .trim()
    .toLowerCase();
  if (confirmed !== "y") return;
  const exact = await prepareExactExclusion(review, entry);
  if (!exact) return;
  const plan = await chooseExclusionScope(review, entry, exact);
  if (!plan) return;

  showScopePreview(plan.transition.state);
  if ((await review.prompt("  Apply this scope? [y/N] ")).trim().toLowerCase() !== "y") return;

  const applied = await persistScopeTransition(review, entry, (fresh) =>
    narrowScopeForExclusion(entryScopeState(fresh), review.targetCwd, {
      assertedSourceCwds: plan.assertedSourceCwds,
      supportingExposures: fresh.exposures,
      scopeChoice: plan.scopeChoice,
    }),
  );
  if (applied) console.log("  Scope correction saved.");
}

async function reviewInclusion(review: ReviewState, entry: LearningEntry): Promise<void> {
  const related =
    entry.promotionEvidence?.excludedCwds.filter((cwd) => arePathsRelated(cwd, review.targetCwd)) ??
    [];
  if (related.length === 0) {
    console.log(`  No stored exclusion affects ${review.targetCwd}.`);
    return;
  }

  console.log("  Related exclusions:");
  related.forEach((cwd, index) => console.log(`    ${index + 1}. ${cwd}`));
  const selectedIndex = Number.parseInt(
    await review.prompt("  Remove which exact exclusion? [number, or c] "),
    10,
  );
  const selected = related[selectedIndex - 1];
  if (!selected) return;

  const preview = includeCwdInScope(entryScopeState(entry), review.targetCwd, selected);
  if (!preview.ok) {
    console.log(`  Scope unchanged: ${preview.issue.message}`);
    return;
  }
  showScopePreview(preview.state);
  if ((await review.prompt("  Apply this scope? [y/N] ")).trim().toLowerCase() !== "y") return;

  const applied = await persistScopeTransition(review, entry, (fresh) =>
    includeCwdInScope(entryScopeState(fresh), review.targetCwd, selected),
  );
  if (applied) console.log("  Inclusion saved.");
}

async function reviewAllowWidening(review: ReviewState, entry: LearningEntry): Promise<void> {
  const preview = allowScopeWidening(entryScopeState(entry));
  if (!preview.ok) {
    console.log(`  Scope unchanged: ${preview.issue.message}`);
    return;
  }
  showScopePreview(preview.state);
  if ((await review.prompt("  Allow future widening reviews? [y/N] ")).trim().toLowerCase() !== "y")
    return;
  const applied = await persistScopeTransition(review, entry, (fresh) =>
    allowScopeWidening(entryScopeState(fresh)),
  );
  if (applied) console.log("  Future widening enabled.");
}

async function reviewEntryScope(review: ReviewState, entry: LearningEntry): Promise<void> {
  showEntryDetail(entry);
  const action = (await review.prompt("  [e]xclude target  [i]nclude target  [w]idening  [b]ack: "))
    .trim()
    .toLowerCase();
  if (action === "e") await reviewExclusion(review, entry);
  if (action === "i") await reviewInclusion(review, entry);
  if (action === "w") await reviewAllowWidening(review, entry);
}
