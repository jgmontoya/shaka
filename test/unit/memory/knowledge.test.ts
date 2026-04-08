import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readExistingTopicTitles,
  readManifest,
  findUnprocessedSessions,
  extractFragmentsFromSummary,
  groupFragmentsByTopic,
  buildCreatePrompt,
  buildMergePrompt,
  rebuildIndex,
  appendToLog,
  writeManifest,
  compileKnowledge,
  loadKnowledgeIndex,
  bootstrapKnowledge,
} from "../../../src/memory/knowledge";
import type { KnowledgeFragment } from "../../../src/memory/summarize";

describe("Knowledge", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "shaka-knowledge-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("readExistingTopicTitles", () => {
    test("returns empty array when knowledge directory does not exist", async () => {
      const titles = await readExistingTopicTitles(join(tmpDir, "nonexistent"));
      expect(titles).toEqual([]);
    });

    test("returns topic slugs from .md files, excluding _index.md and log.md", async () => {
      const knowledgeDir = join(tmpDir, "knowledge");
      await mkdir(knowledgeDir, { recursive: true });
      await Bun.write(join(knowledgeDir, "auth-system.md"), "# Auth System\n");
      await Bun.write(join(knowledgeDir, "deployment-pipeline.md"), "# Deployment\n");
      await Bun.write(join(knowledgeDir, "_index.md"), "# Index\n");
      await Bun.write(join(knowledgeDir, "log.md"), "# Log\n");

      const titles = await readExistingTopicTitles(knowledgeDir);
      expect(titles.sort()).toEqual(["auth-system", "deployment-pipeline"]);
    });

    test("returns empty array for empty directory", async () => {
      const knowledgeDir = join(tmpDir, "empty-knowledge");
      await mkdir(knowledgeDir, { recursive: true });
      const titles = await readExistingTopicTitles(knowledgeDir);
      expect(titles).toEqual([]);
    });

    test("ignores non-.md files like .manifest.json", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-mixed");
      await mkdir(knowledgeDir, { recursive: true });
      await Bun.write(join(knowledgeDir, "auth-system.md"), "# Auth\n");
      await Bun.write(join(knowledgeDir, ".manifest.json"), "{}");
      await Bun.write(join(knowledgeDir, ".lock"), "");

      const titles = await readExistingTopicTitles(knowledgeDir);
      expect(titles).toEqual(["auth-system"]);
    });
  });

  describe("readManifest", () => {
    test("returns empty manifest when file does not exist", async () => {
      const manifest = await readManifest(join(tmpDir, "nonexistent"));
      expect(manifest).toEqual({ compiledSources: {}, lastCompilation: "" });
    });

    test("reads manifest from .manifest.json", async () => {
      const knowledgeDir = join(tmpDir, "knowledge");
      await mkdir(knowledgeDir, { recursive: true });
      await Bun.write(
        join(knowledgeDir, ".manifest.json"),
        JSON.stringify({
          compiledSources: { "2026-04-01-abc12345": "sha256hash1" },
          lastCompilation: "2026-04-06T15:30:00Z",
        }),
      );

      const manifest = await readManifest(knowledgeDir);
      expect(manifest.compiledSources).toEqual({ "2026-04-01-abc12345": "sha256hash1" });
      expect(manifest.lastCompilation).toBe("2026-04-06T15:30:00Z");
    });
  });

  describe("findUnprocessedSessions", () => {
    test("all sessions are unprocessed when manifest is empty", () => {
      const manifest = { compiledSources: {}, lastCompilation: "" };
      const sessions = [
        { filename: "2026-04-01-abc12345.md", contentHash: "hash1", content: "" },
        { filename: "2026-04-02-def67890.md", contentHash: "hash2", content: "" },
        { filename: "2026-04-03-ghi11111.md", contentHash: "hash3", content: "" },
      ];
      const unprocessed = findUnprocessedSessions(manifest, sessions);
      expect(unprocessed).toHaveLength(3);
    });

    test("returns only sessions not in manifest", () => {
      const manifest = {
        compiledSources: {
          "2026-04-01-abc12345.md": "hash1",
          "2026-04-02-def67890.md": "hash2",
        },
        lastCompilation: "2026-04-02T00:00:00Z",
      };
      const sessions = [
        { filename: "2026-04-01-abc12345.md", contentHash: "hash1", content: "" },
        { filename: "2026-04-02-def67890.md", contentHash: "hash2", content: "" },
        { filename: "2026-04-03-ghi11111.md", contentHash: "hash3", content: "" },
      ];
      const unprocessed = findUnprocessedSessions(manifest, sessions);
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0]?.filename).toBe("2026-04-03-ghi11111.md");
    });

    test("returns sessions with changed content hash", () => {
      const manifest = {
        compiledSources: {
          "2026-04-01-abc12345.md": "old-hash",
        },
        lastCompilation: "2026-04-01T00:00:00Z",
      };
      const sessions = [
        { filename: "2026-04-01-abc12345.md", contentHash: "new-hash", content: "" },
      ];
      const unprocessed = findUnprocessedSessions(manifest, sessions);
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0]?.contentHash).toBe("new-hash");
    });
  });

  describe("extractFragmentsFromSummary", () => {
    test("extracts fragments from session summary content with Knowledge section", () => {
      const content = `---
date: "2026-04-01"
cwd: /projects/myapp
tags: [auth]
provider: claude
session_id: ses-abc123
---

# Auth Session

## Summary
Worked on auth.

## Knowledge

### Auth Middleware Architecture

The auth layer uses JWT with rotating refresh tokens.
Topics: auth, architecture

### Why FTS5 Over Vector Search

FTS5 was chosen for deterministic search.
Topics: search, architecture-decisions
`;
      const fragments = extractFragmentsFromSummary(content, "2026-04-01-abc12345.md");
      expect(fragments).toHaveLength(2);
      expect(fragments[0]?.title).toBe("Auth Middleware Architecture");
      expect(fragments[0]?.topics).toEqual(["auth", "architecture"]);
      expect(fragments[0]?.sourceSession).toBe("2026-04-01-abc12345");
      expect(fragments[1]?.title).toBe("Why FTS5 Over Vector Search");
    });

    test("returns empty array when no Knowledge section exists", () => {
      const content = `---
date: "2026-04-01"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-xyz789
---

# Simple Session

## Summary
Just a simple session.

## Learnings

### (fact) Something

A fact.
`;
      const fragments = extractFragmentsFromSummary(content, "2026-04-01-xyz78901.md");
      expect(fragments).toEqual([]);
    });
  });

  describe("groupFragmentsByTopic", () => {
    const makeFragment = (
      title: string,
      topics: string[],
      sourceSession = "ses-001",
    ): KnowledgeFragment => ({
      title,
      body: `Body of ${title}`,
      topics,
      sourceSession,
    });

    test("assigns fragment to existing topic when tag matches slug", () => {
      const fragments = [makeFragment("JWT Setup", ["auth-system", "jwt"])];
      const existingSlugs = ["auth-system", "deployment-pipeline"];
      const groups = groupFragmentsByTopic(fragments, existingSlugs);

      expect(groups.size).toBe(1);
      expect(groups.has("auth-system")).toBe(true);
      expect(groups.get("auth-system")).toHaveLength(1);
    });

    test("creates new group from shared tags when no existing topic matches", () => {
      const fragments = [
        makeFragment("FTS5 Performance", ["search", "performance"]),
        makeFragment("Search Index Design", ["search", "architecture"]),
      ];
      const groups = groupFragmentsByTopic(fragments, []);

      // Both fragments share "search" tag - should be grouped under "search"
      expect(groups.has("search")).toBe(true);
      const searchGroup = groups.get("search");
      expect(searchGroup).toHaveLength(2);
    });

    test("fragment with multiple matching existing topics goes to best match", () => {
      const fragments = [
        makeFragment("Auth Scaling", ["auth-system", "scaling", "architecture"]),
      ];
      // Two existing topics match — "auth-system" matches the first tag
      const existingSlugs = ["auth-system", "architecture"];
      const groups = groupFragmentsByTopic(fragments, existingSlugs);

      // Should be assigned to "auth-system" (first match)
      expect(groups.has("auth-system")).toBe(true);
    });

    test("fragments with no tags are skipped", () => {
      const fragments = [makeFragment("Orphan", [])];
      const groups = groupFragmentsByTopic(fragments, []);
      expect(groups.size).toBe(0);
    });

    test("normalizes tags: lowercase, trim, hyphens for spaces", () => {
      const fragments = [makeFragment("Mixed Case", ["Auth System", " SCALING "])];
      const existingSlugs = ["auth-system"];
      const groups = groupFragmentsByTopic(fragments, existingSlugs);

      expect(groups.has("auth-system")).toBe(true);
    });
  });

  describe("buildCreatePrompt", () => {
    test("includes fragment content and source sessions", () => {
      const fragments: KnowledgeFragment[] = [
        {
          title: "Auth Middleware",
          body: "The auth layer uses JWT with rotating refresh tokens.",
          topics: ["auth", "architecture"],
          sourceSession: "2026-04-01-abc12345",
        },
        {
          title: "Token Rotation",
          body: "Refresh tokens rotate every 7 days.",
          topics: ["auth"],
          sourceSession: "2026-04-03-def67890",
        },
      ];

      const prompt = buildCreatePrompt(fragments);
      expect(prompt).toContain("Auth Middleware");
      expect(prompt).toContain("JWT with rotating refresh tokens");
      expect(prompt).toContain("2026-04-01-abc12345");
      expect(prompt).toContain("Token Rotation");
      expect(prompt).toContain("2026-04-03-def67890");
      // Should include structural instructions
      expect(prompt).toContain("## Overview");
      expect(prompt).toContain("## Key Decisions");
      expect(prompt).toContain("confidence");
    });
  });

  describe("buildMergePrompt", () => {
    test("includes existing page content and new fragments", () => {
      const existingPage = `---
title: Auth System
created: 2026-04-01
updated: 2026-04-01
confidence: medium
sources:
  - 2026-04-01-abc12345
summary: "JWT auth with rotating refresh tokens"
---

## Overview

The auth layer uses JWT.

## Key Decisions

- Uses stateless JWT (source: 2026-04-01-abc12345)
`;
      const fragments: KnowledgeFragment[] = [
        {
          title: "Token Rotation Policy",
          body: "Refresh tokens rotate every 7 days for compliance.",
          topics: ["auth"],
          sourceSession: "2026-04-03-def67890",
        },
      ];

      const prompt = buildMergePrompt(existingPage, fragments);
      expect(prompt).toContain("Auth System");
      expect(prompt).toContain("JWT auth with rotating refresh tokens");
      expect(prompt).toContain("Token Rotation Policy");
      expect(prompt).toContain("2026-04-03-def67890");
      expect(prompt).toContain("3500");  // soft size limit
    });
  });

  describe("rebuildIndex", () => {
    test("builds index from topic page frontmatter", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-idx");
      await mkdir(knowledgeDir, { recursive: true });

      const authPage = `---
title: Auth System
created: 2026-04-01
updated: 2026-04-15
confidence: high
sources:
  - 2026-04-01-abc12345
  - 2026-04-15-def67890
summary: "JWT + rotating refresh tokens, stateless"
---

## Overview

The auth layer uses JWT.

## Key Decisions

- Uses stateless JWT (source: 2026-04-01-abc12345)
`;
      const searchPage = `---
title: Search Architecture
created: 2026-04-08
updated: 2026-04-08
confidence: medium
sources:
  - 2026-04-08-ghi11111
summary: "FTS5, local-only, deterministic"
---

## Overview

FTS5-based search.

## Key Decisions

- Chose FTS5 over vectors (source: 2026-04-08-ghi11111)
`;
      await Bun.write(join(knowledgeDir, "auth-system.md"), authPage);
      await Bun.write(join(knowledgeDir, "search-architecture.md"), searchPage);

      await rebuildIndex(knowledgeDir);

      const indexContent = await Bun.file(join(knowledgeDir, "_index.md")).text();
      expect(indexContent).toContain("# Knowledge Index");
      expect(indexContent).toContain("Auth System");
      expect(indexContent).toContain("high");
      expect(indexContent).toContain("2026-04-15");
      expect(indexContent).toContain("Search Architecture");
      expect(indexContent).toContain("medium");
      expect(indexContent).toContain("FTS5, local-only, deterministic");
    });

    test("writes minimal index for empty directory", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-empty-idx");
      await mkdir(knowledgeDir, { recursive: true });

      await rebuildIndex(knowledgeDir);

      const indexContent = await Bun.file(join(knowledgeDir, "_index.md")).text();
      expect(indexContent).toContain("# Knowledge Index");
      // Table header should still be present
      expect(indexContent).toContain("Topic");
      expect(indexContent).toContain("Confidence");
    });
  });

  describe("appendToLog", () => {
    test("creates log file with header on first append", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-log");
      await mkdir(knowledgeDir, { recursive: true });

      await appendToLog(knowledgeDir, {
        sessionCount: 2,
        topicsCreated: ["auth-system"],
        topicsUpdated: ["deployment-pipeline"],
      });

      const log = await Bun.file(join(knowledgeDir, "log.md")).text();
      expect(log).toContain("# Knowledge Compilation Log");
      expect(log).toContain("2 sessions");
      expect(log).toContain("auth-system");
      expect(log).toContain("deployment-pipeline");
    });

    test("appends to existing log file", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-log2");
      await mkdir(knowledgeDir, { recursive: true });

      await appendToLog(knowledgeDir, {
        sessionCount: 1,
        topicsCreated: ["auth-system"],
        topicsUpdated: [],
      });

      await appendToLog(knowledgeDir, {
        sessionCount: 3,
        topicsCreated: [],
        topicsUpdated: ["auth-system", "search"],
      });

      const log = await Bun.file(join(knowledgeDir, "log.md")).text();
      expect(log).toContain("1 session");
      expect(log).toContain("3 sessions");
    });
  });

  describe("writeManifest", () => {
    test("writes manifest atomically", async () => {
      const knowledgeDir = join(tmpDir, "knowledge-manifest-write");
      await mkdir(knowledgeDir, { recursive: true });

      const manifest = {
        compiledSources: { "2026-04-01-abc12345.md": "hash1" },
        lastCompilation: "2026-04-06T15:30:00Z",
      };
      await writeManifest(knowledgeDir, manifest);

      const read = await readManifest(knowledgeDir);
      expect(read.compiledSources).toEqual({ "2026-04-01-abc12345.md": "hash1" });
      expect(read.lastCompilation).toBe("2026-04-06T15:30:00Z");
    });
  });

  describe("compileKnowledge", () => {
    /**
     * Helper: create a session summary file with a Knowledge section.
     */
    async function createSessionSummary(
      sessionsDir: string,
      filename: string,
      knowledgeContent: string,
    ): Promise<void> {
      const parts = filename.replace(".md", "").split("-");
      const date = parts.slice(0, 3).join("-");
      const content = `---
date: "${date}"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-${parts[3] ?? "test"}
---

# Test Session ${filename}

## Summary
Test session summary.

${knowledgeContent}
`;
      await Bun.write(join(sessionsDir, filename), content);
    }

    test("end-to-end: compiles fragments into new topic page", async () => {
      const memoryDir = join(tmpDir, "memory-e2e");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Create two session summaries with knowledge fragments about "auth"
      await createSessionSummary(sessionsDir, "2026-04-01-abc12345.md", `## Knowledge

### Auth Middleware Design

The auth layer uses JWT with rotating refresh tokens for stateless auth.
Topics: auth, architecture`);

      await createSessionSummary(sessionsDir, "2026-04-03-def67890.md", `## Knowledge

### Token Rotation Policy

Refresh tokens rotate every 7 days for compliance requirements.
Topics: auth`);

      // Mock inferFn: returns a valid topic page when called
      const inferFn = async (_prompt: string): Promise<string> => {
        return `---
title: Auth System
created: 2026-04-01
updated: 2026-04-03
confidence: medium
sources:
  - 2026-04-01-abc12345
  - 2026-04-03-def67890
summary: "JWT auth with rotating refresh tokens, stateless design"
---

## Overview

The auth layer uses JWT with rotating refresh tokens. Session state is stateless on the server side.

## Key Decisions

- Uses stateless JWT for horizontal scaling (source: 2026-04-01-abc12345)
- Refresh tokens rotate every 7 days for compliance (source: 2026-04-03-def67890)
`;
      };

      const result = await compileKnowledge(memoryDir, "/projects/myapp", inferFn);

      // Should have compiled successfully
      expect(result.sessionsProcessed).toBe(2);
      expect(result.topicsCreated.length).toBeGreaterThanOrEqual(1);

      // Topic page should exist
      const knowledgeDir = join(memoryDir, "knowledge");
      // Read the actual directory listing to find the project knowledge dir
      const knowledgeEntries = await Bun.file(join(knowledgeDir)).exists();
      // The knowledge dir should have been created under a project slug
      const projectDirs = await readdir(knowledgeDir).catch(() => []);
      expect(projectDirs.length).toBeGreaterThan(0);

      const projectKnowledgeDir = join(knowledgeDir, projectDirs[0]!);
      // Check that a topic page was written
      const topicFiles = (await readdir(projectKnowledgeDir)).filter(
        (f) => f.endsWith(".md") && f !== "_index.md" && f !== "log.md",
      );
      expect(topicFiles.length).toBeGreaterThanOrEqual(1);

      // Check manifest was updated
      const manifest = await readManifest(projectKnowledgeDir);
      expect(Object.keys(manifest.compiledSources)).toHaveLength(2);

      // Check index was rebuilt
      const indexContent = await Bun.file(join(projectKnowledgeDir, "_index.md")).text();
      expect(indexContent).toContain("Auth System");

      // Check log was written
      const logContent = await Bun.file(join(projectKnowledgeDir, "log.md")).text();
      expect(logContent).toContain("2 sessions");
    });

    test("skips compilation when no unprocessed sessions", async () => {
      const memoryDir = join(tmpDir, "memory-skip");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      await createSessionSummary(sessionsDir, "2026-04-01-abc12345.md", `## Knowledge

### Auth Design

Auth uses JWT.
Topics: auth`);

      // First compilation
      const inferFn = async (_prompt: string): Promise<string> => {
        return `---
title: Auth
created: 2026-04-01
updated: 2026-04-01
confidence: low
sources:
  - 2026-04-01-abc12345
summary: "JWT auth"
---

## Overview

Auth uses JWT.

## Key Decisions

- Uses JWT (source: 2026-04-01-abc12345)
`;
      };

      await compileKnowledge(memoryDir, "/projects/myapp", inferFn);

      // Second compilation with same sessions — should skip
      let inferCalled = false;
      const noopInfer = async (_prompt: string): Promise<string> => {
        inferCalled = true;
        return "";
      };

      const result = await compileKnowledge(memoryDir, "/projects/myapp", noopInfer);
      expect(result.sessionsProcessed).toBe(0);
      expect(inferCalled).toBe(false);
    });

    test("handles sessions with no Knowledge section gracefully", async () => {
      const memoryDir = join(tmpDir, "memory-no-knowledge");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      await createSessionSummary(sessionsDir, "2026-04-01-abc12345.md", `## Learnings

### (fact) Some Fact

Just a learning, no knowledge.`);

      const inferFn = async (_prompt: string): Promise<string> => "";

      const result = await compileKnowledge(memoryDir, "/projects/myapp", inferFn);
      // Session was processed but yielded no fragments
      expect(result.sessionsProcessed).toBe(1);
      expect(result.topicsCreated).toEqual([]);
      expect(result.topicsUpdated).toEqual([]);
    });
  });

  describe("loadKnowledgeIndex", () => {
    test("returns empty string when no knowledge directory exists", async () => {
      const memoryDir = join(tmpDir, "memory-no-kb");
      await mkdir(memoryDir, { recursive: true });

      const section = await loadKnowledgeIndex(memoryDir, "/projects/myapp");
      expect(section).toBe("");
    });

    test("returns index with header and topic table", async () => {
      const memoryDir = join(tmpDir, "memory-kb-index");
      const knowledgeDir = join(memoryDir, "knowledge", "-projects-myapp");
      await mkdir(knowledgeDir, { recursive: true });

      const authPage = `---
title: Auth System
created: 2026-04-01
updated: 2026-04-15
confidence: high
sources:
  - 2026-04-01-abc12345
summary: "JWT + rotating refresh tokens, stateless"
---

## Overview

The auth layer uses JWT with rotating refresh tokens.
`;

      const searchPage = `---
title: Search Architecture
created: 2026-04-08
updated: 2026-04-08
confidence: medium
sources:
  - 2026-04-08-ghi11111
summary: "FTS5, local-only, deterministic"
---

## Overview

FTS5-based search system.
`;

      await Bun.write(join(knowledgeDir, "auth-system.md"), authPage);
      await Bun.write(join(knowledgeDir, "search-architecture.md"), searchPage);
      await rebuildIndex(knowledgeDir);

      const section = await loadKnowledgeIndex(memoryDir, "/projects/myapp");

      expect(section).toContain("## Project Knowledge Base");
      expect(section).toContain("Read individual topic pages");
      expect(section).toContain("Auth System");
      expect(section).toContain("Search Architecture");
      // Index contains file paths, not full content
      expect(section).toContain(knowledgeDir);
      // Full topic content is NOT injected
      expect(section).not.toContain("The auth layer uses JWT");
      expect(section).not.toContain("FTS5-based search system");
    });
  });

  describe("bootstrapKnowledge", () => {
    /**
     * Helper: create a session summary file without a Knowledge section.
     */
    async function createSessionWithoutKnowledge(
      sessionsDir: string,
      filename: string,
      body = "Worked on authentication features.",
    ): Promise<void> {
      const parts = filename.replace(".md", "").split("-");
      const date = parts.slice(0, 3).join("-");
      const content = `---
date: "${date}"
cwd: /projects/myapp
tags: [auth]
provider: claude
session_id: ses-${parts[3] ?? "test"}
---

# Session: ${filename}

## Summary
${body}

## Decisions
- Chose JWT over session cookies for stateless auth.

## Problems Solved
- Fixed token expiration edge case.
`;
      await Bun.write(join(sessionsDir, filename), content);
    }

    /**
     * Helper: create a session summary file WITH a Knowledge section.
     */
    async function createSessionWithKnowledge(
      sessionsDir: string,
      filename: string,
    ): Promise<void> {
      const parts = filename.replace(".md", "").split("-");
      const date = parts.slice(0, 3).join("-");
      const content = `---
date: "${date}"
cwd: /projects/myapp
tags: [auth]
provider: claude
session_id: ses-${parts[3] ?? "test"}
---

# Session: ${filename}

## Summary
Worked on auth.

## Knowledge

### Existing Fragment

Already extracted knowledge.
Topics: auth
`;
      await Bun.write(join(sessionsDir, filename), content);
    }

    /**
     * Mock inferFn that returns bootstrap extraction format.
     * Maps session filenames to fragment output.
     */
    function makeBootstrapInferFn(
      responseMap: Record<string, string>,
    ): (prompt: string) => Promise<string> {
      return async (prompt: string): Promise<string> => {
        // Return the matching response based on which sessions are in the prompt
        for (const [filename, response] of Object.entries(responseMap)) {
          if (prompt.includes(filename)) return response;
        }
        // Default: return no-knowledge response
        return "SESSION: unknown.md\n(no knowledge)";
      };
    }

    test("Slice 1: bootstrap with 1 session extracts fragments and writes them back", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-1");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      await createSessionWithoutKnowledge(sessionsDir, "2026-04-01-abc12345.md");

      // Mock inference that returns fragments for this session
      const inferFn = async (_prompt: string): Promise<string> => {
        return `SESSION: 2026-04-01-abc12345.md
### JWT Architecture Decision

The system uses JWT with rotating refresh tokens for stateless authentication. This avoids server-side session storage.
Topics: auth, architecture

SESSION: 2026-04-01-abc12345.md
(end)`;
      };

      const result = await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn);

      // Verify result stats
      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.fragmentsExtracted).toBe(1);
      expect(result.batchesRun).toBe(1);

      // Verify the session file now has ## Knowledge appended
      const updatedContent = await Bun.file(join(sessionsDir, "2026-04-01-abc12345.md")).text();
      expect(updatedContent).toContain("## Knowledge");
      expect(updatedContent).toContain("### JWT Architecture Decision");
      expect(updatedContent).toContain("Topics: auth, architecture");
    });

    test("Slice 2: sessions with existing ## Knowledge are skipped", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-2");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // One session WITHOUT knowledge - should be processed
      await createSessionWithoutKnowledge(sessionsDir, "2026-04-01-abc12345.md");

      // One session WITH knowledge - should be skipped
      await createSessionWithKnowledge(sessionsDir, "2026-04-02-def67890.md");

      let inferCallCount = 0;
      const inferFn = async (_prompt: string): Promise<string> => {
        inferCallCount++;
        return `SESSION: 2026-04-01-abc12345.md
### Auth Design

JWT for stateless auth.
Topics: auth`;
      };

      const result = await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn);

      // Only 1 session found (without knowledge), 1 processed
      expect(result.sessionsFound).toBe(1);
      expect(result.sessionsProcessed).toBe(1);

      // The session WITH knowledge should not have been modified
      const withKnowledgeContent = await Bun.file(
        join(sessionsDir, "2026-04-02-def67890.md"),
      ).text();
      // Should still have exactly one ## Knowledge section (no duplication)
      const knowledgeMatches = withKnowledgeContent.match(/## Knowledge/g);
      expect(knowledgeMatches).toHaveLength(1);
      expect(withKnowledgeContent).toContain("### Existing Fragment");
    });

    test("Slice 3: batching splits sessions into correct number of batches", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-3");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Create 12 sessions without knowledge
      for (let i = 1; i <= 12; i++) {
        const hash = String(i).padStart(8, "0");
        await createSessionWithoutKnowledge(
          sessionsDir,
          `2026-04-${String(i).padStart(2, "0")}-${hash}.md`,
          `Worked on feature ${i}.`,
        );
      }

      const batchSizes: number[] = [];
      const inferFn = async (prompt: string): Promise<string> => {
        // Count SESSION N: markers in the prompt to know batch size
        const sessionMarkers = prompt.match(/SESSION \d+:/g) ?? [];
        batchSizes.push(sessionMarkers.length);

        // Return (no knowledge) for all - we're just testing batching
        return "SESSION: dummy.md\n(no knowledge)";
      };

      const result = await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn, {
        batchSize: 5,
      });

      expect(result.sessionsFound).toBe(12);
      expect(result.sessionsProcessed).toBe(12);
      expect(result.batchesRun).toBe(3);

      // Batch sizes should be 5, 5, 2
      expect(batchSizes).toEqual([5, 5, 2]);
    });

    test("Slice 4: dry-run mode counts sessions but does not process", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-4");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      await createSessionWithoutKnowledge(sessionsDir, "2026-04-01-abc12345.md");
      await createSessionWithoutKnowledge(sessionsDir, "2026-04-02-def67890.md");
      await createSessionWithoutKnowledge(sessionsDir, "2026-04-03-ghi11111.md");

      let inferCalled = false;
      const inferFn = async (_prompt: string): Promise<string> => {
        inferCalled = true;
        return "";
      };

      const result = await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn, {
        dryRun: true,
      });

      expect(result.sessionsFound).toBe(3);
      expect(result.sessionsProcessed).toBe(0);
      expect(result.fragmentsExtracted).toBe(0);
      expect(result.batchesRun).toBe(0);
      expect(inferCalled).toBe(false);

      // Session files should be untouched
      const content = await Bun.file(join(sessionsDir, "2026-04-01-abc12345.md")).text();
      expect(content).not.toContain("## Knowledge");
    });

    test("Slice 5: limit caps the number of sessions processed", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-5");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Create 10 sessions
      for (let i = 1; i <= 10; i++) {
        const hash = String(i).padStart(8, "0");
        await createSessionWithoutKnowledge(
          sessionsDir,
          `2026-04-${String(i).padStart(2, "0")}-${hash}.md`,
          `Worked on feature ${i}.`,
        );
      }

      const inferFn = async (_prompt: string): Promise<string> => {
        return "SESSION: dummy.md\n(no knowledge)";
      };

      const result = await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn, {
        limit: 3,
      });

      expect(result.sessionsFound).toBe(10);
      expect(result.sessionsProcessed).toBe(3);
      // 1 batch of 3 (since batchSize defaults to 5, 3 < 5)
      expect(result.batchesRun).toBe(1);
    });

    test("onProgress callback is called for each batch", async () => {
      const memoryDir = join(tmpDir, "memory-bootstrap-progress");
      const sessionsDir = join(memoryDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      for (let i = 1; i <= 7; i++) {
        const hash = String(i).padStart(8, "0");
        await createSessionWithoutKnowledge(
          sessionsDir,
          `2026-04-${String(i).padStart(2, "0")}-${hash}.md`,
          `Worked on feature ${i}.`,
        );
      }

      const progressCalls: Array<{ batch: number; total: number; sessionCount: number }> = [];

      const inferFn = async (_prompt: string): Promise<string> => {
        return "SESSION: dummy.md\n(no knowledge)";
      };

      await bootstrapKnowledge(memoryDir, "/projects/myapp", inferFn, {
        batchSize: 3,
        onProgress: (batch, total, sessionCount) => {
          progressCalls.push({ batch, total, sessionCount });
        },
      });

      expect(progressCalls).toEqual([
        { batch: 1, total: 3, sessionCount: 3 },
        { batch: 2, total: 3, sessionCount: 3 },
        { batch: 3, total: 3, sessionCount: 1 },
      ]);
    });
  });
});
