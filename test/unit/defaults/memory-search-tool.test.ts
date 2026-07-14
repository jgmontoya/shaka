import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memorySearchTool from "../../../defaults/system/tools/memory-search";
import { writeSummary } from "../../../src/memory/storage";

describe("memory-search tool", () => {
  let previousShakaHome: string | undefined;
  let shakaHome: string;
  let memoryDir: string;

  beforeEach(async () => {
    previousShakaHome = process.env.SHAKA_HOME;
    shakaHome = await mkdtemp(join(tmpdir(), "shaka-memory-search-tool-"));
    memoryDir = join(shakaHome, "memory");
    process.env.SHAKA_HOME = shakaHome;
    await mkdir(memoryDir, { recursive: true });
  });

  afterEach(async () => {
    if (previousShakaHome === undefined) process.env.SHAKA_HOME = undefined;
    else process.env.SHAKA_HOME = previousShakaHome;
    await rm(shakaHome, { recursive: true, force: true });
  });

  test("all_projects includes matches from unrelated projects", async () => {
    await writeSummary(memoryDir, {
      metadata: {
        date: "2026-07-14",
        cwd: "/projects/unrelated",
        provider: "claude",
        sessionId: "tool-all-projects",
      },
      tags: [],
      title: "Remote project needle",
      body: "## Summary\nOnly explicit cross-project recall should find this.",
    });

    const result = await memorySearchTool.execute({ query: "needle", all_projects: true });

    expect(result).toContain("Remote project needle");
  });

  test("default search excludes matches from unrelated projects", async () => {
    await writeSummary(memoryDir, {
      metadata: {
        date: "2026-07-14",
        cwd: "/projects/unrelated",
        provider: "claude",
        sessionId: "tool-default-scope",
      },
      tags: [],
      title: "Unrelated default needle",
      body: "## Summary\nThis must require explicit cross-project recall.",
    });

    const result = await memorySearchTool.execute({ query: "needle" });

    expect(result).not.toContain("Unrelated default needle");
  });

  test("rejects cwd together with all_projects", async () => {
    const result = await memorySearchTool.execute({
      query: "needle",
      cwd: process.cwd(),
      all_projects: true,
    });

    expect(result).toBe("Error: cwd and all_projects cannot be used together");
  });

  test("honors memory.search_max_results", async () => {
    await Bun.write(
      join(shakaHome, "config.json"),
      JSON.stringify({
        version: "test",
        reasoning: {},
        permissions: {},
        providers: {},
        assistant: {},
        principal: {},
        memory: { search_max_results: 1 },
      }),
    );
    for (const [date, sessionId] of [
      ["2026-07-13", "tool-max-one"],
      ["2026-07-14", "tool-max-two"],
    ] as const) {
      await writeSummary(memoryDir, {
        metadata: { date, cwd: process.cwd(), provider: "claude", sessionId },
        tags: [],
        title: `Configured limit ${sessionId}`,
        body: "## Summary\nConfigured limit token.",
      });
    }

    const result = await memorySearchTool.execute({ query: "configured limit" });

    expect(result).toContain("Found 1 matching result:");
    expect(result).toContain("Configured limit tool-max-two");
    expect(result).not.toContain("Configured limit tool-max-one");
  });

  test("returns compiled knowledge with its own result type", async () => {
    const knowledgeDir = join(memoryDir, "knowledge", "current-project");
    await mkdir(knowledgeDir, { recursive: true });
    await Bun.write(join(knowledgeDir, ".project.json"), JSON.stringify({ cwd: process.cwd() }));
    await Bun.write(
      join(knowledgeDir, "memory-architecture.md"),
      `---
title: Memory Architecture
updated: 2026-07-14
summary: Project-scoped recall
---

Compiled knowledge needle.
`,
    );

    const result = await memorySearchTool.execute({ query: "needle", type: "knowledge" });

    expect(result).toContain("[knowledge] Memory Architecture");
  });
});
