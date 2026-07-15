import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import memorySearchTool from "../../../defaults/system/tools/memory-search";
import { createMemoryCommand } from "../../../src/commands/memory/index";
import { findKnowledgeSourceImpact, inspectKnowledge } from "../../../src/memory/inspection";
import { loadKnowledgeIndex, rebuildIndex } from "../../../src/memory/knowledge";
import {
  type LearningCategory,
  type LearningEntry,
  appendToArchive,
  writeLearnings,
} from "../../../src/memory/learnings";
import { projectSlug } from "../../../src/memory/rollups";
import { type SearchFilter, type SearchResult, searchMemory } from "../../../src/memory/search";
import { writeSummary } from "../../../src/memory/storage";
import { hashContent } from "../../../src/memory/utils";

interface CorpusSession {
  readonly key: string;
  readonly date: string;
  readonly scope: "current" | "unrelated";
  readonly title: string;
  readonly body: string;
}

interface CorpusLearning {
  readonly title: string;
  readonly body: string;
  readonly category: LearningCategory;
  readonly date: string;
}

interface CorpusTopic {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly sourceKeys: string[];
  readonly decisions: Array<{ readonly text: string; readonly sourceKey: string }>;
}

interface SearchCase {
  readonly id: string;
  readonly query: string;
  readonly scope: "default" | "all";
  readonly type?: "session" | "learning" | "knowledge";
  readonly expectedResultCount: number;
  readonly requiredTitles: string[];
  readonly forbiddenTitles: string[];
  readonly expectedEvidence: Array<{ readonly title: string; readonly source: string }>;
  readonly requiredText: string[];
  readonly noMutation: boolean;
}

interface RetrievalCorpus {
  readonly version: number;
  readonly searchMaxResults: number;
  readonly sessions: CorpusSession[];
  readonly activeLearnings: CorpusLearning[];
  readonly archivedLearnings: CorpusLearning[];
  readonly knowledgeTopics: CorpusTopic[];
  readonly searchCases: SearchCase[];
  readonly contextCases: Array<{ readonly topicCount: number; readonly maxCharacters: number }>;
}

const corpusPath = join(import.meta.dir, "../../fixtures/memory-retrieval/corpus.json");

function asLearning(entry: CorpusLearning, cwd: string, key: string): LearningEntry {
  return {
    category: entry.category,
    cwds: [cwd],
    exposures: [{ date: entry.date, sessionHash: key }],
    nonglobal: false,
    title: entry.title,
    body: entry.body,
  };
}

async function hashDirectory(root: string): Promise<string> {
  const records: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
      } else if (entry.isFile()) {
        records.push(
          `${relative(root, filePath)}\0${hashContent(await Bun.file(filePath).text())}`,
        );
      }
    }
  }

  await walk(root);
  return hashContent(records.join("\n"));
}

function isInside(child: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function assertRequiredAndForbidden(
  rendered: string,
  searchCase: SearchCase,
  evidencePaths: ReadonlyMap<string, string>,
): void {
  for (const title of searchCase.requiredTitles) expect(rendered).toContain(title);
  for (const title of searchCase.forbiddenTitles) expect(rendered).not.toContain(title);
  for (const text of searchCase.requiredText) expect(rendered).toContain(text);
  for (const evidence of searchCase.expectedEvidence) {
    const evidencePath = evidencePaths.get(evidence.source) ?? "missing fixture evidence";
    expect(rendered.indexOf(evidence.title)).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf(evidencePath)).toBeGreaterThan(rendered.indexOf(evidence.title));
  }
}

function assertResultEvidence(
  results: SearchResult[],
  searchCase: SearchCase,
  evidencePaths: ReadonlyMap<string, string>,
): void {
  for (const evidence of searchCase.expectedEvidence) {
    const result = results.find((candidate) => candidate.title === evidence.title);
    expect(result?.filePath).toBe(evidencePaths.get(evidence.source));
  }
}

describe("memory retrieval corpus", () => {
  let previousShakaHome: string | undefined;
  let rootDir: string;
  let memoryDir: string;
  let corpus: RetrievalCorpus;
  let corpusIdentity: string;
  let evidencePaths: Map<string, string>;
  let sourceIds: Map<string, string>;
  const currentCwd = process.cwd();

  beforeEach(async () => {
    previousShakaHome = process.env.SHAKA_HOME;
    rootDir = await mkdtemp(join(tmpdir(), "shaka corpus búsqueda-"));
    memoryDir = join(rootDir, "memory");
    process.env.SHAKA_HOME = rootDir;

    const rawCorpus = await Bun.file(corpusPath).text();
    corpusIdentity = hashContent(rawCorpus);
    corpus = JSON.parse(rawCorpus) as RetrievalCorpus;
    evidencePaths = new Map();
    sourceIds = new Map();

    await Bun.write(
      join(rootDir, "config.json"),
      JSON.stringify({
        version: "test",
        reasoning: {},
        permissions: {},
        providers: {},
        assistant: {},
        principal: {},
        memory: { search_max_results: corpus.searchMaxResults },
      }),
    );

    for (const session of corpus.sessions) {
      const filePath = await writeSummary(memoryDir, {
        metadata: {
          date: session.date,
          cwd: session.scope === "current" ? currentCwd : "/fixtures/unrelated",
          provider: "codex",
          sessionId: `corpus-${session.key}`,
        },
        tags: ["corpus"],
        title: session.title,
        body: `## Summary\n${session.body}`,
      });
      evidencePaths.set(`session:${session.key}`, filePath);
      sourceIds.set(session.key, basename(filePath, ".md"));
    }

    await writeLearnings(
      memoryDir,
      corpus.activeLearnings.map((entry, index) =>
        asLearning(entry, currentCwd, `active-${index}`),
      ),
    );
    await appendToArchive(
      memoryDir,
      corpus.archivedLearnings.map((entry, index) =>
        asLearning(entry, currentCwd, `archive-${index}`),
      ),
    );
    evidencePaths.set("learning:active", join(memoryDir, "learnings.md"));
    evidencePaths.set("learning:archive", join(memoryDir, "learnings-archive.md"));

    const knowledgeDir = join(memoryDir, "knowledge", projectSlug(currentCwd));
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd: currentCwd }));

    for (const topic of corpus.knowledgeTopics) {
      const sources = topic.sourceKeys.map((key) => sourceIds.get(key) ?? key);
      const decisions = topic.decisions.map(
        (decision) =>
          `- ${decision.text} (source: ${sourceIds.get(decision.sourceKey) ?? decision.sourceKey})`,
      );
      const topicPath = join(knowledgeDir, `${topic.slug}.md`);
      await Bun.write(
        topicPath,
        `---
title: ${topic.title}
created: 2026-07-08
updated: 2026-07-15
confidence: medium
sources:
${sources.map((source) => `  - ${source}`).join("\n")}
summary: ${topic.summary}
---

## Overview

${topic.body}

## Key Decisions

${decisions.join("\n")}
`,
      );
      evidencePaths.set(`knowledge:${topic.slug}`, topicPath);
    }

    const compiledSources: Record<string, string> = {};
    for (const filePath of [...evidencePaths.entries()]
      .filter(([key]) => key.startsWith("session:"))
      .map(([, filePath]) => filePath)) {
      compiledSources[basename(filePath)] = hashContent(await Bun.file(filePath).text());
    }
    await Bun.write(
      join(knowledgeDir, ".manifest.json"),
      JSON.stringify({ compiledSources, lastCompilation: "2026-07-15T12:00:00.000Z" }),
    );
    await rebuildIndex(knowledgeDir);
  });

  afterEach(async () => {
    if (previousShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = previousShakaHome;
    await rm(rootDir, { recursive: true, force: true });
  });

  test("gates search behavior and evidence paths through the domain API", async () => {
    for (const searchCase of corpus.searchCases) {
      const beforeMemory = await hashDirectory(memoryDir);
      const filter: SearchFilter = {
        allProjects: searchCase.scope === "all",
        type: searchCase.type,
      };
      const results = await searchMemory(
        searchCase.query,
        memoryDir,
        filter,
        corpus.searchMaxResults,
      );

      expect(results).toHaveLength(searchCase.expectedResultCount);
      const rendered = results
        .map((result) => `${result.title}\n${result.filePath}\n${result.snippet}`)
        .join("\n");
      assertRequiredAndForbidden(rendered, searchCase, evidencePaths);
      assertResultEvidence(results, searchCase, evidencePaths);
      expect(results.every((result: SearchResult) => isInside(result.filePath, memoryDir))).toBe(
        true,
      );
      if (searchCase.noMutation) expect(await hashDirectory(memoryDir)).toBe(beforeMemory);
      expect(hashContent(await Bun.file(corpusPath).text())).toBe(corpusIdentity);
    }
  });

  test("gates the same corpus through CLI output", async () => {
    for (const searchCase of corpus.searchCases) {
      const beforeMemory = await hashDirectory(memoryDir);
      const args = ["search", searchCase.query];
      if (searchCase.scope === "all") args.push("--all");
      if (searchCase.type) args.push("--type", searchCase.type);

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => output.push(values.join(" "));
      try {
        await createMemoryCommand().parseAsync(args, { from: "user" });
      } finally {
        console.log = originalLog;
      }

      const rendered = output.join("\n");
      assertRequiredAndForbidden(rendered, searchCase, evidencePaths);
      if (searchCase.expectedResultCount === 0) {
        expect(rendered).toContain("No results");
      } else {
        expect(rendered).toContain(`Found ${searchCase.expectedResultCount} result`);
      }
      if (searchCase.noMutation) expect(await hashDirectory(memoryDir)).toBe(beforeMemory);
      expect(hashContent(await Bun.file(corpusPath).text())).toBe(corpusIdentity);
    }
  });

  test("gates the same corpus through MCP output", async () => {
    for (const searchCase of corpus.searchCases) {
      const beforeMemory = await hashDirectory(memoryDir);
      const rendered = await memorySearchTool.execute({
        query: searchCase.query,
        all_projects: searchCase.scope === "all",
        type: searchCase.type,
      });

      assertRequiredAndForbidden(rendered, searchCase, evidencePaths);
      if (searchCase.expectedResultCount === 0) {
        expect(rendered).toContain("No session memories found");
      } else {
        expect(rendered).toContain(`Found ${searchCase.expectedResultCount} matching result`);
      }
      if (searchCase.noMutation) expect(await hashDirectory(memoryDir)).toBe(beforeMemory);
      expect(hashContent(await Bun.file(corpusPath).text())).toBe(corpusIdentity);
    }
  });

  test("preserves both sides of conflicting compiled knowledge", async () => {
    const beforeMemory = await hashDirectory(memoryDir);
    const inspection = await inspectKnowledge(memoryDir, currentCwd);
    const topic = inspection.topics.find(
      (candidate) => candidate.slug === "conflicting-storage-policy",
    );

    expect(inspection.complete).toBe(true);
    expect(inspection.diagnostics).toEqual([]);
    expect(topic?.decisions.map((decision) => decision.text)).toEqual([
      "Originally keep storage ephemeral",
      "Updated: persist storage locally",
    ]);
    for (const sourceKey of ["knowledge-one", "knowledge-two"]) {
      const impact = findKnowledgeSourceImpact(inspection, sourceIds.get(sourceKey) ?? sourceKey);
      expect(impact.topics.map((candidate) => candidate.filePath)).toContain(topic?.filePath ?? "");
    }
    expect(await hashDirectory(memoryDir)).toBe(beforeMemory);
    expect(hashContent(await Bun.file(corpusPath).text())).toBe(corpusIdentity);
  });

  test("gates topic discovery and context character growth separately", async () => {
    const renderedSizes: number[] = [];

    for (const contextCase of corpus.contextCases) {
      const contextMemoryDir = join(rootDir, `context-memory-${contextCase.topicCount}`);
      const cwd = `/fixtures/context-${contextCase.topicCount}`;
      const knowledgeDir = join(contextMemoryDir, "knowledge", projectSlug(cwd));
      await mkdir(knowledgeDir, { recursive: true });
      await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd }));

      const expectedTitles: string[] = [];
      for (let index = 1; index <= contextCase.topicCount; index++) {
        const title = `Context Topic ${String(index).padStart(2, "0")}`;
        expectedTitles.push(title);
        await Bun.write(
          join(knowledgeDir, `context-topic-${String(index).padStart(2, "0")}.md`),
          `---
title: ${title}
created: 2026-07-15
updated: 2026-07-15
confidence: medium
sources:
  - context-source
summary: Fixed-width context discovery fixture ${String(index).padStart(2, "0")}
---

## Overview

Deterministic context fixture.
`,
        );
      }
      await rebuildIndex(knowledgeDir);
      const beforeLoad = await hashDirectory(contextMemoryDir);

      const rendered = await loadKnowledgeIndex(contextMemoryDir, cwd);

      for (const title of expectedTitles) expect(rendered).toContain(title);
      expect(rendered.length).toBeLessThanOrEqual(contextCase.maxCharacters);
      expect(await hashDirectory(contextMemoryDir)).toBe(beforeLoad);
      expect(hashContent(await Bun.file(corpusPath).text())).toBe(corpusIdentity);
      renderedSizes.push(rendered.length);
    }

    for (let index = 1; index < renderedSizes.length; index++) {
      expect(renderedSizes[index]).toBeGreaterThan(renderedSizes[index - 1] ?? 0);
    }
  });
});
