/**
 * Rolling summaries (rollups): compress session summaries into daily/weekly/monthly
 * digests per project, providing persistent institutional knowledge across time horizons.
 *
 * Each level summarizes the one below: daily accumulates sessions, weekly folds
 * completed days, monthly folds completed weeks. Files use YAML frontmatter +
 * bulleted-list body, stored per-project under memory/rollups/.
 *
 * See also: rollups.md for the full design spec.
 */

import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseFrontmatter } from "../domain/frontmatter";
import { inference } from "../inference";
import type { SummaryIndex } from "./storage";

// --- Types ---

export type RollupPeriod = "daily" | "weekly" | "monthly";

export interface Rollup {
  readonly period: RollupPeriod;
  readonly cwd: string;
  readonly date: string; // YYYY-MM-DD | YYYY-Www | YYYY-MM
  readonly lastUpdated: string; // ISO 8601
  readonly sessionCount: number; // meaningful for daily, 0 for weekly/monthly
  readonly body: string;
}

// --- Date helpers ---

/** Today's date as YYYY-MM-DD in UTC (matches session metadata convention). */
export function todayDateString(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ISO 8601 week string for a date in UTC (e.g. "2026-W08"). */
export function isoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Current ISO week string. */
export function currentIsoWeek(now = new Date()): string {
  return isoWeekString(now);
}

/** Current month as YYYY-MM in UTC (matches session metadata convention). */
export function currentMonth(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// --- Project identification ---

/** CWD with path separators replaced by - and drive colons stripped. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/:/g, "").replace(/[\\/]/g, "-");
}

/** Full path to a project's rollups directory. */
export function projectDir(rollupsDir: string, cwd: string): string {
  return join(rollupsDir, projectSlug(cwd));
}

// --- Period detection ---

/** Check if a rollup's date differs from the current period (rollover needed). */
export function needsRollover(rollup: Rollup, now = new Date()): boolean {
  switch (rollup.period) {
    case "daily":
      return rollup.date !== todayDateString(now);
    case "weekly":
      return rollup.date !== currentIsoWeek(now);
    case "monthly":
      return rollup.date !== currentMonth(now);
  }
}

// --- Parsing ---

/** Parse a rollup markdown file (YAML frontmatter + body) into a Rollup. */
export function parseRollupFile(content: string): Rollup | null {
  const result = parseFrontmatter(content);
  if (!result) return null;

  const { frontmatter: fm, body } = result;

  const period = fm.period as string | undefined;
  if (!period || !["daily", "weekly", "monthly"].includes(period)) return null;

  const cwd = fm.cwd as string | undefined;
  if (!cwd) return null;

  const date = fm.date as string | undefined;
  if (!date) return null;

  return {
    period: period as RollupPeriod,
    cwd,
    date: String(date),
    lastUpdated: String(fm.last_updated ?? new Date().toISOString()),
    sessionCount: Number(fm.session_count ?? 0),
    body: body.trim(),
  };
}

/** Serialize a Rollup to markdown with YAML frontmatter. */
export function serializeRollup(rollup: Rollup): string {
  const frontmatter = stringifyYaml({
    period: rollup.period,
    cwd: rollup.cwd,
    date: rollup.date,
    last_updated: rollup.lastUpdated,
    session_count: rollup.sessionCount,
  }).trim();

  return `---\n${frontmatter}\n---\n\n${rollup.body}\n`;
}

// --- Prompt builders ---

/** Build prompt for creating/updating a daily rollup from session summaries. */
export function buildDailyUpdatePrompt(
  existingBody: string | null,
  sessionSummaries: string[],
): string {
  const existing = existingBody ?? "No existing summary yet.";
  const sessions = sessionSummaries.join("\n\n");

  return `You are maintaining a daily work summary that will be used as context in future coding sessions. Merge the session(s) into the existing daily summary.

<existing_daily>
${existing}
</existing_daily>

<sessions>
${sessions}
</sessions>

Rules:
- Output ONLY a bulleted list (- item), no headings, no prose
- Each bullet: 1 short sentence, specific and factual
- Be concise — aim for the fewest bullets that capture meaningful work
- Merge overlapping topics (don't repeat what's already captured)
- Drop trivial items (typo fixes, minor tweaks) in favor of significant ones
- Prioritize what steers tomorrow's work:
  - Work in progress (unfinished tasks to continue)
  - Decisions made (so they aren't revisited)
  - Open questions and blockers (so they get addressed)
  - Significant changes to codebase state`;
}

/** Build prompt for folding lower-level rollups into weekly or monthly. */
export function buildFoldPrompt(
  period: "weekly" | "monthly",
  existingBody: string | null,
  completedBodies: { label: string; body: string }[],
): string {
  const existing = existingBody ?? "No existing summary yet.";
  const entries = completedBodies.map((e) => `### ${e.label}\n\n${e.body}`).join("\n\n");

  if (period === "weekly") {
    return `You are maintaining a weekly work summary that will be used as context in future coding sessions. Fold the day(s) into the existing weekly summary.

<existing_weekly>
${existing}
</existing_weekly>

<daily_summaries>
${entries}
</daily_summaries>

Rules:
- Output ONLY a bulleted list (- item), no headings, no prose
- Each bullet: 1 short sentence capturing a theme or trajectory
- Be concise — compress multiple days into thematic bullets where related
- Drop day-level specifics that don't matter at the week level
- Prioritize what steers next week's work:
  - Project direction and momentum (what's the arc?)
  - Design decisions and constraints now in effect
  - Patterns that emerged (recurring issues, evolving architecture)
  - Unresolved items carrying over to next week`;
  }

  return `You are maintaining a monthly work summary that will be used as context in future coding sessions. Fold the week(s) into the existing monthly summary.

<existing_monthly>
${existing}
</existing_monthly>

<weekly_summaries>
${entries}
</weekly_summaries>

Rules:
- Output ONLY a bulleted list (- item), no headings, no prose
- Each bullet: 1 short sentence capturing a strategic outcome or shift
- Be concise — compress multiple weeks into thematic bullets where related
- Drop week-level specifics that don't matter at the month level
- Prioritize what steers next month's work:
  - Milestones reached (project phase transitions)
  - Architectural decisions in effect (the "why" behind current codebase shape)
  - Shifts in direction or priorities
  - Current project state (where are we in the larger arc?)`;
}

// --- Backfill filtering (pure) ---

/** Filter session summaries to those matching today's date and project CWD. */
export function gatherTodaySessions(
  summaries: SummaryIndex[],
  cwd: string,
  date: string,
): SummaryIndex[] {
  return summaries.filter((s) => s.date === date && s.cwd === cwd);
}

/** Derive the YYYY-MM month an ISO week belongs to (via Thursday attribution). */
export function monthOfIsoWeek(isoWeek: string): string | null {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const week = Number(match[2]);

  // Find Jan 4 of the year (always in ISO week 1)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  // Find Monday of week 1
  const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon..7=Sun
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (dayOfWeek - 1));

  // Monday of the target week
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  // Thursday of the target week determines the month
  const thursday = new Date(targetMonday);
  thursday.setUTCDate(targetMonday.getUTCDate() + 3);

  return `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Check if an ISO week belongs to a given month (YYYY-MM). */
export function weekBelongsToMonth(isoWeek: string, month: string): boolean {
  return monthOfIsoWeek(isoWeek) === month;
}

// --- I/O ---

/** Load and parse a rollup file. Returns null if missing or corrupt. */
export async function loadRollup(filePath: string): Promise<Rollup | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  try {
    const content = await file.text();
    return parseRollupFile(content);
  } catch {
    return null;
  }
}

/** Write a rollup file atomically (temp + rename with PID). */
export async function writeRollup(
  projDir: string,
  period: RollupPeriod,
  rollup: Rollup,
): Promise<void> {
  await mkdir(projDir, { recursive: true });
  const targetPath = join(projDir, `${period}.md`);
  const tmpPath = join(projDir, `.${period}.md.tmp.${process.pid}`);
  const content = serializeRollup(rollup);
  await Bun.write(tmpPath, content);
  await rename(tmpPath, targetPath);
}

/** Archive an active rollup file to archive/{period}/{date}.md. */
export async function archiveRollup(
  projDir: string,
  period: RollupPeriod,
  date: string,
): Promise<void> {
  const sourcePath = join(projDir, `${period}.md`);
  const archiveDir = join(projDir, "archive", period);
  await mkdir(archiveDir, { recursive: true });
  const destPath = join(archiveDir, `${date}.md`);
  await rename(sourcePath, destPath);
}

/** Read archived dailies for a given ISO week, sorted by date. */
export async function gatherWeekDailies(projDir: string, isoWeek: string): Promise<Rollup[]> {
  const archiveDir = join(projDir, "archive", "daily");
  let entries: string[];
  try {
    entries = await readdir(archiveDir);
  } catch {
    return [];
  }

  const rollups: Rollup[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const dateStr = entry.replace(/\.md$/, "");
    // Check if date falls within the ISO week
    const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC to avoid timezone issues
    if (Number.isNaN(d.getTime())) continue;
    if (isoWeekString(d) !== isoWeek) continue;

    const rollup = await loadRollup(join(archiveDir, entry));
    if (rollup) rollups.push(rollup);
  }

  rollups.sort((a, b) => a.date.localeCompare(b.date));
  return rollups;
}

/** Read archived weeklies for a given month, sorted by week. */
export async function gatherMonthWeeklies(projDir: string, month: string): Promise<Rollup[]> {
  const archiveDir = join(projDir, "archive", "weekly");
  let entries: string[];
  try {
    entries = await readdir(archiveDir);
  } catch {
    return [];
  }

  const rollups: Rollup[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const weekStr = entry.replace(/\.md$/, "");
    if (!weekBelongsToMonth(weekStr, month)) continue;

    const rollup = await loadRollup(join(archiveDir, entry));
    if (rollup) rollups.push(rollup);
  }

  rollups.sort((a, b) => a.date.localeCompare(b.date));
  return rollups;
}

// --- Project matching (session-start) ---

/** Read the CWD from the first available rollup in a project dir. */
async function readProjectCwd(projDir: string): Promise<string | null> {
  for (const period of ["daily", "weekly", "monthly"] as const) {
    const rollup = await loadRollup(join(projDir, `${period}.md`));
    if (rollup) return rollup.cwd;
  }
  return null;
}

/** Check if two paths have an ancestor/descendant relationship (or are equal). */
function isPathRelated(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Find project dirs whose CWD is an ancestor or descendant of the given cwd. */
export async function findMatchingProjects(rollupsDir: string, cwd: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(rollupsDir);
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const dirPath = join(rollupsDir, entry);
    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const projectCwd = await readProjectCwd(dirPath);
    if (!projectCwd) continue;

    if (isPathRelated(projectCwd, cwd) || isPathRelated(cwd, projectCwd)) {
      matches.push(dirPath);
    }
  }

  return matches;
}

// --- Locking ---

const LOCK_POLL_MS = 500;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Per-project directory-based lock. Returns null on timeout (fail-open). */
export async function withRollupLock<T>(projDir: string, fn: () => Promise<T>): Promise<T | null> {
  const lockDir = join(projDir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch {
      // Lock held — check staleness before waiting
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_TIMEOUT_MS) {
        // Stale lock from crashed worker — steal it
        await rmdir(lockDir).catch(() => {});
        continue;
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
  }

  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}

// --- Orchestrator helpers ---

async function callInference(prompt: string, model?: string): Promise<string | null> {
  const result = await inference({ userPrompt: prompt, model, timeout: 60000 });
  if (!result.success || !result.text) {
    console.error(`Rollup inference failed: ${result.error ?? "no response"}`);
    return null;
  }
  return result.text.trim();
}

function makeRollup(
  period: RollupPeriod,
  cwd: string,
  date: string,
  body: string,
  sessionCount = 0,
): Rollup {
  return {
    period,
    cwd,
    date,
    lastUpdated: new Date().toISOString(),
    sessionCount,
    body,
  };
}

/** Create a fresh daily from gathered sessions. */
async function createFreshDaily(
  projDir: string,
  cwd: string,
  date: string,
  sessionTexts: string[],
  model?: string,
): Promise<void> {
  if (sessionTexts.length === 0) return;
  const prompt = buildDailyUpdatePrompt(null, sessionTexts);
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(projDir, "daily", makeRollup("daily", cwd, date, body, sessionTexts.length));
}

/** Merge a session into an existing daily. */
async function mergeDailySession(
  projDir: string,
  existing: Rollup,
  sessionText: string,
  model?: string,
): Promise<void> {
  const prompt = buildDailyUpdatePrompt(existing.body, [sessionText]);
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(
    projDir,
    "daily",
    makeRollup("daily", existing.cwd, existing.date, body, existing.sessionCount + 1),
  );
}

/** Fold a completed daily into the weekly for its period. */
async function foldDailyIntoWeekly(
  projDir: string,
  cwd: string,
  daily: Rollup,
  model?: string,
): Promise<void> {
  const weeklyPath = join(projDir, "weekly.md");
  const existingWeekly = await loadRollup(weeklyPath);
  const isoWeek = isoWeekString(new Date(`${daily.date}T12:00:00Z`));

  const prompt = buildFoldPrompt("weekly", existingWeekly?.body ?? null, [
    { label: daily.date, body: daily.body },
  ]);
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(projDir, "weekly", makeRollup("weekly", cwd, isoWeek, body));
}

/** Create a new weekly from all archived dailies for the current ISO week. */
async function createNewWeekly(projDir: string, cwd: string, model?: string): Promise<void> {
  const isoWeek = currentIsoWeek();
  const dailies = await gatherWeekDailies(projDir, isoWeek);
  if (dailies.length === 0) return;

  const prompt = buildFoldPrompt(
    "weekly",
    null,
    dailies.map((d) => ({ label: d.date, body: d.body })),
  );
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(projDir, "weekly", makeRollup("weekly", cwd, isoWeek, body));
}

/** Fold a completed weekly into the monthly for its period. */
async function foldWeeklyIntoMonthly(
  projDir: string,
  cwd: string,
  weekly: Rollup,
  model?: string,
): Promise<void> {
  const monthlyPath = join(projDir, "monthly.md");
  const existingMonthly = await loadRollup(monthlyPath);
  const month = monthOfIsoWeek(weekly.date) ?? currentMonth();

  const prompt = buildFoldPrompt("monthly", existingMonthly?.body ?? null, [
    { label: weekly.date, body: weekly.body },
  ]);
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(projDir, "monthly", makeRollup("monthly", cwd, month, body));
}

/** Create a new monthly from all archived weeklies for the current month. */
async function createNewMonthly(projDir: string, cwd: string, model?: string): Promise<void> {
  const month = currentMonth();
  const weeklies = await gatherMonthWeeklies(projDir, month);
  if (weeklies.length === 0) return;

  const prompt = buildFoldPrompt(
    "monthly",
    null,
    weeklies.map((w) => ({ label: w.date, body: w.body })),
  );
  const body = await callInference(prompt, model);
  if (!body) return;
  await writeRollup(projDir, "monthly", makeRollup("monthly", cwd, month, body));
}

// --- Main orchestrator ---

/** Gather session texts from storage for today. Current session is already on disk. */
async function gatherSessionTexts(memoryDir: string, cwd: string, date: string): Promise<string[]> {
  const { listSummaries, loadSummary } = await import("./storage");
  const allSummaries = await listSummaries(memoryDir);
  const todaySessions = gatherTodaySessions(allSummaries, cwd, date);
  const texts: string[] = [];
  for (const s of todaySessions) {
    const full = await loadSummary(s.filePath);
    if (full) texts.push(`### ${full.title}\n\n${full.body}`);
  }
  return texts;
}

/** Handle monthly rollover or fold when weekly is rolling over. */
async function handleMonthlyRollover(
  projDir: string,
  cwd: string,
  weekly: Rollup,
  model?: string,
): Promise<void> {
  const monthlyPath = join(projDir, "monthly.md");

  // Fold the outgoing weekly into its monthly first
  await foldWeeklyIntoMonthly(projDir, cwd, weekly, model);

  // Re-read monthly after fold (may have just been created)
  const updatedMonthly = await loadRollup(monthlyPath);
  if (updatedMonthly && needsRollover(updatedMonthly)) {
    await archiveRollup(projDir, "monthly", updatedMonthly.date);
    await createNewMonthly(projDir, cwd, model);
  }
}

/** Process the rollover chain (top-down: monthly -> weekly -> daily). */
async function processRolloverChain(
  projDir: string,
  cwd: string,
  daily: Rollup,
  model?: string,
): Promise<void> {
  const weeklyPath = join(projDir, "weekly.md");
  const weekly = await loadRollup(weeklyPath);

  // Always fold the outgoing daily into its weekly before any archiving
  await foldDailyIntoWeekly(projDir, cwd, daily, model);

  if (weekly && needsRollover(weekly)) {
    // Weekly now contains the final daily — fold into monthly, then archive
    const updatedWeekly = await loadRollup(weeklyPath);
    if (updatedWeekly) {
      await handleMonthlyRollover(projDir, cwd, updatedWeekly, model);
    }
    await archiveRollup(projDir, "weekly", weekly.date);
    await createNewWeekly(projDir, cwd, model);
  }

  await archiveRollup(projDir, "daily", daily.date);
}

/**
 * Update rolling summaries after a session ends.
 * Single entry point called from session-end hook.
 * Handles rollover detection, archiving, and inference calls.
 * Fail-open: errors are logged but don't propagate.
 */
export async function updateRollups(
  memoryDir: string,
  summaryText: string,
  cwd: string,
  model?: string,
): Promise<void> {
  const rollupsDir = join(memoryDir, "rollups");
  const projDir = projectDir(rollupsDir, cwd);
  await mkdir(projDir, { recursive: true });

  const result = await withRollupLock(projDir, async () => {
    const daily = await loadRollup(join(projDir, "daily.md"));
    const today = todayDateString();

    if (!daily) {
      const sessionTexts = await gatherSessionTexts(memoryDir, cwd, today);
      await createFreshDaily(projDir, cwd, today, sessionTexts, model);
      return;
    }

    if (!needsRollover(daily)) {
      await mergeDailySession(projDir, daily, summaryText, model);
      return;
    }

    await processRolloverChain(projDir, cwd, daily, model);
    const sessionTexts = await gatherSessionTexts(memoryDir, cwd, today);
    await createFreshDaily(projDir, cwd, today, sessionTexts, model);
  });

  if (result === null) {
    console.error("Rollup lock timeout — skipping update");
  }
}

// --- Session-start loading ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Load rolling summaries for context injection at session start.
 * Returns formatted markdown string or empty string if none available.
 */
export async function loadRollups(memoryDir: string, cwd: string): Promise<string> {
  const rollupsDir = join(memoryDir, "rollups");
  const projectDirs = await findMatchingProjects(rollupsDir, cwd);
  const allSections: string[] = [];

  for (const projDir of projectDirs) {
    const sections: string[] = [];

    for (const period of ["monthly", "weekly", "daily"] as const) {
      const rollup = await loadRollup(join(projDir, `${period}.md`));
      if (!rollup?.body) continue;
      sections.push(`### ${capitalize(period)} Summary (${rollup.date})\n\n${rollup.body}`);
    }

    if (sections.length > 0) {
      allSections.push(sections.join("\n\n"));
    }
  }

  if (allSections.length === 0) return "";
  return `## Rolling Summaries\n\n${allSections.join("\n\n")}`;
}
