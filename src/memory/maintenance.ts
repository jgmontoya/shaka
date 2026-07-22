/**
 * Automatic maintenance: trigger logic, state persistence, audit logging,
 * and orchestration pipeline.
 *
 * Pure decision function determines when to run consolidation + pruning.
 * Orchestration function (`runMaintenance`) runs as a sequential step
 * in the session-end worker and publishes against its prepared snapshot.
 *
 * State tracked in .last-maintenance JSON file; audit trail in JSONL log.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inference } from "../inference";
import type { ProviderName } from "../providers/types";
import { runFullConsolidation } from "./consolidation";
import { normalizeCwdPath } from "./learning-scope";
import { commitConsolidationIfUnchanged, prepareLearningStoreForMutation } from "./learning-store";
import {
  type LearningEntry,
  assertLearningsRepresentable,
  buildRankingPrompt,
  generalizeLearningScopes,
  matchesCwd,
  parseRankingOutput,
  selectLearnings,
} from "./learnings";
import { withDirectoryLock } from "./lock";

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
  readonly generalized: number;
  readonly pruned: number;
  readonly before: number;
  readonly after: number;
}

// --- Named constants ---

const INTERVAL_HOURS = 24;
const VOLUME_TRIGGER = 10;
const AUTO_PRUNE_MAX = 3;
const AUTO_PRUNE_EXPOSURE_FLOOR = 2;
const AUTO_PRUNE_AGE_DAYS = 7;
const MAINTENANCE_LOCK = ".maintenance.lock";

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
  readonly generalized?: number;
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
  provider?: ProviderName,
): Promise<{ entries: LearningEntry[]; archived: LearningEntry[]; condensed: number }> {
  const result = await runFullConsolidation(entries, provider);
  assertLearningsRepresentable(join(memoryDir, "learnings.md"), result.entries);
  return {
    entries: result.entries,
    archived: result.archived,
    condensed: result.compoundsCreated,
  };
}

/** Filter entries eligible for auto-prune ranking. */
function findPruneEligible(entries: LearningEntry[], cwd: string, now: Date): LearningEntry[] {
  const ageThreshold = AUTO_PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

  return entries.filter((e) => {
    if (e.promotionEvidence || e.nonglobal) return false;
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
  provider?: ProviderName,
): Promise<Set<number>> {
  const eligible = findPruneEligible(entries, cwd, now);

  const prompt = buildRankingPrompt(eligible);
  if (!prompt) return new Set();

  const result = await inference({ userPrompt: prompt, provider, timeout: 30000 });
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
 * Run the maintenance pipeline: consolidation and scope-safe auto-prune.
 * Called by the session-end worker after learnings extraction.
 *
 * Fail-open: inference failures are caught and logged, never crash.
 * Single commit: all mutations are applied in memory and published together at the end.
 */
export async function runMaintenance(
  memoryDir: string,
  cwd: string,
  newLearningsExtracted: number,
  opts?: { now?: Date; provider?: ProviderName },
): Promise<MaintenanceResult> {
  const home = normalizeCwdPath(homedir());
  const forbiddenRoots = home ? [home] : [];
  await mkdir(memoryDir, { recursive: true });
  return await withDirectoryLock(join(memoryDir, MAINTENANCE_LOCK), () =>
    runMaintenanceTransaction(memoryDir, cwd, newLearningsExtracted, forbiddenRoots, opts),
  );
}

async function runMaintenanceTransaction(
  memoryDir: string,
  cwd: string,
  newLearningsExtracted: number,
  forbiddenRoots: readonly string[],
  opts?: { now?: Date; provider?: ProviderName },
): Promise<MaintenanceResult> {
  const { now, provider } = opts ?? {};
  const currentTime = now ?? new Date();
  const readiness = await prepareLearningStoreForMutation(memoryDir, ["active", "archive"]);
  const document = readiness.active?.document;
  if (!document) throw new Error("Active learning readiness was not established");
  let entries = document.entries;
  const state = await readMaintenanceState(memoryDir);
  const decision = shouldRunMaintenance(entries, cwd, state, newLearningsExtracted, currentTime);

  if (decision.action === "skip") {
    return { skipped: true, reason: decision.reason };
  }

  const beforeCount = entries.length;

  // Backup before any changes
  await Bun.write(join(memoryDir, "learnings.backup.md"), document.sourceText);

  // Step 1: Consolidation (dedup, contradictions, condensation)
  const condensation = await failOpen(
    "consolidation",
    () => consolidate(entries, memoryDir, provider),
    {
      entries,
      archived: [],
      condensed: 0,
    },
  );
  entries = condensation.entries;

  // Step 2: Deterministic hierarchical generalization
  const generalization = generalizeLearningScopes(entries, forbiddenRoots);
  entries = generalization.entries;

  // Step 3: Auto-prune (only when budget pressure exists)
  let prunedCount = 0;
  if (decision.action === "consolidate-and-prune") {
    const pruneTargets = await failOpen(
      "auto-prune",
      () => findPruneTargets(entries, cwd, currentTime, provider),
      new Set<number>(),
    );
    if (pruneTargets.size > 0) {
      entries = entries.filter((_, i) => !pruneTargets.has(i));
      prunedCount = pruneTargets.size;
    }
  }

  const committed = await commitConsolidationIfUnchanged(memoryDir, {
    expectedActive: document.entries,
    activeReplacement: entries,
    archiveEntries: condensation.archived,
  });
  if (!committed) {
    return { skipped: true, reason: "learnings changed during maintenance" };
  }

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
    generalized: generalization.generalized,
    pruned: prunedCount,
    before: beforeCount,
    after: afterCount,
  });

  return {
    skipped: false,
    condensed: condensation.condensed,
    generalized: generalization.generalized,
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
