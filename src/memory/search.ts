/**
 * Memory search: case-insensitive substring matching across session summaries,
 * active learnings, and archived learnings.
 *
 * Searches file content (title, body, tags) and returns matches
 * sorted by date (most recent first) with context snippets.
 * Archive results are prefixed with "[archived]" in their snippets.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ARCHIVE_FILE,
  type LearningEntry,
  loadLearnings,
  parseLearnings,
  renderEntry,
} from "./learnings";
import { parseSummaryOutput } from "./summarize";

const DEFAULT_MAX_RESULTS = 10;
const SNIPPET_LENGTH = 200;

export interface SearchFilter {
  readonly category?: string;
  readonly cwd?: string;
  readonly type?: "session" | "learning";
}

export interface SearchResult {
  readonly type: "session" | "learning";
  readonly filePath: string;
  readonly title: string;
  readonly date: string;
  readonly tags: string[];
  readonly snippet: string;
  readonly category?: string;
}

/**
 * Search sessions and learnings for a query string.
 *
 * Performs case-insensitive substring matching across both data sources.
 * Returns up to maxResults (default 10) sorted by date (most recent first).
 */
export async function searchMemory(
  query: string,
  memoryDir: string,
  filter?: SearchFilter,
  maxResults?: number,
): Promise<SearchResult[]> {
  const limit = maxResults ?? DEFAULT_MAX_RESULTS;

  const [sessionResults, learningResults, archiveResults] = await Promise.all([
    filter?.type === "learning" ? [] : searchSessions(query, memoryDir, filter),
    filter?.type === "session" ? [] : searchLearnings(query, memoryDir, filter),
    filter?.type === "session" ? [] : searchArchive(query, memoryDir, filter),
  ]);

  return [...learningResults, ...archiveResults, ...sessionResults]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

async function searchSessions(
  query: string,
  memoryDir: string,
  filter?: SearchFilter,
): Promise<SearchResult[]> {
  const sessionsDir = join(memoryDir, "sessions");
  const queryLower = query.toLowerCase();

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const results: SearchResult[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;

    const filePath = join(sessionsDir, entry);
    const file = Bun.file(filePath);

    let content: string;
    try {
      content = await file.text();
    } catch {
      continue;
    }

    if (!content.toLowerCase().includes(queryLower)) continue;

    const summary = parseSummaryOutput(content);
    if (!summary) continue;

    if (filter?.cwd && !summary.metadata.cwd.toLowerCase().includes(filter.cwd.toLowerCase())) {
      continue;
    }

    results.push({
      type: "session",
      filePath,
      title: summary.title,
      date: summary.metadata.date,
      tags: summary.tags,
      snippet: extractSnippet(content, queryLower),
    });
  }

  return results;
}

function searchEntries(
  entries: LearningEntry[],
  query: string,
  filePath: string,
  filter?: SearchFilter,
  snippetPrefix?: string,
): SearchResult[] {
  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const entry of entries) {
    if (filter?.category && entry.category !== filter.category) continue;
    if (
      filter?.cwd &&
      !entry.cwds.some((c) => c.toLowerCase().includes(filter.cwd?.toLowerCase() ?? ""))
    )
      continue;

    const searchable = `${entry.title}\n${entry.body}`.toLowerCase();
    if (!searchable.includes(queryLower)) continue;

    const lastExposure = entry.exposures[entry.exposures.length - 1];
    const snippet = extractSnippet(renderEntry(entry), queryLower);

    results.push({
      type: "learning",
      filePath,
      title: entry.title,
      date: lastExposure?.date ?? "",
      tags: [entry.category],
      snippet: snippetPrefix ? `${snippetPrefix} ${snippet}` : snippet,
      category: entry.category,
    });
  }

  return results;
}

async function searchLearnings(
  query: string,
  memoryDir: string,
  filter?: SearchFilter,
): Promise<SearchResult[]> {
  const entries = await loadLearnings(memoryDir);
  return searchEntries(entries, query, join(memoryDir, "learnings.md"), filter);
}

async function searchArchive(
  query: string,
  memoryDir: string,
  filter?: SearchFilter,
): Promise<SearchResult[]> {
  const archivePath = join(memoryDir, ARCHIVE_FILE);
  const file = Bun.file(archivePath);

  if (!(await file.exists())) return [];

  let content: string;
  try {
    content = await file.text();
  } catch {
    return [];
  }

  const entries = parseLearnings(content);
  return searchEntries(entries, query, archivePath, filter, "[archived]");
}

/**
 * Extract a snippet of ~200 chars centered around the first occurrence
 * of the query in the content.
 */
function extractSnippet(content: string, queryLower: string): string {
  const lowerContent = content.toLowerCase();
  const matchIndex = lowerContent.indexOf(queryLower);

  if (matchIndex === -1) return content.slice(0, SNIPPET_LENGTH);

  const halfWindow = Math.floor(SNIPPET_LENGTH / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(content.length, matchIndex + queryLower.length + halfWindow);

  let snippet = content.slice(start, end).trim();

  if (start > 0) snippet = `...${snippet}`;
  if (end < content.length) snippet = `${snippet}...`;

  return snippet;
}
