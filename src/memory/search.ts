/**
 * Memory search: case-insensitive substring matching across session summaries,
 * active and archived learnings, and compiled project knowledge.
 *
 * Searches file content (title, body, tags) and returns matches
 * sorted by date (most recent first) with context snippets.
 * Archive results are prefixed with "[archived]" in their snippets.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../domain/frontmatter";
import { resolveKnowledgeProjectDir } from "./knowledge";
import {
  ARCHIVE_FILE,
  type LearningEntry,
  loadLearnings,
  matchesCwd,
  parseLearnings,
  renderEntry,
} from "./learnings";
import { parseSummaryOutput } from "./summarize";
import { arePathsRelated } from "./utils";

const DEFAULT_MAX_RESULTS = 10;
const SNIPPET_LENGTH = 200;

export interface SearchFilter {
  readonly category?: string;
  readonly cwd?: string;
  readonly type?: "session" | "learning" | "knowledge";
  readonly allProjects?: boolean;
}

export interface SearchResult {
  readonly type: "session" | "learning" | "knowledge";
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
  if (filter?.cwd && filter.allProjects) {
    throw new Error("cwd and allProjects cannot be used together");
  }
  const scopedFilter: SearchFilter = filter?.allProjects
    ? filter
    : { ...filter, cwd: filter?.cwd ?? process.cwd() };

  const [sessionResults, learningResults, archiveResults, knowledgeResults] = await Promise.all([
    scopedFilter.type && scopedFilter.type !== "session"
      ? []
      : searchSessions(query, memoryDir, scopedFilter),
    scopedFilter.type && scopedFilter.type !== "learning"
      ? []
      : searchLearnings(query, memoryDir, scopedFilter),
    scopedFilter.type && scopedFilter.type !== "learning"
      ? []
      : searchArchive(query, memoryDir, scopedFilter),
    scopedFilter.type && scopedFilter.type !== "knowledge"
      ? []
      : searchKnowledge(query, memoryDir, scopedFilter),
  ]);

  return [...learningResults, ...archiveResults, ...sessionResults, ...knowledgeResults]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

async function searchKnowledge(
  query: string,
  memoryDir: string,
  filter: SearchFilter,
): Promise<SearchResult[]> {
  const knowledgeRoot = join(memoryDir, "knowledge");
  const projectDirs = filter.allProjects
    ? await listProjectDirectories(knowledgeRoot)
    : filter.cwd
      ? [await resolveKnowledgeProjectDir(memoryDir, filter.cwd)]
      : [];
  const queryLower = query.toLowerCase();
  const nestedResults = await Promise.all(
    projectDirs.map((projectDir) => searchKnowledgeDirectory(queryLower, projectDir)),
  );
  return nestedResults.flat();
}

async function searchKnowledgeDirectory(
  queryLower: string,
  projectDir: string,
): Promise<SearchResult[]> {
  const entries = await readdir(projectDir).catch(() => [] as string[]);
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "_index.md" || entry === "log.md") continue;

    const filePath = join(projectDir, entry);
    const content = await Bun.file(filePath)
      .text()
      .catch(() => "");
    const parsed = parseFrontmatter(content);
    if (!parsed || !content.toLowerCase().includes(queryLower)) continue;

    results.push({
      type: "knowledge",
      filePath,
      title: String(parsed.frontmatter.title ?? entry.replace(/\.md$/, "")),
      date: String(parsed.frontmatter.updated ?? ""),
      tags: [],
      snippet: extractSnippet(content, queryLower),
    });
  }
  return results;
}

async function listProjectDirectories(knowledgeRoot: string): Promise<string[]> {
  const entries = await readdir(knowledgeRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(knowledgeRoot, entry.name));
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

    if (filter?.cwd && !arePathsRelated(summary.metadata.cwd, filter.cwd)) {
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
    if (filter?.cwd && !matchesCwd(entry, filter.cwd)) continue;

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
