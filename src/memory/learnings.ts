/**
 * Core learnings module: types, parsing, rendering, storage, scoring,
 * selection, undo-and-rewrite, merge, promotion, extraction prompts,
 * quality assessment, and filtering.
 *
 * A learning is a reusable insight extracted from session transcripts —
 * corrections, preferences, patterns, or facts worth persisting.
 * Stored in a single markdown file with HTML comment metadata per entry.
 *
 * See also: consolidation.ts for duplicate/contradiction detection.
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

// --- Shared quality criteria ---

/**
 * Single source of truth for what makes a learning worth keeping.
 * Used by both extraction (session-end) and quality assessment (review --prune).
 */

const QUALITY_GATES = `\
- NON-OBVIOUS: Would an experienced engineer or LLM get this wrong without being told?
- RECURRING: Will this exact situation come up again in a future session?
- BEHAVIOR-CHANGING: Would it change the LLM's default behavior? Vague truisms ("validate early") don't — but project-specific gotchas do, even if narrow.`;

const LOW_QUALITY_PATTERNS = `\
- General engineering wisdom (DRY, test through public interfaces, validate early, etc.)
- One-time code review findings — the fix is now in the code, the learning is redundant
- Architectural descriptions of how a codebase works — these belong in project docs, not learnings
- Meta-observations about your own reasoning process or approach
- Process advice (how to plan, how to review, how to evaluate ideas)
- Patterns that any senior engineer would apply without being told
- Information already in the project's config files, README, or CLAUDE.md
- Speculative observations without clear evidence in the transcript
- One-time debugging steps or decisions that won't recur`;

const HIGH_QUALITY_PATTERNS = `\
- User corrections where the LLM got something wrong ("no, do X instead of Y")
- Stated user preferences ("I always want X", "never do Y")
- Non-obvious project conventions that contradict common defaults
- Environment gotchas that would cause real bugs (wrong units, surprising config values)
- Framework/library behaviors that are counterintuitive or version-specific`;

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
   persisting for future sessions. Return 0-2 learnings. Most sessions should have 0.

The bar for extraction is HIGH. A learning must pass ALL three tests:
${QUALITY_GATES}

If a candidate fails ANY test, do not extract it.

Do NOT extract:
${LOW_QUALITY_PATTERNS}

DO extract:
${HIGH_QUALITY_PATTERNS}

If a learning matches an existing entry below, use its EXACT title
character-for-character (this enables automatic reinforcement tracking):

${titlesBlock}

If nothing in the transcript is worth persisting, return an empty Learnings section.
The default is 0 learnings. Extract only when something genuinely surprising was learned.

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

// --- Promotion ---

const PROMOTION_CWD_THRESHOLD = 3;

/** Find entries eligible for CWD-to-global promotion. */
export function findPromotionCandidates(entries: LearningEntry[]): LearningEntry[] {
  return entries.filter(
    (e) => !e.nonglobal && !e.cwds.includes("*") && e.cwds.length >= PROMOTION_CWD_THRESHOLD,
  );
}

/** Promote an entry to global. */
export function promoteToGlobal(entry: LearningEntry): LearningEntry {
  return { ...entry, cwds: ["*"] };
}

/** Mark an entry as nonglobal to prevent future promotion prompts. */
export function markNonglobal(entry: LearningEntry): LearningEntry {
  return { ...entry, nonglobal: true };
}

// --- Quality Assessment (review --prune) ---

export interface QualityVerdict {
  readonly index: number; // 0-based
  readonly reason: string;
}

/** Build prompt for AI quality assessment. Returns indices of low-quality entries. */
export function buildQualityAssessmentPrompt(entries: LearningEntry[]): string {
  const numbered = entries
    .map(
      (e, i) =>
        `[${i + 1}] (${e.category}) ${e.title} [${e.exposures.length} exposure(s)]\n${e.body}`,
    )
    .join("\n\n");

  return `Evaluate each learning entry for future-session utility. Flag entries that are LOW QUALITY.

A learning is low quality if it fails ANY of these tests:
${QUALITY_GATES}

Common low-quality patterns:
${LOW_QUALITY_PATTERNS}

High-quality entries to KEEP (do NOT flag these):
${HIGH_QUALITY_PATTERNS}

## Entries

${numbered}

## Instructions

For each LOW QUALITY entry, output one line:
LOW [N] — reason (one sentence)

If all entries are high quality, output exactly:
ALL HIGH QUALITY

Do not modify any entry. Only flag entries you are confident are low quality.`;
}

/** Parse quality assessment output into verdicts. Returns 0-based indices. */
export function parseQualityAssessmentOutput(raw: string): QualityVerdict[] {
  if (raw.trim() === "ALL HIGH QUALITY") return [];

  const verdicts: QualityVerdict[] = [];
  const lineRe = /^LOW\s*\[(\d+)\]\s*[-–—]\s*(.+)$/;

  for (const line of raw.split("\n")) {
    const match = line.trim().match(lineRe);
    if (!match) continue;

    const index = Number.parseInt(match[1] ?? "", 10) - 1;
    const reason = match[2]?.trim() ?? "";
    if (!(index >= 0) || !reason) continue;

    verdicts.push({ index, reason });
  }

  return verdicts;
}

// --- Filtering ---

/** Filter entries by free-text query. Global entries always included. */
export function filterLearnings(entries: LearningEntry[], query: string): LearningEntry[] {
  if (!query || query.toLowerCase() === "all") return entries;

  const q = query.toLowerCase();
  const isGlobalQuery = q === "global";

  return entries.filter((entry) => {
    // Global entries always appear in any filter
    if (entry.cwds.includes("*")) return true;

    // "global" keyword shows only global entries
    if (isGlobalQuery) return false;

    // Match against CWD paths, title, body
    const cwdMatch = entry.cwds.some((cwd) => cwd.toLowerCase().includes(q));
    const titleMatch = entry.title.toLowerCase().includes(q);
    const bodyMatch = entry.body.toLowerCase().includes(q);

    return cwdMatch || titleMatch || bodyMatch;
  });
}

/** Sort entries by exposure count, highest first. */
export function sortByExposures(entries: LearningEntry[]): LearningEntry[] {
  return [...entries].sort((a, b) => b.exposures.length - a.exposures.length);
}

// Re-export for hooks
export { hashSessionId } from "./utils";
