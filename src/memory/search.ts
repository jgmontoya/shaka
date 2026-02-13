/**
 * Memory search: case-insensitive substring matching across session summaries
 * and learnings.
 *
 * Searches file content (title, body, tags) and returns matches
 * sorted by date (most recent first) with context snippets.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadLearnings, renderEntry } from "./learnings";
import { parseSummaryOutput } from "./summarize";

const MAX_RESULTS = 10;
const SNIPPET_LENGTH = 200;

export interface SearchResult {
  readonly type: "session" | "learning";
  readonly filePath: string;
  readonly title: string;
  readonly date: string;
  readonly tags: string[];
  readonly snippet: string;
}

/**
 * Search sessions and learnings for a query string.
 *
 * Performs case-insensitive substring matching across both data sources.
 * Returns up to 10 results sorted by date (most recent first).
 */
export async function searchMemory(query: string, memoryDir: string): Promise<SearchResult[]> {
  const [sessionResults, learningResults] = await Promise.all([
    searchSessions(query, memoryDir),
    searchLearnings(query, memoryDir),
  ]);

  return [...learningResults, ...sessionResults]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RESULTS);
}

async function searchSessions(query: string, memoryDir: string): Promise<SearchResult[]> {
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

async function searchLearnings(query: string, memoryDir: string): Promise<SearchResult[]> {
  const entries = await loadLearnings(memoryDir);
  if (entries.length === 0) return [];

  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const entry of entries) {
    const searchable = `${entry.title}\n${entry.body}`.toLowerCase();
    if (!searchable.includes(queryLower)) continue;

    const lastExposure = entry.exposures[entry.exposures.length - 1];

    results.push({
      type: "learning",
      filePath: join(memoryDir, "learnings.md"),
      title: entry.title,
      date: lastExposure?.date ?? "",
      tags: [entry.category],
      snippet: extractSnippet(renderEntry(entry), queryLower),
    });
  }

  return results;
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
