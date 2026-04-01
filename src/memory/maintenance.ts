/**
 * Automatic maintenance: trigger logic, state persistence, audit logging,
 * and orchestration pipeline.
 *
 * Pure decision function determines when to run consolidation + pruning.
 * Orchestration function (`runMaintenance`) runs as a sequential step
 * in the session-end worker — no separate process, no lockfiles.
 *
 * State tracked in .last-maintenance JSON file; audit trail in JSONL log.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inference } from "../inference";
import { runFullConsolidation } from "./consolidation";
import {
  type LearningEntry,
  appendToArchive,
  buildRankingPrompt,
  findPromotionCandidates,
  loadLearnings,
  matchesCwd,
  parseRankingOutput,
  promoteToGlobal,
  renderLearnings,
  selectLearnings,
  writeLearnings,
} from "./learnings";

// --- Types ---

export type MaintenanceDecision =
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "consolidate-only" }
  | { readonly action: "consolidate-and-prune" };

export interface MaintenanceState {
  readonly lastRun: string; // ISO date
  readonly entryCountAtLastRun: number;
}

export interface MaintenanceLogEntry {
  readonly timestamp: string;
  readonly trigger: string;
  readonly cwd: string;
  readonly condensed: number;
  readonly pruned: number;
  readonly promoted: number;
  readonly before: number;
  readonly after: number;
}

// --- Named constants ---

const INTERVAL_HOURS = 24;
const VOLUME_TRIGGER = 10;
const AUTO_PRUNE_MAX = 3;
const AUTO_PRUNE_EXPOSURE_FLOOR = 2;
const AUTO_PRUNE_AGE_DAYS = 7;

// --- Decision logic ---

/**
 * Decide whether maintenance should run and what actions to take.
 * Pure function: data in, decision out. No I/O, no inference calls.
 */
export function shouldRunMaintenance(
  entries: LearningEntry[],
  cwd: string,
  state: MaintenanceState | null,
  newLearningsExtracted: number,
  now?: Date,
): MaintenanceDecision {
  if (newLearningsExtracted === 0) {
    return { action: "skip", reason: "no new learnings" };
  }

  const currentTime = now ?? new Date();
  const lastRunTime = state ? new Date(state.lastRun).getTime() : 0;
  const hoursSinceLastRun = (currentTime.getTime() - lastRunTime) / (1000 * 60 * 60);
  const newSinceLastRun = entries.length - (state?.entryCountAtLastRun ?? 0);

  const timeGate = hoursSinceLastRun >= INTERVAL_HOURS;
  const volumeGate = newSinceLastRun >= VOLUME_TRIGGER;

  if (!timeGate && !volumeGate) {
    return { action: "skip", reason: "gates not met" };
  }

  // Budget pressure: more matching entries than fit in the injection budget
  const matchingCount = entries.filter((e) => matchesCwd(e, cwd)).length;
  const selected = selectLearnings(entries, cwd);
  const budgetPressure = selected.length < matchingCount;

  return budgetPressure ? { action: "consolidate-and-prune" } : { action: "consolidate-only" };
}

// --- State persistence ---

const STATE_FILE = ".last-maintenance";
const LOG_FILE = "maintenance.log";

/** Read maintenance state from disk. Returns null if file missing or invalid. */
export async function readMaintenanceState(memoryDir: string): Promise<MaintenanceState | null> {
  const file = Bun.file(join(memoryDir, STATE_FILE));

  if (!(await file.exists())) return null;

  try {
    const data = await file.json();
    if (typeof data?.lastRun !== "string" || typeof data?.entryCountAtLastRun !== "number") {
      return null;
    }
    return { lastRun: data.lastRun, entryCountAtLastRun: data.entryCountAtLastRun };
  } catch {
    return null;
  }
}

/** Write maintenance state to disk. */
export async function writeMaintenanceState(
  memoryDir: string,
  state: MaintenanceState,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await Bun.write(join(memoryDir, STATE_FILE), JSON.stringify(state));
}

// --- Orchestration result ---

export interface MaintenanceResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly condensed?: number;
  readonly promoted?: number;
  readonly pruned?: number;
  readonly before?: number;
  readonly after?: number;
}

// --- Pipeline steps ---

/** Fail-open wrapper: catches errors, logs with stack trace, returns fallback. */
async function failOpen<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      `Maintenance ${label} failed:`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return fallback;
  }
}

/** Run all consolidation passes and archive consumed entries. */
async function consolidate(
  entries: LearningEntry[],
  memoryDir: string,
): Promise<{ entries: LearningEntry[]; condensed: number }> {
  const result = await runFullConsolidation(entries);

  if (result.archived.length > 0) {
    await appendToArchive(memoryDir, result.archived);
  }

  return { entries: result.entries, condensed: result.compoundsCreated };
}

/** Promote entries appearing in 3+ CWDs to global. Returns updated entries and count. */
function autoPromote(entries: LearningEntry[]): { entries: LearningEntry[]; promoted: number } {
  const candidates = findPromotionCandidates(entries);
  let promoted = 0;
  const result = [...entries];

  for (const candidate of candidates) {
    const idx = result.findIndex((e) => e === candidate);
    if (idx === -1) continue;
    result[idx] = promoteToGlobal(candidate);
    promoted++;
  }

  return { entries: result, promoted };
}

/** Filter entries eligible for auto-prune ranking. */
function findPruneEligible(entries: LearningEntry[], cwd: string, now: Date): LearningEntry[] {
  const ageThreshold = AUTO_PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

  return entries.filter((e) => {
    if (!matchesCwd(e, cwd)) return false;
    if (e.exposures.length >= AUTO_PRUNE_EXPOSURE_FLOOR) return false;

    const firstExposure = e.exposures[0];
    if (!firstExposure) return false;
    return now.getTime() - new Date(firstExposure.date).getTime() >= ageThreshold;
  });
}

/**
 * Identify entries to prune via LLM ranking.
 * Returns indices (into `entries`) to remove. Does no I/O on learnings.
 */
async function findPruneTargets(
  entries: LearningEntry[],
  cwd: string,
  now: Date,
): Promise<Set<number>> {
  const eligible = findPruneEligible(entries, cwd, now);

  const prompt = buildRankingPrompt(eligible);
  if (!prompt) return new Set();

  const result = await inference({ userPrompt: prompt, timeout: 30000 });
  if (!result.success || !result.text) {
    console.error("Auto-prune ranking inference failed. Skipping.");
    return new Set();
  }

  const ranked = parseRankingOutput(result.text);
  if (ranked.length === 0) return new Set();

  const toPrune = ranked.slice(0, AUTO_PRUNE_MAX);
  const indicesToRemove = new Set<number>();

  for (const verdict of toPrune) {
    const eligibleEntry = eligible[verdict.index];
    if (!eligibleEntry) continue;
    const fullIndex = entries.indexOf(eligibleEntry);
    if (fullIndex !== -1) indicesToRemove.add(fullIndex);
  }

  return indicesToRemove;
}

// --- Orchestration ---

/**
 * Run the maintenance pipeline: consolidation, auto-promote, auto-prune.
 * Called by the session-end worker after learnings extraction.
 *
 * Fail-open: inference failures are caught and logged, never crash.
 * Single write: all mutations are applied in-memory, written once at the end.
 */
export async function runMaintenance(
  memoryDir: string,
  cwd: string,
  newLearningsExtracted: number,
  now?: Date,
): Promise<MaintenanceResult> {
  const currentTime = now ?? new Date();
  let entries = await loadLearnings(memoryDir);
  const state = await readMaintenanceState(memoryDir);
  const decision = shouldRunMaintenance(entries, cwd, state, newLearningsExtracted, currentTime);

  if (decision.action === "skip") {
    return { skipped: true, reason: decision.reason };
  }

  const beforeCount = entries.length;

  // Backup before any changes
  await Bun.write(join(memoryDir, "learnings.backup.md"), renderLearnings(entries));

  // Step 1: Consolidation (dedup, contradictions, condensation)
  const condensation = await failOpen("consolidation", () => consolidate(entries, memoryDir), {
    entries,
    condensed: 0,
  });
  entries = condensation.entries;

  // Step 2: Auto-promote
  const promotion = await failOpen("auto-promote", async () => autoPromote(entries), {
    entries,
    promoted: 0,
  });
  entries = promotion.entries;

  // Step 3: Auto-prune (only when budget pressure exists)
  let prunedCount = 0;
  if (decision.action === "consolidate-and-prune") {
    const pruneTargets = await failOpen(
      "auto-prune",
      () => findPruneTargets(entries, cwd, currentTime),
      new Set<number>(),
    );
    if (pruneTargets.size > 0) {
      entries = entries.filter((_, i) => !pruneTargets.has(i));
      prunedCount = pruneTargets.size;
    }
  }

  // Single write point for all mutations
  await writeLearnings(memoryDir, entries);

  const afterCount = entries.length;
  const trigger = decision.action === "consolidate-and-prune" ? "budget-pressure" : "routine";

  // Step 4: Update state + log
  await writeMaintenanceState(memoryDir, {
    lastRun: currentTime.toISOString(),
    entryCountAtLastRun: afterCount,
  });

  await appendMaintenanceLog(memoryDir, {
    timestamp: currentTime.toISOString(),
    trigger,
    cwd,
    condensed: condensation.condensed,
    pruned: prunedCount,
    promoted: promotion.promoted,
    before: beforeCount,
    after: afterCount,
  });

  return {
    skipped: false,
    condensed: condensation.condensed,
    promoted: promotion.promoted,
    pruned: prunedCount,
    before: beforeCount,
    after: afterCount,
  };
}

/** Append a log entry to the JSONL maintenance log. */
export async function appendMaintenanceLog(
  memoryDir: string,
  entry: MaintenanceLogEntry,
): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  await appendFile(join(memoryDir, LOG_FILE), `${JSON.stringify(entry)}\n`);
}
