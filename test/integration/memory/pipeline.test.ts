import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMemory } from "../../../src/memory/search";
import {
  listSummaries,
  loadSummary,
  selectRecentSummaries,
  writeSummary,
} from "../../../src/memory/storage";
import { buildSummarizationPrompt, parseSummaryOutput } from "../../../src/memory/summarize";
import {
  parseClaudeCodeTranscript,
  parseOpencodeTranscript,
  truncateTranscript,
} from "../../../src/memory/transcript";
import {
  CLAUDE_JSONL,
  CLAUDE_LLM_OUTPUT,
  CLAUDE_METADATA,
  OPENCODE_EXPORT,
  OPENCODE_LLM_OUTPUT,
  OPENCODE_METADATA,
} from "./fixtures";

const testMemoryDir = join(tmpdir(), "shaka-test-pipeline");

describe("Memory pipeline", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  describe("Claude Code pipeline", () => {
    test("parses JSONL transcript into normalized messages", () => {
      const messages = parseClaudeCodeTranscript(CLAUDE_JSONL);

      expect(messages).toHaveLength(6);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toContain("rate limiting");
      expect(messages[1]?.role).toBe("assistant");
      expect(messages[1]?.content).toContain("[Tool: Read]");
    });

    test("composes full cycle from transcript to searchable summary", async () => {
      const messages = parseClaudeCodeTranscript(CLAUDE_JSONL);
      const truncated = truncateTranscript(messages, 100_000);
      expect(truncated).toEqual(messages);

      const prompt = buildSummarizationPrompt(truncated, CLAUDE_METADATA);
      expect(prompt).toContain("rate limiting");
      expect(prompt).toContain("/projects/api-server");

      const parsed = parseSummaryOutput(CLAUDE_LLM_OUTPUT);
      expect(parsed).not.toBeNull();

      const summary = { ...parsed!, metadata: CLAUDE_METADATA };
      const filePath = await writeSummary(testMemoryDir, summary);
      expect(await Bun.file(filePath).exists()).toBe(true);

      const listed = await listSummaries(testMemoryDir);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.title).toContain("Rate Limiting");
      expect(listed[0]?.provider).toBe("claude");
      expect(listed[0]?.cwd).toBe("/projects/api-server");
      expect(listed[0]?.sessionId).toBe("ses-claude-fixture");

      const results = await searchMemory("redis", testMemoryDir);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.title).toContain("Rate Limiting");

      const loaded = await loadSummary(filePath);
      expect(loaded?.metadata.provider).toBe("claude");
      expect(loaded?.metadata.sessionId).toBe("ses-claude-fixture");
    });
  });

  describe("opencode pipeline", () => {
    test("parses export JSON into normalized messages", () => {
      const messages = parseOpencodeTranscript(OPENCODE_EXPORT);

      expect(messages).toHaveLength(4);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toContain("CSS grid");
      expect(messages[1]?.role).toBe("assistant");
      expect(messages[1]?.content).toContain("[Tool: Read]");
    });

    test("composes full cycle from transcript to searchable summary", async () => {
      const messages = parseOpencodeTranscript(OPENCODE_EXPORT);
      const truncated = truncateTranscript(messages, 100_000);
      expect(truncated).toEqual(messages);

      const prompt = buildSummarizationPrompt(truncated, OPENCODE_METADATA);
      expect(prompt).toContain("CSS grid");
      expect(prompt).toContain("/projects/dashboard");

      const parsed = parseSummaryOutput(OPENCODE_LLM_OUTPUT);
      expect(parsed).not.toBeNull();

      const summary = { ...parsed!, metadata: OPENCODE_METADATA };
      const filePath = await writeSummary(testMemoryDir, summary);
      expect(await Bun.file(filePath).exists()).toBe(true);

      const listed = await listSummaries(testMemoryDir);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.provider).toBe("opencode");
      expect(listed[0]?.cwd).toBe("/projects/dashboard");

      const results = await searchMemory("grid", testMemoryDir);
      expect(results.length).toBeGreaterThan(0);

      const loaded = await loadSummary(filePath);
      expect(loaded?.metadata.provider).toBe("opencode");
    });
  });

  describe("cross-provider", () => {
    test("selectRecentSummaries prefers CWD matches", async () => {
      const claudeParsed = parseSummaryOutput(CLAUDE_LLM_OUTPUT)!;
      await writeSummary(testMemoryDir, { ...claudeParsed, metadata: CLAUDE_METADATA });

      const opencodeParsed = parseSummaryOutput(OPENCODE_LLM_OUTPUT)!;
      await writeSummary(testMemoryDir, { ...opencodeParsed, metadata: OPENCODE_METADATA });

      const all = await listSummaries(testMemoryDir);
      expect(all).toHaveLength(2);

      const selected = selectRecentSummaries(all, "/projects/dashboard", 1);
      expect(selected).toHaveLength(1);
      expect(selected[0]?.provider).toBe("opencode");
      expect(selected[0]?.cwd).toBe("/projects/dashboard");
    });

    test("search finds summaries from each provider independently", async () => {
      const claudeParsed = parseSummaryOutput(CLAUDE_LLM_OUTPUT)!;
      await writeSummary(testMemoryDir, { ...claudeParsed, metadata: CLAUDE_METADATA });

      const opencodeParsed = parseSummaryOutput(OPENCODE_LLM_OUTPUT)!;
      await writeSummary(testMemoryDir, { ...opencodeParsed, metadata: OPENCODE_METADATA });

      const claudeResults = await searchMemory("rate limiter", testMemoryDir);
      expect(claudeResults).toHaveLength(1);
      expect(claudeResults[0]?.title).toContain("Rate Limiting");

      const opencodeResults = await searchMemory("sidebar", testMemoryDir);
      expect(opencodeResults).toHaveLength(1);
      expect(opencodeResults[0]?.title).toContain("Dashboard Layout");
    });
  });

  describe("condensation pipeline", () => {
    test("full pipeline: entries survive dedup and contradiction, then condense", async () => {
      // Simulate a realistic consolidation run with 20+ entries where:
      // - Passes 1-2 run (above threshold)
      // - Pass 3 condenses high-exposure entries into a compound
      // - Source entries are archived
      // - Compound replaces sources in the final learnings

      // Mock inference to handle all three passes:
      // Pass 1 (dedup): NO DUPLICATES
      // Pass 2 (contradiction): NO CONTRADICTIONS
      // Pass 3 (condensation): cluster entries 1 and 2
      let callNum = 0;
      mock.module("../../../src/inference", () => ({
        inference: async () => {
          callNum++;
          if (callNum === 1) return { success: true, text: "NO DUPLICATES" };
          if (callNum === 2) return { success: true, text: "NO CONTRADICTIONS" };
          return {
            success: true,
            text: `CLUSTER [1, 2] — Bun runtime conventions
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() for all file I/O and bun:test for testing. These are Bun-native APIs that avoid unnecessary Node.js compatibility layers.`,
          };
        },
        hasInferenceProvider: async () => false,
      }));

      const { loadLearnings, writeLearnings } = await import("../../../src/memory/learnings");
      const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

      // Build 20+ entries (to trigger passes 1-2).
      // First 2 have 2+ exposures and same CWD → condensation candidates.
      // Rest are filler with single exposure, single CWD (no promotion candidates).
      const twoExposures = [
        { date: "2026-03-01", sessionHash: "aaaa0000" },
        { date: "2026-03-05", sessionHash: "bbbb0000" },
      ];

      const entries = [
        {
          category: "pattern" as const,
          cwds: ["/myapp"],
          exposures: twoExposures,
          nonglobal: false,
          title: "Use Bun.file() for file I/O",
          body: "Bun.file() is the native way to read files in Bun.",
        },
        {
          category: "pattern" as const,
          cwds: ["/myapp"],
          exposures: twoExposures,
          nonglobal: false,
          title: "Use bun:test for testing",
          body: "The bun:test module provides a fast test runner built into Bun.",
        },
        // 18 filler entries with different CWDs to avoid promotion prompts
        ...Array.from({ length: 18 }, (_, i) => ({
          category: "fact" as const,
          cwds: [`/filler-${i}`],
          exposures: [{ date: "2026-03-01", sessionHash: `fill${String(i).padStart(4, "0")}` }],
          nonglobal: false,
          title: `Filler entry ${i}`,
          body: `This is filler entry ${i}.`,
        })),
      ];

      await writeLearnings(testMemoryDir, entries);
      await runConsolidation(testMemoryDir);

      // Verify: learnings.md has compound + 18 fillers = 19 entries
      const final = await loadLearnings(testMemoryDir);
      expect(final).toHaveLength(19);

      const compound = final.find((e) => e.title === "Bun Runtime Conventions");
      expect(compound).toBeDefined();
      expect(compound?.cwds).toEqual(["/myapp"]);
      expect(compound?.body).toContain("Bun.file()");
      expect(compound?.body).toContain("bun:test");

      // Verify: original entries no longer in active learnings
      expect(final.find((e) => e.title === "Use Bun.file() for file I/O")).toBeUndefined();
      expect(final.find((e) => e.title === "Use bun:test for testing")).toBeUndefined();

      // Verify: source entries are in the archive
      const archiveContent = await Bun.file(join(testMemoryDir, "learnings-archive.md")).text();
      expect(archiveContent).toContain("Use Bun.file() for file I/O");
      expect(archiveContent).toContain("Use bun:test for testing");

      // Verify: all 3 inference calls were made (dedup, contradiction, condensation)
      expect(callNum).toBe(3);
    });

    test("condensed entries are searchable in archive", async () => {
      const { writeLearnings } = await import("../../../src/memory/learnings");
      const { appendToArchive } = await import("../../../src/memory/learnings");

      // Write an active learning and an archived one
      await writeLearnings(testMemoryDir, [
        {
          category: "pattern" as const,
          cwds: ["/myapp"],
          exposures: [{ date: "2026-03-01", sessionHash: "aaaa0000" }],
          nonglobal: false,
          title: "Active Entry",
          body: "This is still active.",
        },
      ]);

      await appendToArchive(testMemoryDir, [
        {
          category: "pattern" as const,
          cwds: ["/myapp"],
          exposures: [{ date: "2026-02-01", sessionHash: "bbbb0000" }],
          nonglobal: false,
          title: "Archived Entry",
          body: "This was condensed and archived.",
        },
      ]);

      // Search should find both
      const activeResults = await searchMemory("Active", testMemoryDir);
      expect(activeResults.length).toBeGreaterThan(0);

      const archiveResults = await searchMemory("Archived", testMemoryDir);
      expect(archiveResults.length).toBeGreaterThan(0);
      expect(archiveResults[0]?.snippet).toContain("[archived]");
    });
  });

  describe("truncation", () => {
    test("truncated transcript produces valid prompt", () => {
      const messages = parseClaudeCodeTranscript(CLAUDE_JSONL);
      const truncated = truncateTranscript(messages, 200);

      expect(truncated.length).toBeLessThan(messages.length);
      expect(truncated[0]?.content).toContain("truncated");

      const prompt = buildSummarizationPrompt(truncated, CLAUDE_METADATA);
      expect(prompt).toContain("<transcript>");
      expect(prompt).toContain("truncated");
    });
  });

  describe("inference failure", () => {
    test("parseSummaryOutput returns null for garbage input", () => {
      expect(parseSummaryOutput("just some random text")).toBeNull();
      expect(parseSummaryOutput("")).toBeNull();
      expect(parseSummaryOutput("---\ninvalid yaml: [\n---\n")).toBeNull();
    });

    test("parseSummaryOutput returns null for valid frontmatter without title", () => {
      const noTitle = `---
date: 2026-02-09
cwd: /projects/test
tags: [test]
provider: claude
session_id: ses-test
---

Some content without a heading.`;
      expect(parseSummaryOutput(noTitle)).toBeNull();
    });
  });

  describe("re-summarization", () => {
    test("same session ID overwrites previous summary", async () => {
      const parsed = parseSummaryOutput(OPENCODE_LLM_OUTPUT)!;

      const path1 = await writeSummary(testMemoryDir, {
        ...parsed,
        metadata: OPENCODE_METADATA,
        title: "Initial partial summary",
      });
      const path2 = await writeSummary(testMemoryDir, {
        ...parsed,
        metadata: OPENCODE_METADATA,
      });

      expect(path1).toBe(path2);

      const listed = await listSummaries(testMemoryDir);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.title).toBe(parsed.title);

      const results = await searchMemory("Dashboard", testMemoryDir);
      expect(results).toHaveLength(1);
    });
  });
});
