/**
 * Knowledge compilation: extract, group, compile, and maintain topic pages.
 *
 * Knowledge fragments are extracted from session summaries (## Knowledge sections)
 * and compiled into persistent topic pages. Topic pages are incrementally updated
 * as new sessions produce new fragments.
 *
 * See also: knowledge-base.md for the full design spec.
 */

import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../domain/frontmatter";
import { projectSlug } from "./rollups";
import { type KnowledgeFragment, parseExtractedKnowledge } from "./summarize";
import { hashContent, isPathRelated } from "./utils";

// --- Types ---

export interface KnowledgeManifest {
  readonly compiledSources: Record<string, string>; // filename → content hash
  readonly lastCompilation: string; // ISO 8601
}

export interface SessionEntry {
  readonly filename: string;
  readonly contentHash: string;
  readonly content: string;
}

/**
 * Read existing topic page titles from a knowledge directory.
 * Used by the session-end hook to inject existing titles into the
 * extraction prompt for tag convergence.
 *
 * Fail-open: returns empty array on any error.
 */
export async function readExistingTopicTitles(knowledgeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(knowledgeDir);
    return entries
      .filter((f) => f.endsWith(".md") && f !== "_index.md" && f !== "log.md")
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// --- Manifest ---

const MANIFEST_FILE = ".manifest.json";

/**
 * Read the compilation manifest from a knowledge directory.
 * Returns an empty manifest if the file doesn't exist or is corrupt.
 */
export async function readManifest(knowledgeDir: string): Promise<KnowledgeManifest> {
  const empty: KnowledgeManifest = { compiledSources: {}, lastCompilation: "" };
  try {
    const file = Bun.file(join(knowledgeDir, MANIFEST_FILE));
    if (!(await file.exists())) return empty;
    const data = await file.json();
    return {
      compiledSources: data.compiledSources ?? {},
      lastCompilation: data.lastCompilation ?? "",
    };
  } catch {
    return empty;
  }
}

// --- Unprocessed session detection ---

/**
 * Find sessions not yet compiled or with changed content hashes.
 * Pure function: no I/O.
 */
export function findUnprocessedSessions(
  manifest: KnowledgeManifest,
  sessions: SessionEntry[],
): SessionEntry[] {
  return sessions.filter((s) => {
    const compiledHash = manifest.compiledSources[s.filename];
    // Not in manifest, or hash changed
    return compiledHash === undefined || compiledHash !== s.contentHash;
  });
}

// --- Fragment extraction ---

/**
 * Extract knowledge fragments from the raw content of a session summary file.
 * The filename (without .md) is used as the sourceSession identifier.
 */
export function extractFragmentsFromSummary(
  summaryContent: string,
  sessionFilename: string,
): KnowledgeFragment[] {
  const sourceSession = sessionFilename.replace(/\.md$/, "");
  // We need the raw content, not the parsed body (which strips Knowledge section).
  // parseExtractedKnowledge operates on raw text containing the ## Knowledge heading.
  return parseExtractedKnowledge(summaryContent, {
    date: "",
    cwd: "",
    sessionHash: sourceSession,
  });
}

// --- Tag grouping ---

/** Normalize a tag: lowercase, trim, replace spaces with hyphens. */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Group knowledge fragments by their topic tags.
 * Deterministic algorithm — no LLM involved.
 *
 * 1. Normalize all tags (lowercase, trim, hyphens for spaces)
 * 2. Match against existing topic page slugs
 * 3. Unmatched fragments grouped by shared tags; group name = most common tag
 * 4. Multiple matches → assign to topic with most tag overlap
 * 5. Fragments with zero tags are skipped
 */
export function groupFragmentsByTopic(
  fragments: KnowledgeFragment[],
  existingSlugs: string[],
): Map<string, KnowledgeFragment[]> {
  const groups = new Map<string, KnowledgeFragment[]>();
  const slugSet = new Set(existingSlugs);
  const unmatched: KnowledgeFragment[] = [];

  for (const fragment of fragments) {
    const tags = fragment.topics.map(normalizeTag).filter(Boolean);
    if (tags.length === 0) continue;

    const match = tags.find((t) => slugSet.has(t));
    if (match) {
      addToGroup(groups, match, fragment);
    } else {
      unmatched.push(fragment);
    }
  }

  groupUnmatchedByFrequency(groups, unmatched);
  return groups;
}

function addToGroup(
  groups: Map<string, KnowledgeFragment[]>,
  key: string,
  fragment: KnowledgeFragment,
): void {
  const existing = groups.get(key) ?? [];
  existing.push(fragment);
  groups.set(key, existing);
}

function groupUnmatchedByFrequency(
  groups: Map<string, KnowledgeFragment[]>,
  unmatched: KnowledgeFragment[],
): void {
  if (unmatched.length === 0) return;

  const tagCounts = new Map<string, number>();
  for (const f of unmatched) {
    for (const tag of f.topics.map(normalizeTag).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  for (const fragment of unmatched) {
    const tags = fragment.topics.map(normalizeTag).filter(Boolean);
    const bestTag = pickMostFrequentTag(tags, tagCounts);
    if (bestTag) addToGroup(groups, bestTag, fragment);
  }
}

function pickMostFrequentTag(tags: string[], counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const tag of tags) {
    const count = counts.get(tag) ?? 0;
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

// --- Prompt builders ---

const SIZE_LIMIT = 3500;

/** Format fragments for inclusion in prompts. */
function renderFragmentsForPrompt(fragments: KnowledgeFragment[]): string {
  return fragments
    .map((f) => {
      const topicsLine = f.topics.length > 0 ? `\nTopics: ${f.topics.join(", ")}` : "";
      return `### ${f.title}\nSource: ${f.sourceSession}${topicsLine}\n\n${f.body}`;
    })
    .join("\n\n");
}

/**
 * Build prompt for creating a new topic page from fragments.
 * Based on the validated template from experiments/16-merge-prompt-spike/create-prompt.md
 */
export function buildCreatePrompt(fragments: KnowledgeFragment[]): string {
  const rendered = renderFragmentsForPrompt(fragments);

  return `You are a knowledge base editor. Your job is to create a new topic page from a set of knowledge fragments.

## Input

You will receive one or more knowledge fragments. Each fragment has:
- A title
- A source session ID
- Topics/tags
- Body text with technical details

## Output

Produce a single Markdown document with this EXACT structure:

---
title: <Topic Title>
created: <earliest fragment date or today, YYYY-MM-DD>
updated: <latest fragment date or today, YYYY-MM-DD>
confidence: <high|medium|low>
sources:
  - <session-id-1>
  - <session-id-2>
summary: <One sentence summarizing the topic>
---

## Overview

<2-4 sentence paragraph synthesizing what this topic is about, based on all fragments>

## Key Decisions

- <Decision or fact> (source: <session-id>)
- <Decision or fact> (source: <session-id>)

## Rules

1. **YAML frontmatter is required.** It must be valid YAML between \`---\` fences.
2. **Confidence levels:**
   - \`high\` — 3 or more sessions corroborate the information
   - \`medium\` — 1-2 sessions provide information
   - \`low\` — single session or contradictions exist
3. **Every claim in Key Decisions must cite its source session** using the exact format \`(source: session-id)\`.
4. **The sources array** in frontmatter must list every unique session ID from the input fragments.
5. **The summary** is one sentence, plain text, no markdown.
6. **Stay under ${SIZE_LIMIT} characters** total (including frontmatter).
7. **Use only the two sections:** \`## Overview\` and \`## Key Decisions\`. No other headings.
8. **Do not invent information.** Every claim must come from the input fragments.
9. **Output only the Markdown document.** No explanations, no commentary, no code fences wrapping the output.

## Fragments

${rendered}`;
}

/**
 * Build prompt for merging new fragments into an existing topic page.
 * Based on the validated template from experiments/16-merge-prompt-spike/merge-prompt.md
 */
export function buildMergePrompt(existingPage: string, fragments: KnowledgeFragment[]): string {
  const rendered = renderFragmentsForPrompt(fragments);

  return `You are a knowledge base editor. Your job is to merge new knowledge fragments into an existing topic page.

## Input

You will receive:
1. An existing topic page (Markdown with YAML frontmatter)
2. One or more new knowledge fragments to integrate

## Output

Produce an updated version of the topic page with the new information integrated. The output must follow this EXACT structure:

---
title: <Same or refined title>
created: <keep original created date>
updated: <latest date among all sources, YYYY-MM-DD>
confidence: <high|medium|low>
sources:
  - <all session IDs, both existing and new>
summary: <Updated one-sentence summary>
---

## Overview

<Updated 2-4 sentence paragraph incorporating new information>

## Key Decisions

- <Decision or fact> (source: <session-id>)

## Rules

1. **Preserve existing content.** Do not remove decisions or facts from the original page unless condensing for space.
2. **Integrate, don't append.** New information should be woven into the existing structure logically, not dumped at the end.
3. **Handle contradictions explicitly.** If new information contradicts existing content:
   - Keep BOTH versions with dates
   - Format as: \`Originally <old claim> (as of <date>, source: <old-session>). Updated: <new claim> (as of <date>, source: <new-session>).\`
   - NEVER silently replace contradicted information
4. **Every claim in Key Decisions must cite its source session** using the exact format \`(source: session-id)\`.
5. **Update the frontmatter:**
   - \`updated\` — set to the latest date among all sources
   - \`sources\` — add all new session IDs to the list
   - \`confidence\` — recalculate: high (3+ sessions), medium (1-2 sessions), low (contradictions or single session)
   - \`summary\` — revise if the topic scope has changed
6. **Size limit: ${SIZE_LIMIT} characters.** If the merged page would exceed this limit, condense older or lower-value content to make room. Prefer condensing verbose explanations over removing decisions.
7. **Idempotency.** If a fragment's information is already present in the page (same fact, same source), do not duplicate it. Skip it silently.
8. **Use only the two sections:** \`## Overview\` and \`## Key Decisions\`. No other headings.
9. **Do not invent information.** Every claim must come from either the existing page or the input fragments.
10. **Output only the Markdown document.** No explanations, no commentary, no code fences wrapping the output.

## Existing Page

${existingPage}

## New Fragments

${rendered}`;
}

// --- Index generation ---

interface TopicPageMeta {
  readonly slug: string;
  readonly title: string;
  readonly confidence: string;
  readonly updated: string;
  readonly summary: string;
}

/** Parse frontmatter from a topic page to extract index metadata. */
function parseTopicMeta(slug: string, content: string): TopicPageMeta | null {
  const result = parseFrontmatter(content);
  if (!result) return null;

  const fm = result.frontmatter;
  return {
    slug,
    title: String(fm.title ?? slug),
    confidence: String(fm.confidence ?? "low"),
    updated: String(fm.updated ?? ""),
    summary: String(fm.summary ?? ""),
  };
}

/**
 * Rebuild _index.md deterministically from topic page frontmatter.
 * No LLM call — reads all topic pages and generates the index table.
 */
export async function rebuildIndex(knowledgeDir: string): Promise<void> {
  const entries = await readdir(knowledgeDir).catch(() => [] as string[]);
  const topicFiles = entries.filter(
    (f) => f.endsWith(".md") && f !== "_index.md" && f !== "log.md",
  );

  const metas: TopicPageMeta[] = [];
  for (const file of topicFiles) {
    const content = await Bun.file(join(knowledgeDir, file)).text();
    const slug = file.replace(/\.md$/, "");
    const meta = parseTopicMeta(slug, content);
    if (meta) metas.push(meta);
  }

  // Sort by updated date descending (most recent first)
  metas.sort((a, b) => b.updated.localeCompare(a.updated));

  const now = new Date().toISOString().split("T")[0];
  const header = `# Knowledge Index\n\nLast compiled: ${now}\n`;
  const tableHeader =
    "| Topic | Confidence | Updated | Summary |\n| ----- | ---------- | ------- | ------- |";

  const rows = metas.map(
    (m) =>
      `| [${m.title}](${join(knowledgeDir, `${m.slug}.md`)}) | ${m.confidence} | ${m.updated} | ${m.summary} |`,
  );

  const content = `${header}\n${tableHeader}\n${rows.join("\n")}\n`;

  const indexPath = join(knowledgeDir, "_index.md");
  const tmpPath = join(knowledgeDir, `._index.md.tmp.${process.pid}`);
  await Bun.write(tmpPath, content);
  await rename(tmpPath, indexPath);
}

// --- Compilation log ---

export interface LogEntry {
  readonly sessionCount: number;
  readonly topicsCreated: string[];
  readonly topicsUpdated: string[];
}

const LOG_FILE = "log.md";
const LOG_HEADER = "# Knowledge Compilation Log\n";

/**
 * Append an entry to the compilation log.
 * Creates the log file with header if it doesn't exist.
 */
export async function appendToLog(knowledgeDir: string, entry: LogEntry): Promise<void> {
  const logPath = join(knowledgeDir, LOG_FILE);
  const file = Bun.file(logPath);

  let existing = "";
  if (await file.exists()) {
    existing = await file.text();
  } else {
    existing = LOG_HEADER;
  }

  const date = new Date().toISOString().split("T")[0];
  const sessionWord = entry.sessionCount === 1 ? "session" : "sessions";
  const parts: string[] = [];
  if (entry.topicsCreated.length > 0) {
    parts.push(
      `${entry.topicsCreated.length} new topic${entry.topicsCreated.length > 1 ? "s" : ""}`,
    );
  }
  if (entry.topicsUpdated.length > 0) {
    parts.push(`${entry.topicsUpdated.length} updated`);
  }
  const allTopics = [...entry.topicsCreated, ...entry.topicsUpdated];
  const topicsStr = allTopics.length > 0 ? ` (${allTopics.join(", ")})` : "";
  const detail = parts.length > 0 ? parts.join(", ") : "no changes";

  const logLine = `\n## [${date}] compile | ${entry.sessionCount} ${sessionWord} → ${detail}${topicsStr}\n`;

  await Bun.write(logPath, existing + logLine);
}

// --- Manifest writing ---

/**
 * Write manifest atomically (tmp + rename).
 * Only called after all topic pages are written successfully.
 */
export async function writeManifest(
  knowledgeDir: string,
  manifest: KnowledgeManifest,
): Promise<void> {
  const targetPath = join(knowledgeDir, MANIFEST_FILE);
  const tmpPath = join(knowledgeDir, `.${MANIFEST_FILE}.tmp.${process.pid}`);
  await Bun.write(tmpPath, JSON.stringify(manifest, null, 2));
  await rename(tmpPath, targetPath);
}

// --- Locking ---

const LOCK_POLL_MS = 500;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Directory-based lock for knowledge compilation. Returns null on timeout. */
async function withKnowledgeLock<T>(knowledgeDir: string, fn: () => Promise<T>): Promise<T | null> {
  const lockDir = join(knowledgeDir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch {
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_TIMEOUT_MS) {
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

// --- Compilation result ---

export interface CompilationResult {
  readonly sessionsProcessed: number;
  readonly topicsCreated: string[];
  readonly topicsUpdated: string[];
}

// --- Strip code fences from LLM output ---

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```\w*\n/, "")
    .replace(/\n```$/, "");
}

// --- Main orchestrator ---

/**
 * Compile knowledge from session summaries into topic pages.
 *
 * This is the main entry point for the knowledge compilation pipeline.
 * Uses directory-based locking to prevent concurrent compilations.
 *
 * @param memoryDir - The memory directory (e.g., ~/.shaka/memory)
 * @param cwd - The current working directory of the project
 * @param inferFn - System boundary: takes a prompt, returns LLM output
 */
export async function compileKnowledge(
  memoryDir: string,
  cwd: string,
  inferFn: (prompt: string) => Promise<string>,
): Promise<CompilationResult> {
  const empty: CompilationResult = { sessionsProcessed: 0, topicsCreated: [], topicsUpdated: [] };

  const knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));
  await mkdir(knowledgeDir, { recursive: true });

  const result = await withKnowledgeLock(knowledgeDir, async () => {
    const manifest = await readManifest(knowledgeDir);
    const sessionsDir = join(memoryDir, "sessions");

    const matchingSessions = await findMatchingSessions(sessionsDir, cwd);
    const unprocessed = findUnprocessedSessions(manifest, matchingSessions);
    if (unprocessed.length === 0) return empty;

    const allFragments = extractAllFragments(unprocessed);

    if (allFragments.length === 0) {
      await updateManifest(knowledgeDir, manifest, unprocessed);
      return { sessionsProcessed: unprocessed.length, topicsCreated: [], topicsUpdated: [] };
    }

    const existingSlugs = await readExistingTopicTitles(knowledgeDir);
    const groups = groupFragmentsByTopic(allFragments, existingSlugs);
    const { topicsCreated, topicsUpdated } = await writeTopicPages(knowledgeDir, groups, inferFn);

    await rebuildIndex(knowledgeDir);
    await appendToLog(knowledgeDir, {
      sessionCount: unprocessed.length,
      topicsCreated,
      topicsUpdated,
    });
    await updateManifest(knowledgeDir, manifest, unprocessed);

    return { sessionsProcessed: unprocessed.length, topicsCreated, topicsUpdated };
  });

  return result ?? empty;
}

async function findMatchingSessions(sessionsDir: string, cwd: string): Promise<SessionEntry[]> {
  let sessionFiles: string[];
  try {
    const allFiles = await readdir(sessionsDir);
    sessionFiles = allFiles.filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const matching: SessionEntry[] = [];
  for (const file of sessionFiles) {
    const content = await Bun.file(join(sessionsDir, file)).text();
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;
    const sessionCwd = String(parsed.frontmatter.cwd ?? "");
    if (!sessionCwd) continue;
    if (!isPathRelated(sessionCwd, cwd) && !isPathRelated(cwd, sessionCwd)) continue;
    matching.push({ filename: file, contentHash: hashContent(content), content });
  }
  return matching;
}

function extractAllFragments(sessions: SessionEntry[]): KnowledgeFragment[] {
  const fragments: KnowledgeFragment[] = [];
  for (const session of sessions) {
    fragments.push(...extractFragmentsFromSummary(session.content, session.filename));
  }
  return fragments;
}

async function writeTopicPages(
  knowledgeDir: string,
  groups: Map<string, KnowledgeFragment[]>,
  inferFn: (prompt: string) => Promise<string>,
): Promise<{ topicsCreated: string[]; topicsUpdated: string[] }> {
  const topicsCreated: string[] = [];
  const topicsUpdated: string[] = [];

  for (const [slug, fragments] of groups) {
    const topicPath = join(knowledgeDir, `${slug}.md`);
    const topicFile = Bun.file(topicPath);
    const exists = await topicFile.exists();

    const prompt = exists
      ? buildMergePrompt(await topicFile.text(), fragments)
      : buildCreatePrompt(fragments);

    const rawOutput = await inferFn(prompt);
    if (!rawOutput) continue;

    const tmpPath = join(knowledgeDir, `.${slug}.md.tmp.${process.pid}`);
    await Bun.write(tmpPath, stripCodeFences(rawOutput));
    await rename(tmpPath, topicPath);

    (exists ? topicsUpdated : topicsCreated).push(slug);
  }

  return { topicsCreated, topicsUpdated };
}

async function updateManifest(
  knowledgeDir: string,
  manifest: KnowledgeManifest,
  processed: SessionEntry[],
): Promise<void> {
  const updatedSources = { ...manifest.compiledSources };
  for (const s of processed) {
    updatedSources[s.filename] = s.contentHash;
  }
  await writeManifest(knowledgeDir, {
    compiledSources: updatedSources,
    lastCompilation: new Date().toISOString(),
  });
}

// --- Session-start injection ---

/**
 * Load the knowledge index for context injection at session start.
 * Returns the _index.md content with a header, or empty string if none available.
 *
 * The index contains one-line summaries and absolute file paths for each topic.
 * The LLM can read individual topic pages on demand if it needs deeper context.
 */
export async function loadKnowledgeIndex(memoryDir: string, cwd: string): Promise<string> {
  const knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));
  const indexPath = join(knowledgeDir, "_index.md");
  const file = Bun.file(indexPath);

  if (!(await file.exists())) return "";

  const content = await file.text();
  if (!content.trim()) return "";

  return `## Project Knowledge Base\n\nThe following topics have been compiled from past sessions.\nRead individual topic pages when you need deeper context.\n\n${content}`;
}

// --- Bootstrap types ---

export interface BootstrapOptions {
  readonly batchSize?: number; // default 5
  readonly limit?: number; // max sessions to process (for testing)
  readonly dryRun?: boolean; // just count, don't process
  readonly onProgress?: (batch: number, total: number, sessionCount: number) => void;
}

export interface BootstrapResult {
  readonly sessionsFound: number; // sessions without ## Knowledge
  readonly sessionsProcessed: number; // actually processed
  readonly fragmentsExtracted: number; // total fragments across all sessions
  readonly batchesRun: number;
  readonly topicsCreated: string[]; // from subsequent compilation
  readonly topicsUpdated: string[]; // from subsequent compilation
}

// --- Bootstrap: retroactive knowledge extraction ---

/**
 * Build the batch extraction prompt for bootstrapping knowledge from historical sessions.
 * Sends multiple session bodies in one LLM call.
 */
function buildBootstrapExtractionPrompt(
  sessions: Array<{ filename: string; body: string }>,
  existingTopicTitles: string[],
): string {
  const topicsBlock =
    existingTopicTitles.length > 0
      ? `Existing knowledge topics: ${existingTopicTitles.join(", ")}. Reuse these as Tags when related.`
      : "No existing knowledge topics yet. Use descriptive, lowercase tags.";

  const sessionBlocks = sessions
    .map((s, i) => `SESSION ${i + 1}: ${s.filename}\n${s.body}`)
    .join("\n\n---\n\n");

  return `You are extracting domain knowledge from existing session summaries.

For each session below, extract 0-3 knowledge fragments that describe:
- How something works (architecture, system design)
- Why a decision was made (rationale, tradeoffs evaluated)
- What was discovered (root causes, non-obvious findings)

Extraction criteria:
- SUBSTANTIVE: Describes how/why/what, not just what happened
- DURABLE: Will still be true in a month
- NON-OBVIOUS: Not derivable from reading the code

Do NOT extract:
- Code-derivable facts
- Ephemeral state
- Git-derivable history
- Behavioral nudges (those belong in Learnings)
- General language/framework facts any experienced developer would know — only PROJECT-SPECIFIC knowledge
- Implementation details too narrow to help with future work

${topicsBlock}

For each session, output:

SESSION: {filename}
### {Fragment Title}

{Body 1-5 sentences}
Topics: tag1, tag2

SESSION: {filename}
(no knowledge)

---

${sessionBlocks}`;
}

/**
 * Parse the bootstrap extraction output into per-session fragments.
 * Output format: SESSION: {filename}\n### Title\nBody\nTopics: ...
 * Returns a map of filename -> knowledge section text.
 */
function parseBootstrapExtractionOutput(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  // Split on SESSION: markers
  const parts = raw.split(/^SESSION:\s*/m).filter((p) => p.trim());

  for (const part of parts) {
    const lines = part.split("\n");
    const filenameLine = lines[0]?.trim() ?? "";
    // The filename is the first line (before any content)
    const filename = filenameLine.replace(/\s*$/, "");
    if (!filename || filename === "(end)") continue;

    const body = lines.slice(1).join("\n").trim();
    // Skip "(no knowledge)" entries
    if (body === "(no knowledge)" || !body) continue;

    // Check if there are actual fragments (### headings)
    if (!body.includes("### ")) continue;

    // Accumulate fragments — the LLM may emit multiple SESSION blocks for the same file
    const existing = result.get(filename);
    if (existing) {
      result.set(filename, `${existing}\n\n${body}`);
    } else {
      result.set(filename, `## Knowledge\n\n${body}`);
    }
  }

  return result;
}

/**
 * Retroactively extract knowledge from historical sessions that lack ## Knowledge sections.
 *
 * 1. Lists sessions matching the CWD
 * 2. Filters to sessions without ## Knowledge
 * 3. Batches them for LLM extraction
 * 4. Writes ## Knowledge back to each session file
 * 5. Runs compileKnowledge to produce topic pages
 */
export async function bootstrapKnowledge(
  memoryDir: string,
  cwd: string,
  inferFn: (prompt: string) => Promise<string>,
  options?: BootstrapOptions,
): Promise<BootstrapResult> {
  const batchSize = options?.batchSize ?? 5;
  const limit = options?.limit;
  const dryRun = options?.dryRun ?? false;

  if (batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  const sessionsDir = join(memoryDir, "sessions");
  const knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));

  // Step 1: Find sessions matching CWD without ## Knowledge
  const candidates = await findSessionsWithoutKnowledge(sessionsDir, cwd);

  // Apply limit (undefined = no limit, 0 = process nothing)
  const sessionsToProcess = limit !== undefined ? candidates.slice(0, limit) : candidates;

  const emptyResult: BootstrapResult = {
    sessionsFound: candidates.length,
    sessionsProcessed: 0,
    fragmentsExtracted: 0,
    batchesRun: 0,
    topicsCreated: [],
    topicsUpdated: [],
  };

  if (sessionsToProcess.length === 0 || dryRun) {
    return { ...emptyResult, sessionsFound: candidates.length };
  }

  // Step 2: Get existing topic titles for tag convergence
  await mkdir(knowledgeDir, { recursive: true });
  const existingTopicTitles = await readExistingTopicTitles(knowledgeDir);

  // Step 3: Batch and extract
  let totalFragments = 0;
  let batchesRun = 0;
  const totalBatches = Math.ceil(sessionsToProcess.length / batchSize);

  for (let i = 0; i < sessionsToProcess.length; i += batchSize) {
    const batch = sessionsToProcess.slice(i, i + batchSize);
    batchesRun++;

    if (options?.onProgress) {
      options.onProgress(batchesRun, totalBatches, batch.length);
    }

    // Build prompt with session bodies
    const sessionInputs = batch.map((s) => ({
      filename: s.filename,
      body: s.content,
    }));

    const prompt = buildBootstrapExtractionPrompt(sessionInputs, existingTopicTitles);
    const output = await inferFn(prompt);

    // Parse output into per-session knowledge sections
    const knowledgeMap = parseBootstrapExtractionOutput(output);

    // Write back to each session file
    for (const session of batch) {
      const knowledgeSection = knowledgeMap.get(session.filename);
      if (!knowledgeSection) continue;

      // Count fragments in this section
      const fragmentCount = (knowledgeSection.match(/^### /gm) ?? []).length;
      totalFragments += fragmentCount;

      // Append to session file atomically
      const sessionPath = join(sessionsDir, session.filename);
      const existingContent = await Bun.file(sessionPath).text();
      const updatedContent = `${existingContent.trimEnd()}\n\n${knowledgeSection}\n`;

      const tmpPath = join(sessionsDir, `.${session.filename}.tmp.${process.pid}`);
      await Bun.write(tmpPath, updatedContent);
      await rename(tmpPath, sessionPath);
    }
  }

  // Step 4: Run compilation to produce topic pages
  const compilationResult = await compileKnowledge(memoryDir, cwd, inferFn);

  return {
    sessionsFound: candidates.length,
    sessionsProcessed: sessionsToProcess.length,
    fragmentsExtracted: totalFragments,
    batchesRun,
    topicsCreated: compilationResult.topicsCreated,
    topicsUpdated: compilationResult.topicsUpdated,
  };
}

/** Find sessions matching CWD that do NOT have a ## Knowledge section. */
async function findSessionsWithoutKnowledge(
  sessionsDir: string,
  cwd: string,
): Promise<Array<{ filename: string; content: string }>> {
  let sessionFiles: string[];
  try {
    const allFiles = await readdir(sessionsDir);
    sessionFiles = allFiles.filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const results: Array<{ filename: string; content: string }> = [];

  for (const file of sessionFiles) {
    const content = await Bun.file(join(sessionsDir, file)).text();
    const parsed = parseFrontmatter(content);
    if (!parsed) continue;

    // CWD matching
    const sessionCwd = String(parsed.frontmatter.cwd ?? "");
    if (!sessionCwd) continue;
    if (!isPathRelated(sessionCwd, cwd) && !isPathRelated(cwd, sessionCwd)) continue;

    // Skip sessions that already have ## Knowledge
    if (/^## Knowledge\s*$/m.test(content)) continue;

    results.push({ filename: file, content });
  }

  return results;
}
