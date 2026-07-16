import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKnowledgeSourceImpact, inspectKnowledge } from "../../../src/memory/inspection";
import { rebuildIndex } from "../../../src/memory/knowledge";
import { projectSlug } from "../../../src/memory/rollups";
import { hashContent } from "../../../src/memory/utils";

describe("inspectKnowledge", () => {
  let rootDir: string;
  let memoryDir: string;
  let knowledgeDir: string;
  const cwd = "/projects/shaka";
  const sourceId = "2026-07-14-abc12345";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "shaka-knowledge-inspection-"));
    memoryDir = join(rootDir, "memory");
    knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));
    await mkdir(join(memoryDir, "sessions"), { recursive: true });
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd }));
    await Bun.write(
      join(knowledgeDir, ".manifest.json"),
      JSON.stringify({
        compiledSources: { [`${sourceId}.md`]: hashContent("session source") },
        lastCompilation: "2026-07-14T12:00:00.000Z",
      }),
    );
    await Bun.write(join(memoryDir, "sessions", `${sourceId}.md`), "session source");
    await Bun.write(
      join(knowledgeDir, "memory-architecture.md"),
      `---
title: Memory Architecture
created: 2026-07-14
updated: 2026-07-14
confidence: medium
sources:
  - ${sourceId}
summary: Project-scoped memory design
---

## Overview

Shaka compiles durable project knowledge.

## Key Decisions

- Keep retrieval deterministic (source: ${sourceId})
`,
    );
    await rebuildIndex(knowledgeDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  test("returns a complete provenance model for a valid knowledge project", async () => {
    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(true);
    expect(inspection.diagnostics).toEqual([]);
    expect(inspection.topics).toEqual([
      expect.objectContaining({
        slug: "memory-architecture",
        sources: [sourceId],
        decisionSources: [sourceId],
      }),
    ]);
  });

  test("reports malformed topic pages as an incomplete inspection", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    await Bun.write(topicPath, "# Missing frontmatter");

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "malformed-topic-page",
        filePath: topicPath,
        severity: "error",
      }),
    );
  });

  test("reports topic pages whose frontmatter violates the compiled schema", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const content = await Bun.file(topicPath).text();
    await Bun.write(topicPath, content.replace("confidence: medium", "confidence: certain"));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.topics).toEqual([]);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "malformed-topic-page", filePath: topicPath }),
    );
  });

  test("reports noncanonical topic filenames while retaining their provenance", async () => {
    const canonicalPath = join(knowledgeDir, "memory-architecture.md");
    const noncanonicalPath = join(knowledgeDir, "`memory-architecture`.md");
    await rename(canonicalPath, noncanonicalPath);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(true);
    expect(inspection.topics).toContainEqual(
      expect.objectContaining({ filePath: noncanonicalPath, sources: [sourceId] }),
    );
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "noncanonical-topic-filename",
        filePath: noncanonicalPath,
        severity: "error",
      }),
    );
  });

  test("does not follow non-file topic entries", async () => {
    const topicEntry = join(knowledgeDir, "linked-topic.md");
    await mkdir(topicEntry);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "non-regular-topic-file",
        filePath: topicEntry,
        severity: "error",
      }),
    );
  });

  test("reports invalid project metadata", async () => {
    const metadataPath = join(knowledgeDir, ".project.json");
    await Bun.write(metadataPath, JSON.stringify({ cwd: 42 }));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.projectCwd).toBeNull();
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-project-metadata", filePath: metadataPath }),
    );
  });

  test("reports invalid compilation manifests", async () => {
    const manifestPath = join(knowledgeDir, ".manifest.json");
    await Bun.write(manifestPath, JSON.stringify({ compiledSources: [] }));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-manifest", filePath: manifestPath }),
    );
  });

  test("reports manifest hashes that no longer match their session source", async () => {
    await Bun.write(join(memoryDir, "sessions", `${sourceId}.md`), "changed session source");

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(true);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid-manifest",
        message: expect.stringContaining(`${sourceId}.md`),
      }),
    );
  });

  test("reports temporary compilation files", async () => {
    const temporaryPath = join(knowledgeDir, ".memory.md.tmp.interrupted");
    await Bun.write(temporaryPath, "partial write");

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "temporary-file", filePath: temporaryPath }),
    );
  });

  test("reports topic sources whose session summary is missing", async () => {
    const sourcePath = join(memoryDir, "sessions", `${sourceId}.md`);
    await rm(sourcePath);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-source-session", filePath: sourcePath }),
    );
  });

  test("reports decision citations omitted from topic frontmatter", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const content = await Bun.file(topicPath).text();
    await Bun.write(topicPath, content.replace(`  - ${sourceId}`, "  - another-session"));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unlisted-decision-source",
        filePath: topicPath,
        message: expect.stringContaining(sourceId),
      }),
    );
  });

  test("reports topic sources omitted from the compilation manifest", async () => {
    const otherSource = "2026-07-15-def67890";
    await Bun.write(join(memoryDir, "sessions", `${otherSource}.md`), "other source");
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const content = await Bun.file(topicPath).text();
    await Bun.write(topicPath, content.replaceAll(sourceId, otherSource));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unmanifested-topic-source",
        filePath: topicPath,
        message: expect.stringContaining(otherSource),
      }),
    );
  });

  test("rejects source identifiers that could escape the sessions directory", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const content = await Bun.file(topicPath).text();
    await Bun.write(topicPath, content.replaceAll(sourceId, "../outside"));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-source-session", filePath: topicPath }),
    );
  });

  test("reports a missing knowledge index", async () => {
    const indexPath = join(knowledgeDir, "_index.md");
    await rm(indexPath);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-index", filePath: indexPath }),
    );
  });

  test("reports valid topic pages omitted from the index", async () => {
    const original = await Bun.file(join(knowledgeDir, "memory-architecture.md")).text();
    const topicPath = join(knowledgeDir, "retrieval.md");
    await Bun.write(topicPath, original.replace("Memory Architecture", "Retrieval"));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unindexed-topic", filePath: topicPath }),
    );
  });

  test("reports index entries whose topic page is missing", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    await rm(topicPath);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-indexed-topic", filePath: topicPath }),
    );
  });

  test("reports index metadata that differs from its topic page", async () => {
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const content = await Bun.file(topicPath).text();
    await Bun.write(topicPath, content.replace("Memory Architecture", "Knowledge Architecture"));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "index-metadata-mismatch", filePath: topicPath }),
    );
  });

  test("reports index rows that cannot be parsed", async () => {
    const indexPath = join(knowledgeDir, "_index.md");
    const content = await Bun.file(indexPath).text();
    const malformed = content
      .split("\n")
      .map((line) => (line.startsWith("| [") ? "| malformed topic row |" : line))
      .join("\n");
    await Bun.write(indexPath, malformed);

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.complete).toBe(false);
    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "malformed-index", filePath: indexPath }),
    );
  });

  test("rejects index targets outside the knowledge directory", async () => {
    const indexPath = join(knowledgeDir, "_index.md");
    const topicPath = join(knowledgeDir, "memory-architecture.md");
    const outsidePath = join(rootDir, "outside.md");
    const content = await Bun.file(indexPath).text();
    await Bun.write(indexPath, content.replace(topicPath, outsidePath));

    const inspection = await inspectKnowledge(memoryDir, cwd);

    expect(inspection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-index-target", filePath: indexPath }),
    );
  });
});

describe("findKnowledgeSourceImpact", () => {
  test("reports frontmatter and decision references from an existing inspection", () => {
    const sourceId = "2026-07-14-abc12345";
    const topicPath = "/memory/knowledge/project/retrieval.md";
    const impact = findKnowledgeSourceImpact(
      {
        knowledgeDir: "/memory/knowledge/project",
        projectCwd: "/projects/shaka",
        complete: true,
        diagnostics: [],
        topics: [
          {
            filePath: topicPath,
            slug: "retrieval",
            title: "Retrieval",
            confidence: "medium",
            updated: "2026-07-14",
            summary: "Retrieval decisions",
            sources: [sourceId],
            decisions: [{ text: "Keep substring matching", sourceSession: sourceId }],
            decisionSources: [sourceId],
          },
        ],
      },
      `/memory/sessions/${sourceId}.md`,
    );

    expect(impact).toEqual({
      sourceSession: sourceId,
      complete: true,
      topics: [
        {
          filePath: topicPath,
          title: "Retrieval",
          referencedInFrontmatter: true,
          decisions: ["Keep substring matching"],
        },
      ],
    });
  });
});
