/**
 * Orchestration tests for condensation (Pass 3) in consolidate.ts.
 *
 * Tests the integration layer: appendToArchive, condenseEntries, and
 * the modified runConsolidation flow. Inference is mocked at the module
 * boundary — everything else uses real filesystem.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearningEntry } from "../../../src/memory/learnings";
import { parseLearnings, promoteToGlobal, renderLearnings } from "../../../src/memory/learnings";
import { writeLearnings } from "../../../src/memory/learning-store";
import { testCwd, testCwds } from "../../helpers/memory-path";

const testMemoryDir = join(tmpdir(), "shaka-test-consolidate-orch");

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? testCwds("/projects/myapp"),
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Use Bun.file() instead of fs.readFile()",
    body: overrides.body ?? "This project uses Bun runtime.",
  };
}

// --- appendToArchive ---

describe("appendToArchive", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("creates archive file when it does not exist", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");

    const entries = [
      makeEntry({ title: "Archived A", body: "Body A." }),
      makeEntry({ title: "Archived B", body: "Body B." }),
    ];

    await appendToArchive(testMemoryDir, entries);

    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(true);

    const content = await archiveFile.text();
    expect(content).toContain("Archived A");
    expect(content).toContain("Archived B");
  });

  test("appends to existing archive file without losing previous entries", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");

    // First write
    const first = [makeEntry({ title: "First Entry", body: "First body." })];
    await appendToArchive(testMemoryDir, first);

    // Second write
    const second = [makeEntry({ title: "Second Entry", body: "Second body." })];
    await appendToArchive(testMemoryDir, second);

    const content = await Bun.file(join(testMemoryDir, "learnings-archive.md")).text();
    const parsed = parseLearnings(content);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.title).toBe("First Entry");
    expect(parsed[1]!.title).toBe("Second Entry");
  });

  test("preserves promotion evidence in the archive", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");
    const promoted = promoteToGlobal(
      makeEntry({ title: "Promoted", cwds: testCwds("/a", "/b", "/c") }),
      "automatic-cross-project-threshold",
    );

    await appendToArchive(testMemoryDir, [promoted]);

    const content = await Bun.file(join(testMemoryDir, "learnings-archive.md")).text();
    expect(parseLearnings(content)).toEqual([promoted]);
  });

  test("refuses to append when existing archive promotion metadata is malformed", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");
    const archivePath = join(testMemoryDir, "learnings-archive.md");
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
<!-- promotion: invalid-json -->

### Archived global entry

Body.
`;
    await Bun.write(archivePath, raw);

    await expect(
      appendToArchive(testMemoryDir, [makeEntry({ title: "New archive entry" })]),
    ).rejects.toThrow("promotion metadata");

    expect(await Bun.file(archivePath).text()).toBe(raw);
  });

  test("refuses to append invalid applicability evidence", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");
    const archivePath = join(testMemoryDir, "learnings-archive.md");
    const invalid = {
      ...makeEntry({ title: "Invalid archive entry", cwds: ["*"] }),
      promotionEvidence: {
        sourceCwds: testCwds("/work/project"),
        excludedCwds: testCwds("/work/project"),
        exposures: [],
        reasons: ["manual-scope-correction" as const],
      },
    };

    await expect(appendToArchive(testMemoryDir, [invalid])).rejects.toThrow(
      "invalid applicability scope",
    );

    expect(await Bun.file(archivePath).exists()).toBe(false);
  });

  test("refuses to replace a symlinked archive", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");
    const archivePath = join(testMemoryDir, "learnings-archive.md");
    const targetPath = join(testMemoryDir, "linked-archive.md");
    const raw = renderLearnings([makeEntry({ title: "Existing archive entry" })]);
    await Bun.write(targetPath, raw);
    await symlink(targetPath, archivePath);

    await expect(
      appendToArchive(testMemoryDir, [makeEntry({ title: "New archive entry" })]),
    ).rejects.toThrow("regular file");

    expect((await lstat(archivePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(targetPath).text()).toBe(raw);
  });

  test("refuses to replace a dangling archive symlink", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");
    const archivePath = join(testMemoryDir, "learnings-archive.md");
    const missingTarget = join(testMemoryDir, "missing-archive.md");
    await symlink(missingTarget, archivePath);

    await expect(
      appendToArchive(testMemoryDir, [makeEntry({ title: "New archive entry" })]),
    ).rejects.toThrow("regular file");

    expect((await lstat(archivePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(missingTarget).exists()).toBe(false);
  });

  test("no-ops when given empty array", async () => {
    const { appendToArchive } = await import("../../../src/memory/learning-store");

    await appendToArchive(testMemoryDir, []);

    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(false);
  });
});

// --- condenseEntries ---

describe("condenseEntries", () => {
  test("returns entries unchanged when no candidates exist", async () => {
    // All entries have only 1 exposure — below CONDENSATION_EXPOSURE_MIN (2)
    // So findCondensationCandidates returns empty, and inference is never called.
    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/proj") }),
      makeEntry({ title: "B", cwds: testCwds("/proj") }),
    ];

    const result = await condenseEntries(entries);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.title).toBe("A");
    expect(result.entries[1]!.title).toBe("B");
    expect(result.archived).toHaveLength(0);
    expect(result.compoundsCreated).toBe(0);
  });
});

// --- condenseEntries with inference mock ---

// These tests mock the inference boundary to control LLM output.
// mock.module must be called before importing the module under test.

describe("condenseEntries (with inference)", () => {
  afterEach(() => {
    mock.restore();
  });

  function twoExposures() {
    return [
      { date: "2026-03-01", sessionHash: "aaaa0000" },
      { date: "2026-03-05", sessionHash: "bbbb0000" },
    ];
  }

  test("processes candidates and produces compound entries", async () => {
    const inferenceResponse = `CLUSTER [1, 2] — Bun runtime
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() for file I/O and bun:test for testing. Avoids Node.js-specific APIs.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: inferenceResponse }),
      hasInferenceProvider: async () => false,
    }));

    // Re-import to pick up mock
    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "Use Bun.file()",
        cwds: testCwds("/myapp"),
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: testCwds("/myapp"),
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    expect(result.compoundsCreated).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Bun Runtime Conventions");
    expect(result.archived).toHaveLength(2);
  });

  test("skips candidates where inference fails (fail-open)", async () => {
    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: false, error: "timeout" }),
      hasInferenceProvider: async () => false,
    }));

    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/myapp"),
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/myapp"),
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    // Entries returned unchanged — inference failure means no condensation
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.title).toBe("A");
    expect(result.entries[1]!.title).toBe("B");
    expect(result.archived).toHaveLength(0);
    expect(result.compoundsCreated).toBe(0);
  });

  test("processes successful candidates and skips failed ones", async () => {
    let callCount = 0;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            text: `CLUSTER [1, 2] — Topic A
TITLE: Compound A
BODY: Merged body A.`,
          };
        }
        // Second call fails
        return { success: false, error: "timeout" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { condenseEntries } = await import("../../../src/memory/consolidation");

    const entries = [
      makeEntry({
        title: "A1",
        cwds: testCwds("/proj-a"),
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "A2",
        cwds: testCwds("/proj-a"),
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B1",
        cwds: testCwds("/proj-b"),
        exposures: twoExposures(),
      }),
      makeEntry({
        title: "B2",
        cwds: testCwds("/proj-b"),
        exposures: twoExposures(),
      }),
    ];

    const result = await condenseEntries(entries);

    // First candidate (/proj-a) succeeded, second (/proj-b) failed
    expect(result.compoundsCreated).toBe(1);
    expect(result.entries.find((e) => e.title === "Compound A")).toBeDefined();
    // A1 and A2 consumed by condensation
    expect(result.entries.find((e) => e.title === "A1")).toBeUndefined();
    expect(result.entries.find((e) => e.title === "A2")).toBeUndefined();
    expect(result.archived).toHaveLength(2);
    // B1 and B2 survive unchanged
    expect(result.entries.find((e) => e.title === "B1")).toBeDefined();
    expect(result.entries.find((e) => e.title === "B2")).toBeDefined();
  });
});

// --- runConsolidation threshold behavior ---

describe("promptForScopeWidening", () => {
  test("shows every positive source CWD before asking for a widening decision", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const sourceCwds = testCwds(
      "/company-a/project-1",
      "/company-a/project-2",
      "/company-a/project-3",
    );
    const entry = {
      ...makeEntry({ title: "Company convention", cwds: testCwds("/company-a") }),
      promotionEvidence: {
        sourceCwds,
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-common-ancestor-review" as const],
      },
    };
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));

    try {
      await promptForScopeWidening([entry], {
        isTTY: true,
        prompt: async () => {
          const rendered = output.join("\n");
          expect(rendered).toContain(`Sources: ${sourceCwds.join(", ")}`);
          return "q";
        },
      });
    } finally {
      console.log = originalLog;
    }
  });

  test("accepts a displayed common ancestor", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const entry = makeEntry({
      title: "Company convention",
      cwds: testCwds("/company-a/project-1", "/company-a/project-2", "/company-a/project-3"),
    });

    const result = await promptForScopeWidening([entry], {
      isTTY: true,
      forbiddenAncestorRoots: testCwds("/Users/test"),
      prompt: async () => "a",
    });

    expect(result[0]?.cwds).toEqual(testCwds("/company-a"));
    expect(result[0]?.nonglobal).toBe(true);
    expect(result[0]?.promotionEvidence?.sourceCwds).toEqual(entry.cwds);
    expect(result[0]?.promotionEvidence?.reasons).toEqual(["manual-common-ancestor-review"]);
  });

  test("does not offer an ancestor equal to the automatic single-root scope", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const entry = {
      ...makeEntry({ title: "Company convention", cwds: testCwds("/company-a") }),
      promotionEvidence: {
        sourceCwds: testCwds(
          "/company-a/project-1",
          "/company-a/project-2",
          "/company-a/project-3",
        ),
        excludedCwds: [],
        exposures: [],
        reasons: ["automatic-hierarchical-generalization" as const],
      },
    };
    let question = "";

    const result = await promptForScopeWidening([entry], {
      isTTY: true,
      prompt: async (value) => {
        question = value;
        return "g";
      },
    });

    expect(question).not.toContain("[a]");
    expect(result[0]?.cwds).toEqual(["*"]);
  });

  test("offers a broader ancestor after independent clusters generalize", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const entry = {
      ...makeEntry({
        title: "Company convention",
        cwds: testCwds("/company-a/project-1", "/company-a/project-2"),
      }),
      promotionEvidence: {
        sourceCwds: testCwds(
          "/company-a/project-1/repo-a",
          "/company-a/project-1/repo-b",
          "/company-a/project-1/repo-c",
          "/company-a/project-2/repo-a",
          "/company-a/project-2/repo-b",
          "/company-a/project-2/repo-c",
        ),
        excludedCwds: [],
        exposures: [],
        reasons: ["automatic-hierarchical-generalization" as const],
      },
    };
    let question = "";

    const result = await promptForScopeWidening([entry], {
      isTTY: true,
      prompt: async (value) => {
        question = value;
        return "a";
      },
    });

    expect(question).toContain("[a]");
    expect(result[0]?.cwds).toEqual(testCwds("/company-a"));
    expect(result[0]?.promotionEvidence?.reasons).toEqual([
      "automatic-hierarchical-generalization",
      "manual-common-ancestor-review",
    ]);
  });

  test("requires an explicit global choice", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const entry = makeEntry({ cwds: testCwds("/a", "/b", "/c") });

    const result = await promptForScopeWidening([entry], {
      isTTY: true,
      prompt: async () => "g",
    });

    expect(result[0]?.cwds).toEqual(["*"]);
    expect(result[0]?.promotionEvidence?.reasons).toEqual(["manual-global-review"]);
  });

  test("view returns to the same prompt and keep stops future reviews", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const answers = ["v", "k"];
    let prompts = 0;
    const entry = makeEntry({ cwds: testCwds("/a", "/b", "/c") });

    const result = await promptForScopeWidening([entry], {
      isTTY: true,
      prompt: async () => {
        prompts++;
        return answers.shift() ?? "q";
      },
    });

    expect(prompts).toBe(2);
    expect(result[0]?.cwds).toEqual(entry.cwds);
    expect(result[0]?.nonglobal).toBe(true);
    expect(result[0]?.promotionEvidence).toBeUndefined();
  });

  test("skip advances and quit leaves remaining candidates unchanged", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const first = makeEntry({ title: "First", cwds: testCwds("/a", "/b", "/c") });
    const second = makeEntry({ title: "Second", cwds: testCwds("/d", "/e", "/f") });
    const answers = ["s", "q"];

    const result = await promptForScopeWidening([first, second], {
      isTTY: true,
      prompt: async () => answers.shift() ?? "q",
    });

    expect(result).toEqual([first, second]);
  });

  test("updates duplicate titles by reviewed structural position", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const first = makeEntry({ title: "Same title", cwds: testCwds("/a", "/b", "/c") });
    const second = makeEntry({ title: "Same title", cwds: testCwds("/d", "/e", "/f") });
    const answers = ["g", "k"];

    const result = await promptForScopeWidening([first, second], {
      isTTY: true,
      prompt: async () => answers.shift() ?? "q",
    });

    expect(result[0]?.cwds).toEqual(["*"]);
    expect(result[1]?.cwds).toEqual(second.cwds);
    expect(result[1]?.nonglobal).toBe(true);
  });

  test("rejects structurally identical widening candidates as ambiguous", async () => {
    const { promptForScopeWidening } = await import("../../../src/commands/memory/consolidate");
    const first = makeEntry({ title: "Identical", cwds: testCwds("/a", "/b", "/c") });
    const second = makeEntry({ title: "Identical", cwds: testCwds("/a", "/b", "/c") });
    let prompts = 0;
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    let result: LearningEntry[] | undefined;

    try {
      result = await promptForScopeWidening([first, second], {
        isTTY: true,
        prompt: async () => {
          prompts++;
          return "g";
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(prompts).toBe(0);
    expect(result).toEqual([first, second]);
    expect(output.join("\n")).toContain("identical persisted entries are ambiguous");
  });
});

describe("runConsolidation", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("rejects corrupt promotion metadata before consolidation side effects", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
<!-- promotion: invalid-json -->

### Global entry

Body.
`;
    const learningsPath = join(testMemoryDir, "learnings.md");
    await Bun.write(learningsPath, raw);

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

    await expect(runConsolidation(testMemoryDir)).rejects.toThrow("promotion metadata");

    expect(await Bun.file(learningsPath).text()).toBe(raw);
    expect(await Bun.file(join(testMemoryDir, "learnings.backup.md")).exists()).toBe(false);
    expect(await Bun.file(join(testMemoryDir, "learnings-archive.md")).exists()).toBe(false);
  });

  test("preserves legacy source bytes before writing the operational backup", async () => {
    const raw = `# Learnings

Custom header retained by the backup.

---

<!-- correction | cwd: ${testCwd("/myapp")} | exposures: 2026-02-09@aaaa0000 -->

### Project entry

Body.
`;
    await Bun.write(join(testMemoryDir, "learnings.md"), raw);

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");
    await runConsolidation(testMemoryDir);

    expect(
      await Bun.file(join(testMemoryDir, ".learning-scope-migration-v1.active.md")).text(),
    ).toBe(raw);
    expect(await Bun.file(join(testMemoryDir, "learnings.backup.md")).text()).toBe(
      await Bun.file(join(testMemoryDir, "learnings.md")).text(),
    );
  });

  test("runs pass 3 even below threshold of 20 entries", async () => {
    // Mock inference to return NO CLUSTERS (so no actual condensation happens)
    // but we verify it was called, proving pass 3 ran.
    // Entries have single CWDs so no promotion candidates — promptUser never called.
    let inferenceCalled = false;
    mock.module("../../../src/inference", () => ({
      inference: async () => {
        inferenceCalled = true;
        return { success: true, text: "NO CLUSTERS" };
      },
      hasInferenceProvider: async () => false,
    }));

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

    // Write 5 entries (well below threshold 20), but with 2+ exposures
    // so findCondensationCandidates finds them. Single CWD = no promotion prompt.
    const entries: LearningEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: `hash${i}a00` },
          { date: "2026-03-05", sessionHash: `hash${i}b00` },
        ],
      }),
    );

    await writeLearnings(testMemoryDir, entries);
    await runConsolidation(testMemoryDir);

    // Pass 3 must have run — inference was called
    expect(inferenceCalled).toBe(true);
  });

  test("applies deterministic generalization in non-TTY consolidation", async () => {
    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");
    const { loadLearnings } = await import("../../../src/memory/learnings");
    await writeLearnings(testMemoryDir, [
      makeEntry({
        title: "Company convention",
        cwds: testCwds(
          "/work/company-a/project-1",
          "/work/company-a/project-2",
          "/work/company-a/project-3",
        ),
      }),
    ]);

    await runConsolidation(testMemoryDir, {
      isTTY: false,
      forbiddenAncestorRoots: testCwds("/home/alice"),
    });

    expect((await loadLearnings(testMemoryDir))[0]).toMatchObject({
      cwds: testCwds("/work/company-a"),
      promotionEvidence: {
        sourceCwds: testCwds(
          "/work/company-a/project-1",
          "/work/company-a/project-2",
          "/work/company-a/project-3",
        ),
        reasons: ["automatic-hierarchical-generalization"],
      },
    });
  });

  test("archives condensed entries to learnings-archive.md", async () => {
    const inferenceResponse = `CLUSTER [1, 2] — Bun conventions
TITLE: Bun Runtime Conventions
BODY: Use Bun.file() and bun:test. Avoids Node.js APIs.`;

    mock.module("../../../src/inference", () => ({
      inference: async () => ({ success: true, text: inferenceResponse }),
      hasInferenceProvider: async () => false,
    }));

    const { runConsolidation } = await import("../../../src/commands/memory/consolidate");

    // 2 entries with 2+ exposures in same CWD — eligible for condensation.
    // Single CWD each = no promotion candidates, so promptUser never called.
    const entries: LearningEntry[] = [
      makeEntry({
        title: "Use Bun.file()",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Use bun:test",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];

    await writeLearnings(testMemoryDir, entries);
    await runConsolidation(testMemoryDir);

    // Archive file should exist with the 2 source entries
    const archiveFile = Bun.file(join(testMemoryDir, "learnings-archive.md"));
    expect(await archiveFile.exists()).toBe(true);

    const archiveContent = await archiveFile.text();
    expect(archiveContent).toContain("Use Bun.file()");
    expect(archiveContent).toContain("Use bun:test");

    // Main learnings should have the compound entry
    const { loadLearnings } = await import("../../../src/memory/learnings");
    const finalEntries = await loadLearnings(testMemoryDir);
    expect(finalEntries).toHaveLength(1);
    expect(finalEntries[0]!.title).toBe("Bun Runtime Conventions");
  });
});
