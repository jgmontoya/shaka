/**
 * Summary file storage: write, list, load, and select session summaries.
 *
 * Files are stored as markdown with YAML frontmatter in memory/sessions/.
 * Filename format: YYYY-MM-DD-{hash8}.md
 * hash8 = first 8 chars of SHA-256(sessionId) for provider-agnostic uniqueness.
 * Title lives in frontmatter and heading, not filename — ensures one file per
 * session per day so re-summarization overwrites cleanly.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { type SessionSummary, parseSummaryOutput } from "./summarize";
import { hashSessionId } from "./utils";

export interface SummaryIndex {
  readonly filePath: string;
  readonly title: string;
  readonly date: string;
  readonly cwd: string;
  readonly tags: string[];
  readonly provider: "claude" | "opencode";
  readonly sessionId: string;
}

/**
 * Write a session summary to disk as markdown with YAML frontmatter.
 *
 * Creates memory/sessions/ if it doesn't exist.
 * Returns the written file path.
 */
export async function writeSummary(memoryDir: string, summary: SessionSummary): Promise<string> {
  const sessionsDir = join(memoryDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const sessionHash = hashSessionId(summary.metadata.sessionId);
  const filename = `${summary.metadata.date}-${sessionHash}.md`;
  const filePath = join(sessionsDir, filename);

  const content = serializeSummary(summary);
  await Bun.write(filePath, content);

  return filePath;
}

/**
 * List all session summaries in memory/sessions/, sorted by date (most recent first).
 *
 * Parses YAML frontmatter from each file for index data.
 * Returns empty array if the directory doesn't exist.
 */
export async function listSummaries(memoryDir: string): Promise<SummaryIndex[]> {
  const sessionsDir = join(memoryDir, "sessions");

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const indices: SummaryIndex[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(sessionsDir, entry);
    const summary = await loadSummary(filePath);
    if (!summary) continue;

    indices.push(summaryToIndex(filePath, summary));
  }

  indices.sort((a, b) => b.date.localeCompare(a.date));
  return indices;
}

/**
 * Load and parse a single summary file.
 * Returns null if the file doesn't exist or is unparseable.
 */
export async function loadSummary(filePath: string): Promise<SessionSummary | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  try {
    const content = await file.text();
    return parseSummaryOutput(content);
  } catch {
    return null;
  }
}

/**
 * Select the most relevant recent summaries for context loading.
 *
 * Prefers summaries matching the current working directory.
 * Fills remaining slots with most recent from other directories.
 * Returns up to `limit` summaries (default 3).
 */
export function selectRecentSummaries(
  summaries: SummaryIndex[],
  cwd: string,
  limit = 3,
): SummaryIndex[] {
  if (summaries.length === 0) return [];

  const cwdMatches = summaries.filter((s) => s.cwd === cwd);
  const others = summaries.filter((s) => s.cwd !== cwd);

  const selected = cwdMatches.slice(0, limit);

  if (selected.length < limit) {
    const remaining = limit - selected.length;
    selected.push(...others.slice(0, remaining));
  }

  return selected;
}

/**
 * Render selected session summaries into a markdown section, respecting a character budget.
 *
 * Loads each summary from disk, renders it, and accumulates sections until the
 * budget is exhausted. Returns the full "## Recent Sessions" section, or empty
 * string if no summaries fit.
 */
export async function renderSessionSection(
  selected: SummaryIndex[],
  budget: number,
): Promise<string> {
  if (selected.length === 0) return "";

  const sections: string[] = [];
  let totalChars = 0;

  for (const index of selected) {
    const summary = await loadSummary(index.filePath);
    if (!summary) continue;

    const section = `### ${summary.title}\n*${summary.metadata.date} | ${summary.metadata.provider}*\n\n${summary.body}`;

    if (totalChars + section.length > budget && sections.length > 0) break;

    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return "";

  return `## Recent Sessions\n\n${sections.join("\n\n---\n\n")}`;
}

// --- Helpers ---

function serializeSummary(summary: SessionSummary): string {
  const frontmatter = stringifyYaml({
    date: summary.metadata.date,
    cwd: summary.metadata.cwd,
    tags: summary.tags,
    provider: summary.metadata.provider,
    session_id: summary.metadata.sessionId,
  }).trim();

  return `---\n${frontmatter}\n---\n\n# ${summary.title}\n\n${summary.body}\n`;
}

function summaryToIndex(filePath: string, summary: SessionSummary): SummaryIndex {
  return {
    filePath,
    title: summary.title,
    date: summary.metadata.date,
    cwd: summary.metadata.cwd,
    tags: summary.tags,
    provider: summary.metadata.provider,
    sessionId: summary.metadata.sessionId,
  };
}
