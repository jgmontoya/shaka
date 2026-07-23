import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLearnings } from "../../../src/memory/learning-store";
import { loadLearnings } from "../../../src/memory/learnings";
import { hashSessionId } from "../../../src/memory/utils";
import { testCwd, testCwds } from "../../helpers/memory-path";

describe("session-end hook", () => {
  test("exports TRIGGER with session.end", async () => {
    const mod = await import("../../../defaults/system/hooks/session-end.ts");
    expect(mod.TRIGGER).toEqual(["session.end"]);
  });

  test("exports HOOK_VERSION string", async () => {
    const mod = await import("../../../defaults/system/hooks/session-end.ts");
    expect(typeof mod.HOOK_VERSION).toBe("string");
    expect(mod.HOOK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("does not execute on import (import.meta.main guard)", async () => {
    // If dispatch() ran on import, it would try to read stdin and hang or crash.
    // The fact that this import completes without error proves the guard works.
    const mod = await import("../../../defaults/system/hooks/session-end.ts");
    expect(mod.TRIGGER).toBeDefined();
  });

  test("source file contains import.meta.main guard", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    expect(source).toContain("import.meta.main");
  });

  test("source file imports from shaka package", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    expect(source).toContain('from "shaka"');
  });

  test("source file uses fail-open pattern (exits 0 on error)", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    expect(source).toContain("process.exit(0)");
    expect(source).toContain("catch");
  });

  test("source file implements fire-and-forget dispatch/worker pattern", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    // Dispatch writes temp file and spawns detached worker
    expect(source).toContain("--worker");
    expect(source).toContain("proc.unref()");
    // Worker reads temp file and deletes it
    expect(source).toContain("unlink(tmpPath)");
  });

  test("source file has provider discrimination for codex", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    // loadTranscript should route codex to its own parser
    expect(source).toContain('"codex"');
    expect(source).toContain("loadCodexTranscript");
    expect(source).toContain("parseCodexTranscript");
  });

  test("SessionEndInput interface includes optional provider field", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();
    expect(source).toContain("provider?: string");
  });

  test("maintenance timing reports hierarchical generalization", async () => {
    const source = await Bun.file("defaults/system/hooks/session-end.ts").text();

    expect(source).toContain("`generalized=${maintenanceResult.generalized ?? 0}`");
    expect(source).not.toContain("`promoted=${maintenanceResult.promoted");
  });
});

describe("session-end learning rewrite", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "shaka-session-end-learning-"));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  test("a valid empty extraction retracts prior ordinary session contributions", async () => {
    const sessionId = "session-valid-empty";
    await writeLearnings(memoryDir, [
      {
        category: "fact",
        cwds: testCwds("/work/project"),
        exposures: [{ date: "2026-07-20", sessionHash: hashSessionId(sessionId) }],
        nonglobal: false,
        title: "Retracted learning",
        body: "This result was superseded.",
      },
    ]);
    const { extractAndWriteLearnings } = await import("../../../defaults/system/hooks/session-end");

    const committed = await extractAndWriteLearnings(
      "## Learnings\n\nNone.",
      {
        date: "2026-07-21",
        cwd: testCwd("/work/project"),
        provider: "test",
        sessionId,
      },
      memoryDir,
      true,
    );

    expect(committed).toBe(0);
    expect(await loadLearnings(memoryDir)).toEqual([]);
  });

  test("malformed extraction preserves prior session contributions", async () => {
    const sessionId = "session-malformed";
    const existing = {
      category: "fact" as const,
      cwds: testCwds("/work/project"),
      exposures: [{ date: "2026-07-20", sessionHash: hashSessionId(sessionId) }],
      nonglobal: false,
      title: "Preserved learning",
      body: "Keep this result.",
    };
    const { extractAndWriteLearnings } = await import("../../../defaults/system/hooks/session-end");

    for (const malformedHeading of ["###", "###(pattern) Missing space"]) {
      await writeLearnings(memoryDir, [existing]);
      const committed = await extractAndWriteLearnings(
        `## Learnings

### (fact) Valid-looking draft

Body.

${malformedHeading}`,
        {
          date: "2026-07-21",
          cwd: testCwd("/work/project"),
          provider: "test",
          sessionId,
        },
        memoryDir,
        true,
      );

      expect(committed).toBe(0);
      expect(await loadLearnings(memoryDir)).toEqual([existing]);
    }
  });

  test("readiness failure supplies no titles and disables the final learning write", async () => {
    await Bun.write(join(memoryDir, ".learning-scope-migration-v1.json"), "not-json");
    const { prepareLearningExtraction } = await import(
      "../../../defaults/system/hooks/session-end"
    );

    const result = await prepareLearningExtraction(memoryDir);

    expect(result).toEqual({ existingTitles: [], learningWriteAllowed: false });
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).text()).toBe(
      "not-json",
    );
  });

  test("early readiness migrates mixed wildcard records before title extraction", async () => {
    const companionCwd = join(memoryDir, "company-a", "project-1");
    await Bun.write(
      join(memoryDir, "learnings.md"),
      `# Learnings

---

<!-- pattern | cwd: *, ${companionCwd} | exposures: 2026-07-20@early000 -->

### Existing legacy title

Body.
`,
    );
    const { prepareLearningExtraction } = await import(
      "../../../defaults/system/hooks/session-end"
    );

    const result = await prepareLearningExtraction(memoryDir);

    expect(result).toEqual({
      existingTitles: ["Existing legacy title"],
      learningWriteAllowed: true,
    });
    expect((await loadLearnings(memoryDir))[0]?.promotionEvidence?.sourceCwds).toEqual([
      companionCwd,
    ]);
  });

  test("invalid rewrite context skips mutation before migration artifacts", async () => {
    const { extractAndWriteLearnings } = await import("../../../defaults/system/hooks/session-end");

    const committed = await extractAndWriteLearnings(
      `## Learnings

### (fact) Valid draft

Body.`,
      {
        date: "2026-02-30",
        cwd: "relative/project",
        provider: "test",
        sessionId: "invalid-context",
      },
      memoryDir,
      true,
    );

    expect(committed).toBe(0);
    expect(await Bun.file(join(memoryDir, ".learning-scope-migration-v1.json")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(memoryDir, "learnings.md")).exists()).toBe(false);
  });
});
