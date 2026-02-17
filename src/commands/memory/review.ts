/**
 * Interactive review UI for learnings.
 *
 * Two modes:
 * - Browse: filter, paginate, view details, delete entries
 * - Prune (--prune): AI flags low-quality entries, user confirms each
 *
 * Every delete persists immediately to disk via writeLearnings().
 */

import { join } from "node:path";
import { inference } from "../../inference";
import {
  type LearningEntry,
  type QualityVerdict,
  buildQualityAssessmentPrompt,
  filterLearnings,
  loadLearnings,
  parseQualityAssessmentOutput,
  renderLearnings,
  sortByExposures,
  writeLearnings,
} from "../../memory/learnings";
import { promptUser } from "./index";

const PAGE_SIZE = 10;

// --- State ---

/** Mutable state for the learnings collection. Shared across review modes. */
interface ReviewState {
  readonly memoryDir: string;
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
  options: { prune?: boolean; filter?: string },
): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("Review requires an interactive terminal (TTY).");
    return;
  }

  const entries = await loadLearnings(memoryDir);
  if (entries.length === 0) {
    console.log("No learnings found.");
    return;
  }

  // Backup before any changes
  const backupPath = join(memoryDir, "learnings.backup.md");
  await Bun.write(backupPath, renderLearnings(entries));

  console.log(`Learnings: ${entries.length} entries (backup saved)`);

  const review: ReviewState = { memoryDir, entries };

  if (options.prune) {
    await runPruneReview(review, options.filter);
  } else {
    await runInteractiveReview(review, options.filter);
  }
}

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
  console.log();
  console.log(`  [${entry.category}] ${entry.title}`);
  console.log(`  CWDs: ${entry.cwds.join(", ")}`);
  console.log(
    `  Exposures: ${entry.exposures.map((e) => `${e.date}@${e.sessionHash}`).join(", ")}`,
  );
  console.log();
  console.log(`  ${entry.body}`);
  console.log();
}

async function deleteEntry(review: ReviewState, entry: LearningEntry): Promise<void> {
  review.entries = review.entries.filter((e) => e !== entry);
  await writeLearnings(review.memoryDir, review.entries);
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
  await deleteEntry(review, entry);
  refreshView(review, view);
  console.log(`  Deleted. (${review.entries.length} remaining)`);
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

  const answer = await promptUser("  [k]eep  [d]elete  [v]iew  [q]uit? ");
  const cmd = answer.toLowerCase();

  if (cmd === "q") return "quit";

  if (cmd === "v") {
    showEntryDetail(entry);
    const answer2 = await promptUser("  [k]eep  [d]elete? ");
    if (answer2.toLowerCase() === "d") {
      await deleteEntry(review, entry);
      console.log(`  Deleted. (${review.entries.length} remaining)\n`);
      return "deleted";
    }
    console.log("  Kept.\n");
    return "kept";
  }

  if (cmd === "d") {
    await deleteEntry(review, entry);
    console.log(`  Deleted. (${review.entries.length} remaining)\n`);
    return "deleted";
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
    const answer = await promptUser(
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
  const answer = await promptUser('Filter (text, "global", or Enter for all): ');
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
  const answer = await promptUser("  Delete this entry? [y/N] ");
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
  const action = await promptUser("  [k]eep  [d]elete  [b]ack: ");
  if (action.toLowerCase() === "d") {
    await deleteAndRefresh(review, view, entry);
  } else {
    showPage(view.filtered, view.page);
  }
  return true;
}
