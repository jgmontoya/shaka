/**
 * Read-only inspection of compiled project knowledge.
 *
 * This module is the single source of truth for integrity diagnostics and
 * source provenance. It never repairs or mutates the knowledge store.
 */

import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../domain/frontmatter";
import { resolveKnowledgeProjectDir } from "./knowledge";
import { hashContent } from "./utils";

export type KnowledgeDiagnosticSeverity = "error" | "warning";
export type KnowledgeDiagnosticCode =
  | "unreadable-knowledge-directory"
  | "malformed-topic-page"
  | "invalid-project-metadata"
  | "invalid-manifest"
  | "temporary-file"
  | "duplicate-topic-slug"
  | "missing-index"
  | "malformed-index"
  | "invalid-index-target"
  | "missing-indexed-topic"
  | "unindexed-topic"
  | "index-metadata-mismatch"
  | "invalid-source-session"
  | "missing-source-session"
  | "unmanifested-topic-source"
  | "unlisted-decision-source";

export interface KnowledgeDiagnostic {
  readonly code: KnowledgeDiagnosticCode;
  readonly severity: KnowledgeDiagnosticSeverity;
  readonly filePath: string;
  readonly message: string;
}

export interface KnowledgeDecision {
  readonly text: string;
  readonly sourceSession: string;
}

export interface InspectedKnowledgeTopic {
  readonly filePath: string;
  readonly slug: string;
  readonly title: string;
  readonly confidence: string;
  readonly updated: string;
  readonly summary: string;
  readonly sources: string[];
  readonly decisions: KnowledgeDecision[];
  readonly decisionSources: string[];
}

export interface KnowledgeInspection {
  readonly knowledgeDir: string;
  readonly projectCwd: string | null;
  readonly topics: InspectedKnowledgeTopic[];
  readonly diagnostics: KnowledgeDiagnostic[];
  readonly complete: boolean;
}

export interface KnowledgeSourceImpactTopic {
  readonly filePath: string;
  readonly title: string;
  readonly referencedInFrontmatter: boolean;
  readonly decisions: string[];
}

export interface KnowledgeSourceImpact {
  readonly sourceSession: string;
  readonly topics: KnowledgeSourceImpactTopic[];
  readonly complete: boolean;
}

interface InspectionState {
  readonly diagnostics: KnowledgeDiagnostic[];
  complete: boolean;
}

interface IndexedTopic {
  readonly filePath: string;
  readonly line: string;
}

function reportError(
  state: InspectionState,
  code: KnowledgeDiagnosticCode,
  filePath: string,
  message: string,
  incomplete = false,
): void {
  state.diagnostics.push({ code, severity: "error", filePath, message });
  if (incomplete) state.complete = false;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await Bun.file(filePath).json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidTopicFrontmatter(frontmatter: Record<string, unknown>): boolean {
  const confidence = frontmatter.confidence;
  const sources = frontmatter.sources;
  return (
    isNonEmptyString(frontmatter.title) &&
    isNonEmptyString(frontmatter.created) &&
    isNonEmptyString(frontmatter.updated) &&
    (confidence === "high" || confidence === "medium" || confidence === "low") &&
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every(isNonEmptyString) &&
    isNonEmptyString(frontmatter.summary)
  );
}

function extractDecisions(body: string): KnowledgeDecision[] {
  const section = body.split(/^## Key Decisions\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return section.split("\n").flatMap((line): KnowledgeDecision[] => {
    const bullet = line.match(/^\s*-\s+(.+)$/)?.[1];
    if (!bullet) return [];
    const text = bullet.replace(/\s+\(source:\s*[^)]+\)\s*$/, "");
    return [...bullet.matchAll(/\bsource:\s*([^),]+)/g)].map((match) => ({
      text,
      sourceSession: match[1]?.trim() ?? "",
    }));
  });
}

function parseTopic(
  filePath: string,
  filename: string,
  content: string,
): InspectedKnowledgeTopic | null {
  const parsed = parseFrontmatter(content);
  if (!parsed || !hasValidTopicFrontmatter(parsed.frontmatter)) return null;
  const decisions = extractDecisions(parsed.body);
  const sources = parsed.frontmatter.sources as string[];
  return {
    filePath,
    slug: filename.slice(0, -3),
    title: parsed.frontmatter.title as string,
    confidence: parsed.frontmatter.confidence as string,
    updated: parsed.frontmatter.updated as string,
    summary: parsed.frontmatter.summary as string,
    sources,
    decisions,
    decisionSources: [...new Set(decisions.map((decision) => decision.sourceSession))],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readKnowledgeEntries(
  knowledgeDir: string,
  state: InspectionState,
): Promise<string[]> {
  try {
    return (await readdir(knowledgeDir)).sort();
  } catch (error) {
    if (isMissingFileError(error)) return [];
    reportError(
      state,
      "unreadable-knowledge-directory",
      knowledgeDir,
      "Knowledge directory could not be read.",
      true,
    );
    return [];
  }
}

async function inspectProjectMetadata(
  knowledgeDir: string,
  state: InspectionState,
): Promise<string | null> {
  const metadataPath = join(knowledgeDir, ".project.json");
  const metadata = await readJsonObject(metadataPath);
  if (isNonEmptyString(metadata?.cwd)) return metadata.cwd;
  reportError(
    state,
    "invalid-project-metadata",
    metadataPath,
    "Project metadata must contain a non-empty cwd string.",
    true,
  );
  return null;
}

async function inspectManifest(
  knowledgeDir: string,
  state: InspectionState,
): Promise<Record<string, string> | null> {
  const manifestPath = join(knowledgeDir, ".manifest.json");
  const manifest = await readJsonObject(manifestPath);
  const valid =
    manifest !== null &&
    isStringRecord(manifest.compiledSources) &&
    typeof manifest.lastCompilation === "string" &&
    !Number.isNaN(Date.parse(manifest.lastCompilation));
  if (valid) return manifest.compiledSources as Record<string, string>;
  reportError(
    state,
    "invalid-manifest",
    manifestPath,
    "Manifest must contain compiledSources and lastCompilation fields.",
    true,
  );
  return null;
}

function isSafeSessionFilename(filename: string): boolean {
  return filename.endsWith(".md") && filename.length > 3 && !/[\\/]/.test(filename);
}

async function inspectManifestSource(
  memoryDir: string,
  manifestPath: string,
  filename: string,
  expectedHash: string,
  state: InspectionState,
): Promise<void> {
  if (!isSafeSessionFilename(filename) || !expectedHash) {
    reportError(
      state,
      "invalid-manifest",
      manifestPath,
      `Manifest contains an invalid source entry: ${filename || "<empty>"}.`,
      true,
    );
    return;
  }

  const sourceContent = await Bun.file(join(memoryDir, "sessions", filename))
    .text()
    .catch(() => null);
  if (sourceContent === null) {
    reportError(
      state,
      "invalid-manifest",
      manifestPath,
      `Manifest source cannot be read: ${filename}.`,
      true,
    );
  } else if (hashContent(sourceContent) !== expectedHash) {
    reportError(
      state,
      "invalid-manifest",
      manifestPath,
      `Manifest hash does not match session source: ${filename}.`,
    );
  }
}

async function inspectManifestSources(
  memoryDir: string,
  knowledgeDir: string,
  compiledSources: Record<string, string> | null,
  state: InspectionState,
): Promise<void> {
  if (!compiledSources) return;
  const manifestPath = join(knowledgeDir, ".manifest.json");
  for (const [filename, expectedHash] of Object.entries(compiledSources)) {
    await inspectManifestSource(memoryDir, manifestPath, filename, expectedHash, state);
  }
}

function inspectTemporaryFiles(
  entries: string[],
  knowledgeDir: string,
  state: InspectionState,
): void {
  for (const entry of entries.filter((name) => name.includes(".tmp."))) {
    reportError(
      state,
      "temporary-file",
      join(knowledgeDir, entry),
      "Temporary compilation file was not cleaned up.",
    );
  }
}

function inspectDecisionSources(topic: InspectedKnowledgeTopic, state: InspectionState): void {
  for (const sourceSession of topic.decisionSources) {
    if (topic.sources.includes(sourceSession)) continue;
    reportError(
      state,
      "unlisted-decision-source",
      topic.filePath,
      `Decision cites ${sourceSession}, which is absent from topic frontmatter sources.`,
    );
  }
}

function isSafeSessionId(sourceSession: string): boolean {
  return (
    sourceSession.length > 0 &&
    sourceSession !== "." &&
    sourceSession !== ".." &&
    !/[\\/]/.test(sourceSession)
  );
}

async function inspectTopicSource(
  memoryDir: string,
  topic: InspectedKnowledgeTopic,
  sourceSession: string,
  state: InspectionState,
): Promise<void> {
  if (!isSafeSessionId(sourceSession)) {
    reportError(
      state,
      "invalid-source-session",
      topic.filePath,
      `Invalid source session identifier: ${sourceSession || "<empty>"}.`,
      true,
    );
    return;
  }

  const sourcePath = join(memoryDir, "sessions", `${sourceSession}.md`);
  if (await Bun.file(sourcePath).exists()) return;
  reportError(
    state,
    "missing-source-session",
    sourcePath,
    `Topic ${basename(topic.filePath)} references a session summary that does not exist.`,
    true,
  );
}

function inspectManifestMembership(
  topic: InspectedKnowledgeTopic,
  compiledSources: Record<string, string> | null,
  state: InspectionState,
): void {
  if (!compiledSources) return;
  for (const sourceSession of topic.sources) {
    if (`${sourceSession}.md` in compiledSources) continue;
    reportError(
      state,
      "unmanifested-topic-source",
      topic.filePath,
      `Topic source is absent from the compilation manifest: ${sourceSession}.`,
    );
  }
}

async function inspectTopicFile(
  memoryDir: string,
  knowledgeDir: string,
  filename: string,
  compiledSources: Record<string, string> | null,
  state: InspectionState,
): Promise<InspectedKnowledgeTopic | null> {
  const filePath = join(knowledgeDir, filename);
  const content = await Bun.file(filePath)
    .text()
    .catch(() => null);
  const topic = content === null ? null : parseTopic(filePath, filename, content);
  if (!topic) {
    reportError(
      state,
      "malformed-topic-page",
      filePath,
      "Topic page does not match the compiled knowledge schema.",
      true,
    );
    return null;
  }

  inspectDecisionSources(topic, state);
  for (const sourceSession of topic.sources) {
    await inspectTopicSource(memoryDir, topic, sourceSession, state);
  }
  inspectManifestMembership(topic, compiledSources, state);
  return topic;
}

function isTopicFilename(filename: string): boolean {
  return filename.endsWith(".md") && filename !== "_index.md" && filename !== "log.md";
}

async function inspectTopics(
  memoryDir: string,
  knowledgeDir: string,
  entries: string[],
  compiledSources: Record<string, string> | null,
  state: InspectionState,
): Promise<InspectedKnowledgeTopic[]> {
  const topics: InspectedKnowledgeTopic[] = [];
  for (const filename of entries.filter(isTopicFilename)) {
    const topic = await inspectTopicFile(memoryDir, knowledgeDir, filename, compiledSources, state);
    if (topic) topics.push(topic);
  }
  return topics.sort((a, b) => a.slug.localeCompare(b.slug));
}

function inspectDuplicateSlugs(topics: InspectedKnowledgeTopic[], state: InspectionState): void {
  const firstPathBySlug = new Map<string, string>();
  for (const topic of topics) {
    const normalizedSlug = topic.slug.normalize("NFC").toLocaleLowerCase();
    const firstPath = firstPathBySlug.get(normalizedSlug);
    if (firstPath) {
      reportError(
        state,
        "duplicate-topic-slug",
        topic.filePath,
        `Topic slug duplicates ${firstPath}.`,
      );
    } else {
      firstPathBySlug.set(normalizedSlug, topic.filePath);
    }
  }
}

function parseIndexRows(content: string): { rows: IndexedTopic[]; malformed: boolean } {
  const rows: IndexedTopic[] = [];
  let malformed = false;
  for (const line of content.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| Topic") || line.startsWith("| -----")) {
      continue;
    }
    const filePath = line.match(/^\| \[.*\]\((.*\.md)\) \| .* \| .* \| .* \|$/)?.[1];
    if (filePath) rows.push({ filePath, line });
    else malformed = true;
  }
  return { rows, malformed };
}

function renderIndexRow(topic: InspectedKnowledgeTopic): string {
  return `| [${topic.title}](${topic.filePath}) | ${topic.confidence} | ${topic.updated} | ${topic.summary} |`;
}

function inspectIndexRow(
  indexed: IndexedTopic,
  indexPath: string,
  knowledgeDir: string,
  topicsByPath: ReadonlyMap<string, InspectedKnowledgeTopic>,
  state: InspectionState,
): string | null {
  const indexedPath = resolve(indexed.filePath);
  if (dirname(indexedPath) !== resolve(knowledgeDir)) {
    reportError(
      state,
      "invalid-index-target",
      indexPath,
      `Index target is outside the knowledge directory: ${indexed.filePath}`,
    );
    return null;
  }

  const topic = topicsByPath.get(indexedPath);
  if (!topic) {
    reportError(
      state,
      "missing-indexed-topic",
      indexedPath,
      "Knowledge index references a topic page that does not exist or is invalid.",
    );
  } else if (indexed.line !== renderIndexRow(topic)) {
    reportError(
      state,
      "index-metadata-mismatch",
      topic.filePath,
      "Knowledge index metadata does not match the topic page.",
    );
  }
  return indexedPath;
}

function inspectParsedIndex(
  content: string,
  indexPath: string,
  knowledgeDir: string,
  topics: InspectedKnowledgeTopic[],
  state: InspectionState,
): void {
  const parsedIndex = parseIndexRows(content);
  if (parsedIndex.malformed) {
    reportError(
      state,
      "malformed-index",
      indexPath,
      "Knowledge index contains an invalid topic row.",
      true,
    );
  }

  const topicsByPath = new Map(topics.map((topic) => [resolve(topic.filePath), topic]));
  const indexedPaths = new Set<string>();
  for (const indexed of parsedIndex.rows) {
    const indexedPath = inspectIndexRow(indexed, indexPath, knowledgeDir, topicsByPath, state);
    if (indexedPath) indexedPaths.add(indexedPath);
  }
  for (const topic of topics) {
    if (indexedPaths.has(resolve(topic.filePath))) continue;
    reportError(
      state,
      "unindexed-topic",
      topic.filePath,
      "Valid topic page is missing from the knowledge index.",
    );
  }
}

async function inspectIndex(
  knowledgeDir: string,
  topics: InspectedKnowledgeTopic[],
  state: InspectionState,
): Promise<void> {
  const indexPath = join(knowledgeDir, "_index.md");
  const indexFile = Bun.file(indexPath);
  if (!(await indexFile.exists())) {
    if (topics.length > 0) {
      reportError(
        state,
        "missing-index",
        indexPath,
        "Knowledge topics exist but the generated index is missing.",
      );
    }
    return;
  }

  const content = await indexFile.text().catch(() => null);
  if (content === null) {
    reportError(state, "malformed-index", indexPath, "Knowledge index could not be read.", true);
    return;
  }
  inspectParsedIndex(content, indexPath, knowledgeDir, topics, state);
}

/** Inspect the compiled knowledge project associated with `cwd`. */
export async function inspectKnowledge(
  memoryDir: string,
  cwd: string,
): Promise<KnowledgeInspection> {
  const knowledgeDir = await resolveKnowledgeProjectDir(memoryDir, cwd);
  const state: InspectionState = { diagnostics: [], complete: true };
  const entries = await readKnowledgeEntries(knowledgeDir, state);
  const projectCwd = entries.length > 0 ? await inspectProjectMetadata(knowledgeDir, state) : null;
  const compiledSources = entries.length > 0 ? await inspectManifest(knowledgeDir, state) : null;

  await inspectManifestSources(memoryDir, knowledgeDir, compiledSources, state);
  inspectTemporaryFiles(entries, knowledgeDir, state);
  const topics = await inspectTopics(memoryDir, knowledgeDir, entries, compiledSources, state);
  inspectDuplicateSlugs(topics, state);
  await inspectIndex(knowledgeDir, topics, state);

  return {
    knowledgeDir,
    projectCwd,
    topics,
    diagnostics: state.diagnostics,
    complete: state.complete,
  };
}

/** Find every topic and explicit decision that refers to a session source. */
export function findKnowledgeSourceImpact(
  inspection: KnowledgeInspection,
  source: string,
): KnowledgeSourceImpact {
  const sourceSession = basename(source).replace(/\.md$/, "");
  const topics = inspection.topics.flatMap((topic): KnowledgeSourceImpactTopic[] => {
    const decisions = topic.decisions
      .filter((decision) => decision.sourceSession === sourceSession)
      .map((decision) => decision.text);
    const referencedInFrontmatter = topic.sources.includes(sourceSession);
    if (!referencedInFrontmatter && decisions.length === 0) return [];
    return [{ filePath: topic.filePath, title: topic.title, referencedInFrontmatter, decisions }];
  });

  return { sourceSession, topics, complete: inspection.complete };
}
