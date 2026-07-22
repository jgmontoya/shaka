import { describe, expect, test } from "bun:test";
import {
  applyCondensation,
  applyDuplicateMerges,
  buildCondensationPrompt,
  buildContradictionPrompt,
  buildDuplicatePrompt,
  findCondensationCandidates,
  groupByCwd,
  parseCondensationOutput,
  parseContradictionOutput,
  parseDuplicateOutput,
  resolveContradictions,
} from "../../../src/memory/consolidation";
import type { CandidateWithClusters } from "../../../src/memory/consolidation";
import { type LearningEntry, promoteToGlobal } from "../../../src/memory/learnings";
import { testCwd, testCwds } from "../../helpers/memory-path";

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

// --- Duplicate Detection ---

describe("buildDuplicatePrompt", () => {
  test("numbers entries starting at [1]", () => {
    const entries = [makeEntry({ title: "A" }), makeEntry({ title: "B" })];
    const prompt = buildDuplicatePrompt(entries);
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });

  test("includes category and title", () => {
    const prompt = buildDuplicatePrompt([makeEntry()]);
    expect(prompt).toContain("(correction)");
    expect(prompt).toContain("Use Bun.file()");
  });

  test("does not include CWDs or exposures", () => {
    const prompt = buildDuplicatePrompt([makeEntry({ cwds: testCwds("/secret/path") })]);
    expect(prompt).not.toContain(testCwd("/secret/path"));
    expect(prompt).not.toContain("a1b2c3d4");
  });
});

describe("parseDuplicateOutput", () => {
  test("parses KEEP/DROP line to 0-indexed", () => {
    const groups = parseDuplicateOutput("KEEP [1] DROP [3] — Both about Bun.file()");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.keep).toBe(0);
    expect(groups[0]?.drop).toEqual([2]);
  });

  test("parses multi-drop", () => {
    const groups = parseDuplicateOutput("KEEP [1] DROP [3, 7] — duplicates");
    expect(groups[0]?.drop).toEqual([2, 6]);
  });

  test("NO DUPLICATES returns empty array", () => {
    expect(parseDuplicateOutput("NO DUPLICATES")).toEqual([]);
  });

  test("malformed lines are skipped", () => {
    const groups = parseDuplicateOutput("This is not a valid line\nKEEP [1] DROP [2] — ok");
    expect(groups).toHaveLength(1);
  });
});

describe("applyDuplicateMerges", () => {
  test("KEEP absorbs DROP metadata", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/a"),
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/b"),
        exposures: [{ date: "2026-02-10", sessionHash: "bbbb0000" }],
      }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1] }]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.cwds).toContain(testCwd("/a"));
    expect(result.entries[0]?.cwds).toContain(testCwd("/b"));
    expect(result.entries[0]?.exposures).toHaveLength(2);
    expect(result).toMatchObject({
      mergedCount: 1,
      scopeNarrowedCount: 0,
      unresolvedCount: 0,
      overlappingNoopCount: 0,
    });
  });

  test("nonglobal preserved if any duplicate source had it", () => {
    const entries = [
      makeEntry({ title: "A", nonglobal: false }),
      makeEntry({ title: "B", nonglobal: true }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1] }]);
    expect(result.entries[0]?.nonglobal).toBe(true);
  });

  test("an invalid group is atomic and claims no input indices", () => {
    const entries = [makeEntry({ title: "A" }), makeEntry({ title: "B" })];
    const result = applyDuplicateMerges(entries, [
      { keep: 0, drop: [1, 99] },
      { keep: 0, drop: [1] },
    ]);

    expect(result.entries.map((entry) => entry.title)).toEqual(["A"]);
    expect(result).toMatchObject({ mergedCount: 1, unresolvedCount: 1 });
  });

  test("result count equals original minus drops", () => {
    const entries = [
      makeEntry({ title: "A" }),
      makeEntry({ title: "B" }),
      makeEntry({ title: "C" }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1, 2] }]);
    expect(result.entries).toHaveLength(1);
  });

  test("the first accepted overlapping proposal wins against stable input indices", () => {
    const entries = [
      makeEntry({ title: "A" }),
      makeEntry({ title: "B" }),
      makeEntry({ title: "C" }),
    ];

    const result = applyDuplicateMerges(entries, [
      { keep: 2, drop: [0] },
      { keep: 1, drop: [2] },
    ]);

    expect(result.entries.map((entry) => entry.title)).toEqual(["B", "C"]);
    expect(result).toMatchObject({
      mergedCount: 1,
      overlappingNoopCount: 1,
      unresolvedCount: 0,
    });
  });

  test("exposures sorted chronologically after merge", () => {
    const entries = [
      makeEntry({
        title: "A",
        exposures: [{ date: "2026-02-11", sessionHash: "late0000" }],
      }),
      makeEntry({
        title: "B",
        exposures: [{ date: "2026-02-09", sessionHash: "early000" }],
      }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1] }]);
    expect(result.entries[0]?.exposures[0]?.date).toBe("2026-02-09");
    expect(result.entries[0]?.exposures[1]?.date).toBe("2026-02-11");
  });

  test("duplicate merges combine promotion evidence deterministically", () => {
    const automatic = promoteToGlobal(
      makeEntry({
        title: "Automatic",
        cwds: testCwds("/z", "/b", "/a"),
        exposures: [{ date: "2026-02-11", sessionHash: "late0000" }],
      }),
      "automatic-cross-project-threshold",
    );
    const manual = promoteToGlobal(
      makeEntry({
        title: "Manual",
        cwds: testCwds("/d", "/c", "/b"),
        exposures: [{ date: "2026-02-09", sessionHash: "early000" }],
      }),
      "manual-cross-project-review",
    );

    const result = applyDuplicateMerges([automatic, manual], [{ keep: 0, drop: [1] }]);

    expect(result.entries[0]?.cwds).toEqual(["*"]);
    expect(result.entries[0]?.promotionEvidence).toEqual({
      sourceCwds: testCwds("/a", "/b", "/c", "/d", "/z"),
      excludedCwds: [],
      exposures: [
        { date: "2026-02-09", sessionHash: "early000" },
        { date: "2026-02-11", sessionHash: "late0000" },
      ],
      reasons: ["automatic-cross-project-threshold", "manual-cross-project-review"],
    });
  });

  test("exclusions prevent an evidence-free global from dominating known positive scopes", () => {
    const global = makeEntry({ title: "Global", cwds: ["*"] });
    const corrected = {
      ...makeEntry({
        title: "Corrected",
        cwds: testCwds("/company-a/project-1", "/company-a/project-2"),
      }),
      promotionEvidence: {
        sourceCwds: testCwds("/company-a/project-1", "/company-a/project-2"),
        excludedCwds: testCwds("/company-b/project-x"),
        exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
        reasons: ["manual-scope-correction" as const],
      },
    };

    const result = applyDuplicateMerges([global, corrected], [{ keep: 0, drop: [1] }]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.cwds).toEqual(
      testCwds("/company-a/project-1", "/company-a/project-2"),
    );
    expect(result.entries[0]?.promotionEvidence).toEqual(corrected.promotionEvidence);
    expect(result).toMatchObject({ mergedCount: 1, scopeNarrowedCount: 1 });
  });

  test("an evidence-free scoped duplicate contributes its active paths as positive evidence", () => {
    const corrected = {
      ...makeEntry({ title: "Corrected", cwds: testCwds("/company-a/project-1") }),
      promotionEvidence: {
        sourceCwds: testCwds("/company-a/project-1"),
        excludedCwds: testCwds("/company-b/project-x"),
        exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
        reasons: ["manual-scope-correction" as const],
      },
    };
    const ordinary = makeEntry({ title: "Ordinary", cwds: testCwds("/company-a/project-2") });

    const result = applyDuplicateMerges([corrected, ordinary], [{ keep: 0, drop: [1] }]);

    expect(result.entries[0]?.promotionEvidence?.sourceCwds).toEqual(
      testCwds("/company-a/project-1", "/company-a/project-2"),
    );
    expect(result.entries[0]?.cwds).toEqual(
      testCwds("/company-a/project-1", "/company-a/project-2"),
    );
  });

  test("duplicate merging preserves compatible source and exclusion evidence from every member", () => {
    const entryA = {
      ...makeEntry({ title: "A", cwds: testCwds("/company-a/project-1") }),
      promotionEvidence: {
        sourceCwds: testCwds("/company-a/project-1"),
        excludedCwds: testCwds("/company-b/project-1"),
        exposures: [],
        reasons: ["manual-scope-correction" as const],
      },
    };
    const entryB = {
      ...makeEntry({ title: "B", cwds: testCwds("/company-a/project-2") }),
      promotionEvidence: {
        sourceCwds: testCwds("/company-a/project-2"),
        excludedCwds: testCwds("/company-c/project-1"),
        exposures: [],
        reasons: ["contradiction-scope-subtraction" as const],
      },
    };

    const result = applyDuplicateMerges([entryA, entryB], [{ keep: 0, drop: [1] }]);

    expect(result.entries[0]?.promotionEvidence).toMatchObject({
      sourceCwds: testCwds("/company-a/project-1", "/company-a/project-2"),
      excludedCwds: testCwds("/company-b/project-1", "/company-c/project-1"),
      reasons: ["contradiction-scope-subtraction", "manual-scope-correction"],
    });
  });

  test("nonglobal vetoes an evidence-free wildcard without synthesizing evidence", () => {
    const global = makeEntry({ title: "Global", cwds: ["*"] });
    const scoped = makeEntry({
      title: "Scoped",
      cwds: testCwds("/company-a/project-1"),
      nonglobal: true,
    });

    const result = applyDuplicateMerges([global, scoped], [{ keep: 0, drop: [1] }]);

    expect(result.entries[0]).toMatchObject({
      cwds: testCwds("/company-a/project-1"),
      nonglobal: true,
    });
    expect(result.entries[0]?.promotionEvidence).toBeUndefined();
    expect(result.scopeNarrowedCount).toBe(1);
  });

  test("a merge with no effective positive source is unresolved and preserves both entries", () => {
    const entryA = {
      ...makeEntry({ title: "A", cwds: testCwds("/a") }),
      promotionEvidence: {
        sourceCwds: testCwds("/a"),
        excludedCwds: testCwds("/b"),
        exposures: [],
        reasons: ["manual-scope-correction" as const],
      },
    };
    const entryB = {
      ...makeEntry({ title: "B", cwds: testCwds("/b") }),
      promotionEvidence: {
        sourceCwds: testCwds("/b"),
        excludedCwds: testCwds("/a"),
        exposures: [],
        reasons: ["manual-scope-correction" as const],
      },
    };

    const result = applyDuplicateMerges([entryA, entryB], [{ keep: 0, drop: [1] }]);

    expect(result.entries).toEqual([entryA, entryB]);
    expect(result).toMatchObject({ mergedCount: 0, unresolvedCount: 1 });
  });
});

// --- Contradiction Detection ---

describe("buildContradictionPrompt", () => {
  test("numbers entries starting at [1]", () => {
    const entries = [makeEntry({ title: "A" }), makeEntry({ title: "B" })];
    const prompt = buildContradictionPrompt(entries);
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });

  test("does not include CWDs or exposures", () => {
    const prompt = buildContradictionPrompt([makeEntry({ cwds: testCwds("/secret") })]);
    expect(prompt).not.toContain(testCwd("/secret"));
  });
});

describe("parseContradictionOutput", () => {
  test("parses contradiction pair to 0-indexed", () => {
    const pairs = parseContradictionOutput("[2] CONTRADICTS [3] — opposite advice");
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe(1);
    expect(pairs[0]?.b).toBe(2);
  });

  test("NO CONTRADICTIONS returns empty array", () => {
    expect(parseContradictionOutput("NO CONTRADICTIONS")).toEqual([]);
  });

  test("malformed lines are skipped", () => {
    const pairs = parseContradictionOutput("garbage\n[1] CONTRADICTS [2] — ok");
    expect(pairs).toHaveLength(1);
  });
});

describe("resolveContradictions", () => {
  test("partial CWD overlap: older loses overlapping CWDs", () => {
    const entries = [
      makeEntry({
        title: "Use tabs",
        cwds: testCwds("/shaka", "/myapp"),
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: testCwds("/myapp", "/tools"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.cwds).toEqual(testCwds("/shaka"));
    expect(result.entries[0]?.promotionEvidence).toMatchObject({
      sourceCwds: testCwds("/myapp", "/shaka"),
      excludedCwds: testCwds("/myapp"),
      reasons: ["contradiction-scope-subtraction"],
    });
    expect(result.entries[1]?.cwds).toEqual(testCwds("/myapp", "/tools"));
    expect(result).toMatchObject({
      resolvedCount: 1,
      unresolvedCount: 0,
      overlappingNoopCount: 0,
    });
  });

  test("full CWD overlap: older removed entirely", () => {
    const entries = [
      makeEntry({
        title: "Use tabs",
        cwds: testCwds("/shaka"),
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: testCwds("/shaka"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("Use spaces");
  });

  test("global vs specific (specific newer): global removed", () => {
    const entries = [
      makeEntry({
        title: "Always semicolons",
        cwds: ["*"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "No semicolons",
        cwds: testCwds("/shaka"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("No semicolons");
    expect(result.resolvedCount).toBe(1);
  });

  test("an older global narrows from its known positive sources", () => {
    const global = {
      ...makeEntry({
        title: "Always semicolons",
        cwds: ["*"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      promotionEvidence: {
        sourceCwds: testCwds("/company/a", "/company/b"),
        excludedCwds: [],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
        reasons: ["manual-global-review" as const],
      },
    };
    const newer = makeEntry({
      title: "No semicolons",
      cwds: testCwds("/company/a"),
      exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
    });

    const result = resolveContradictions([global, newer], [{ a: 0, b: 1 }]);

    expect(result.entries[0]?.cwds).toEqual(testCwds("/company/b"));
    expect(result.entries[0]?.promotionEvidence?.excludedCwds).toEqual(testCwds("/company/a"));
    expect(result.resolvedCount).toBe(1);
  });

  test("global vs specific (global newer): specific removed", () => {
    const entries = [
      makeEntry({
        title: "No semicolons",
        cwds: testCwds("/shaka"),
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Always semicolons",
        cwds: ["*"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("Always semicolons");
  });

  test("global vs global: older removed", () => {
    const entries = [
      makeEntry({
        title: "Tabs everywhere",
        cwds: ["*"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Spaces everywhere",
        cwds: ["*"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("Spaces everywhere");
  });

  test("no CWD overlap: both unchanged (false positive safe)", () => {
    const entries = [
      makeEntry({
        title: "Use Bun",
        cwds: testCwds("/shaka"),
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "Use Result",
        cwds: testCwds("/tools"),
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toEqual(entries);
    expect(result.resolvedCount).toBe(0);
  });

  test("a newer child scope narrows an older ancestor using known positive evidence", () => {
    const entries = [
      {
        ...makeEntry({
          title: "Use tabs",
          cwds: testCwds("/work/company"),
          exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
        }),
        promotionEvidence: {
          sourceCwds: testCwds("/work/company/project-a", "/work/company/project-b"),
          excludedCwds: [],
          exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
          reasons: ["manual-common-ancestor-review" as const],
        },
      },
      makeEntry({
        title: "Use spaces",
        cwds: testCwds("/work/company/project-a"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];

    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);

    expect(result.entries[0]?.cwds).toEqual(testCwds("/work/company/project-b"));
    expect(result.entries[0]?.promotionEvidence?.excludedCwds).toEqual(
      testCwds("/work/company/project-a"),
    );
    expect(result.resolvedCount).toBe(1);
  });

  test("multi-root subtraction applies every related newer root and ignores unrelated roots", () => {
    const older = makeEntry({
      title: "Older",
      cwds: testCwds("/company/a", "/company/b", "/company/c"),
      exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
    });
    const newer = makeEntry({
      title: "Newer",
      cwds: testCwds("/company/a", "/company/b", "/unrelated/x"),
      exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
    });

    const result = resolveContradictions([older, newer], [{ a: 0, b: 1 }]);

    expect(result.entries[0]?.cwds).toEqual(testCwds("/company/c"));
    expect(result.entries[0]?.promotionEvidence?.excludedCwds).toEqual(
      testCwds("/company/a", "/company/b"),
    );
    expect(result.entries[0]?.promotionEvidence?.reasons).toContain(
      "contradiction-scope-subtraction",
    );
  });

  test("an invalid pair is atomic and claims no input indices", () => {
    const entries = [
      makeEntry({
        title: "Older",
        cwds: testCwds("/same"),
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Newer",
        cwds: testCwds("/same"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [
      { a: 0, b: 99 },
      { a: 0, b: 1 },
    ]);

    expect(result.entries.map((entry) => entry.title)).toEqual(["Newer"]);
    expect(result).toMatchObject({ resolvedCount: 1, unresolvedCount: 1 });
  });

  test("the first accepted overlapping contradiction wins against stable input indices", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/same"),
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/same"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
      makeEntry({
        title: "C",
        cwds: testCwds("/same"),
        exposures: [{ date: "2026-02-12", sessionHash: "newer000" }],
      }),
    ];

    const result = resolveContradictions(entries, [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ]);

    expect(result.entries.map((entry) => entry.title)).toEqual(["B", "C"]);
    expect(result).toMatchObject({
      resolvedCount: 1,
      overlappingNoopCount: 1,
      unresolvedCount: 0,
    });
  });

  test("preserves original entry ordering", () => {
    const entries = [
      makeEntry({ title: "First", cwds: testCwds("/a") }),
      makeEntry({ title: "Second", cwds: testCwds("/b") }),
      makeEntry({ title: "Third", cwds: testCwds("/c") }),
    ];
    const result = resolveContradictions(entries, []);
    expect(result.entries[0]?.title).toBe("First");
    expect(result.entries[1]?.title).toBe("Second");
    expect(result.entries[2]?.title).toBe("Third");
  });

  test("nonglobal preserved on surviving entries", () => {
    const entries = [
      makeEntry({
        title: "Use tabs",
        cwds: testCwds("/shaka", "/myapp"),
        nonglobal: true,
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: testCwds("/myapp"),
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries[0]?.nonglobal).toBe(true);
  });

  test("same-date tiebreak: more exposures wins, then B wins", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/x"),
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/x"),
        exposures: [{ date: "2026-02-09", sessionHash: "bbbb0000" }],
      }),
    ];
    // Same date, same exposure count — B wins (A is removed)
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("B");
  });
});

// --- Condensation: Cluster Detection ---

describe("groupByCwd", () => {
  test("entries with same CWD are grouped together", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/projects/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/projects/myapp") }),
      makeEntry({ title: "C", cwds: testCwds("/projects/other") }),
    ];
    const groups = groupByCwd(entries);
    const myappGroup = groups.get(testCwd("/projects/myapp"));

    expect(myappGroup).toBeDefined();
    expect(myappGroup).toHaveLength(2);
    expect(myappGroup![0]!.title).toBe("A");
    expect(myappGroup![1]!.title).toBe("B");
  });

  test("multi-CWD entries appear in multiple groups", () => {
    const entries = [
      makeEntry({ title: "Shared", cwds: testCwds("/proj-a", "/proj-b") }),
      makeEntry({ title: "Only A", cwds: testCwds("/proj-a") }),
    ];
    const groups = groupByCwd(entries);

    expect(groups.get(testCwd("/proj-a"))).toHaveLength(2);
    expect(groups.get(testCwd("/proj-b"))).toHaveLength(1);
    expect(groups.get(testCwd("/proj-b"))![0]!.title).toBe("Shared");
  });

  test("global entries are excluded from all groups even with legacy mixed scopes", () => {
    const entries = [
      {
        ...makeEntry({ title: "Global", cwds: ["*", testCwd("/proj-a")] }),
        promotionEvidence: {
          sourceCwds: testCwds("/proj-a", "/proj-b", "/proj-c"),
          excludedCwds: [],
          exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
          reasons: ["automatic-cross-project-threshold" as const],
        },
      },
      makeEntry({ title: "Scoped", cwds: testCwds("/proj-a") }),
    ];
    const groups = groupByCwd(entries);

    expect(groups.has("*")).toBe(false);
    expect(groups.size).toBe(1);
    expect(groups.get(testCwd("/proj-a"))).toHaveLength(1);
  });
});

describe("findCondensationCandidates", () => {
  test("entries with 2+ exposures in same CWD form a candidate", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];
    const candidates = findCondensationCandidates(entries);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.cwd).toBe(testCwd("/myapp"));
    expect(candidates[0]!.entries).toHaveLength(2);
  });

  test("entries with < 2 exposures are excluded", () => {
    const entries = [
      makeEntry({
        title: "High",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        title: "Low",
        cwds: testCwds("/myapp"),
        exposures: [{ date: "2026-03-02", sessionHash: "cccc0000" }],
      }),
    ];
    const candidates = findCondensationCandidates(entries);

    // Only 1 high-exposure entry, need CLUSTER_MIN=2
    expect(candidates).toHaveLength(0);
  });

  test("returns empty for sparse data across many CWDs", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        title: `Entry ${i}`,
        cwds: testCwds(`/project-${i}`),
        exposures: [{ date: "2026-03-01", sessionHash: `hash${i}000` }],
      }),
    );
    expect(findCondensationCandidates(entries)).toHaveLength(0);
  });

  test("multi-CWD entries appear in each CWD group", () => {
    const shared = makeEntry({
      title: "Shared",
      cwds: testCwds("/proj-a", "/proj-b"),
      exposures: [
        { date: "2026-03-01", sessionHash: "aaaa0000" },
        { date: "2026-03-05", sessionHash: "bbbb0000" },
      ],
    });
    const onlyA = makeEntry({
      title: "Only A",
      cwds: testCwds("/proj-a"),
      exposures: [
        { date: "2026-03-02", sessionHash: "cccc0000" },
        { date: "2026-03-06", sessionHash: "dddd0000" },
      ],
    });
    const onlyB = makeEntry({
      title: "Only B",
      cwds: testCwds("/proj-b"),
      exposures: [
        { date: "2026-03-03", sessionHash: "eeee0000" },
        { date: "2026-03-07", sessionHash: "ffff0000" },
      ],
    });
    const candidates = findCondensationCandidates([shared, onlyA, onlyB]);

    expect(candidates).toHaveLength(2);
    const cwds = candidates.map((c) => c.cwd).sort();
    expect(cwds).toEqual(testCwds("/proj-a", "/proj-b"));
  });

  test("indices track original positions in the entries array", () => {
    const entries = [
      makeEntry({ title: "Filler", cwds: testCwds("/other") }),
      makeEntry({
        title: "A",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-01", sessionHash: "aaaa0000" },
          { date: "2026-03-05", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({ title: "Filler2", cwds: testCwds("/other2") }),
      makeEntry({
        title: "B",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-02", sessionHash: "cccc0000" },
          { date: "2026-03-06", sessionHash: "dddd0000" },
        ],
      }),
    ];
    const candidates = findCondensationCandidates(entries);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.indices).toEqual([1, 3]);
  });
});

// --- Condensation: Prompt Building & Parsing ---

describe("buildCondensationPrompt", () => {
  test("numbers entries starting at [1] with category and content", () => {
    const entries = [
      makeEntry({
        title: "Use Factories",
        category: "pattern",
        body: "Build test data with factories.",
      }),
      makeEntry({
        title: "Hit Real DB",
        category: "correction",
        body: "Mocked tests masked a bug.",
      }),
    ];
    const prompt = buildCondensationPrompt(entries);

    expect(prompt).toContain("[1] (pattern) Use Factories");
    expect(prompt).toContain("Build test data with factories.");
    expect(prompt).toContain("[2] (correction) Hit Real DB");
    expect(prompt).toContain("Mocked tests masked a bug.");
  });

  test("says '2+' for minimum cluster size", () => {
    const prompt = buildCondensationPrompt([makeEntry()]);
    expect(prompt).toContain("2+");
    expect(prompt).not.toContain("3+");
  });

  test("does not include CWDs or exposures", () => {
    const prompt = buildCondensationPrompt([
      makeEntry({
        cwds: testCwds("/secret/path"),
        exposures: [{ date: "2026-03-01", sessionHash: "abcd1234" }],
      }),
    ]);
    expect(prompt).not.toContain(testCwd("/secret/path"));
    expect(prompt).not.toContain("abcd1234");
  });
});

describe("parseCondensationOutput", () => {
  test("parses CLUSTER/TITLE/BODY to 0-based indices", () => {
    const raw = `CLUSTER [1, 3] — Testing discipline
TITLE: Testing Philosophy
BODY: Use real DB in tests. Factories over fixtures.`;

    const clusters = parseCondensationOutput(raw);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.indices).toEqual([0, 2]); // 1-based → 0-based
    expect(clusters[0]!.label).toBe("Testing discipline");
    expect(clusters[0]!.title).toBe("Testing Philosophy");
    expect(clusters[0]!.body).toBe("Use real DB in tests. Factories over fixtures.");
  });

  test("handles multi-line BODY text", () => {
    const raw = `CLUSTER [1, 2] — Testing
TITLE: Testing Philosophy
BODY: Integration tests against real DB (mocks masked a migration bug).
Test files in tests/, data built with factories not fixtures.
Run tests locally before every commit.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.body).toContain("Integration tests against real DB");
    expect(clusters[0]!.body).toContain("Run tests locally before every commit.");
  });

  test("NO CLUSTERS returns empty array", () => {
    expect(parseCondensationOutput("NO CLUSTERS")).toEqual([]);
  });

  test("malformed lines are skipped, valid clusters returned", () => {
    const raw = `Some preamble text
CLUSTER [1, 2] — Good cluster
TITLE: Valid Title
BODY: Valid body.
This line has no format
CLUSTER badformat
CLUSTER [3, 4] — Another good cluster
TITLE: Another Title
BODY: Another body.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.title).toBe("Valid Title");
    expect(clusters[1]!.title).toBe("Another Title");
  });

  test("new CLUSTER line flushes previous cluster", () => {
    const raw = `CLUSTER [1, 2] — First
TITLE: First Title
BODY: First body line 1.
First body line 2.
CLUSTER [3, 4] — Second
TITLE: Second Title
BODY: Second body.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.body).toBe("First body line 1.\nFirst body line 2.");
    expect(clusters[1]!.body).toBe("Second body.");
  });

  test("cluster without TITLE is skipped", () => {
    const raw = `CLUSTER [1, 2] — No title here
BODY: Body without title.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(0);
  });

  test("handles em-dash, en-dash, and hyphen in CLUSTER line", () => {
    const raw = `CLUSTER [1, 2] — em-dash topic
TITLE: Em Dash Title
BODY: Em dash body.
CLUSTER [3, 4] – en-dash topic
TITLE: En Dash Title
BODY: En dash body.
CLUSTER [5, 6] - hyphen topic
TITLE: Hyphen Title
BODY: Hyphen body.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(3);
    expect(clusters[0]!.label).toBe("em-dash topic");
    expect(clusters[1]!.label).toBe("en-dash topic");
    expect(clusters[2]!.label).toBe("hyphen topic");
  });

  test("blank lines between clusters are handled", () => {
    const raw = `CLUSTER [1, 2] — First
TITLE: First Title
BODY: First body.

CLUSTER [3, 4] — Second
TITLE: Second Title
BODY: Second body.`;

    const clusters = parseCondensationOutput(raw);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.body).toBe("First body.");
    expect(clusters[1]!.body).toBe("Second body.");
  });

  test("cluster with single index is parsed but has fewer than CLUSTER_MIN", () => {
    const raw = `CLUSTER [1] — Solo
TITLE: Solo Title
BODY: Solo body.`;

    const clusters = parseCondensationOutput(raw);
    // Parser produces the cluster; downstream resolveClusterIndices rejects it
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.indices).toEqual([0]);
  });
});

// --- Condensation: Apply ---

describe("applyCondensation", () => {
  test("category tiebreak: pattern > correction > preference > fact", () => {
    const entries = [
      makeEntry({ title: "A", category: "fact", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", category: "correction", cwds: testCwds("/myapp") }),
      makeEntry({ title: "C", category: "pattern", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1, 2] },
      clusters: [{ indices: [0, 1, 2], label: "Testing", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.category).toBe("pattern");
  });

  test("compound gets single CWD from candidate, not union", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp", "/other") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    // Compound should have only the candidate CWD
    const compound = result.entries.find((e) => e.title === "Compound");
    expect(compound).toBeDefined();
    expect(compound!.cwds).toEqual(testCwds("/myapp"));
  });

  test("evidence-bearing and nonglobal entries never become condensation candidates", () => {
    const repeatedExposures = [
      { date: "2026-03-01", sessionHash: "aaaa0000" },
      { date: "2026-03-05", sessionHash: "bbbb0000" },
    ];
    const evidenceBearing = {
      ...makeEntry({
        title: "Reviewed A",
        cwds: testCwds("/myapp"),
        exposures: repeatedExposures,
      }),
      promotionEvidence: {
        sourceCwds: testCwds("/myapp"),
        excludedCwds: [],
        exposures: [{ date: "2026-03-01", sessionHash: "aaaa0000" }],
        reasons: ["manual-cross-project-review" as const],
      },
    };
    const nonglobal = makeEntry({
      title: "Reviewed B",
      cwds: testCwds("/myapp"),
      exposures: repeatedExposures,
      nonglobal: true,
    });
    const ordinaryA = makeEntry({
      title: "Ordinary A",
      cwds: testCwds("/myapp"),
      exposures: repeatedExposures,
    });
    const ordinaryB = makeEntry({
      title: "Ordinary B",
      cwds: testCwds("/myapp"),
      exposures: repeatedExposures,
    });

    const candidates = findCondensationCandidates([
      evidenceBearing,
      nonglobal,
      ordinaryA,
      ordinaryB,
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.entries.map((entry) => entry.title)).toEqual([
      "Ordinary A",
      "Ordinary B",
    ]);
    expect(candidates[0]?.indices).toEqual([2, 3]);
  });

  test("application rejects a manually supplied cluster containing durable scope state", () => {
    const evidenceBearing = {
      ...makeEntry({ title: "Reviewed", cwds: testCwds("/myapp") }),
      promotionEvidence: {
        sourceCwds: testCwds("/myapp"),
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-cross-project-review" as const],
      },
    };
    const ordinary = makeEntry({ title: "Ordinary", cwds: testCwds("/myapp") });
    const candidate: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries: [evidenceBearing, ordinary], indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };

    const result = applyCondensation([evidenceBearing, ordinary], [candidate]);

    expect(result.entries).toEqual([evidenceBearing, ordinary]);
    expect(result.archived).toEqual([]);
    expect(result.compoundsCreated).toBe(0);
  });

  test("removes single-CWD sources and adds them to archived", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.title).toBe("Compound");
    expect(result.archived).toHaveLength(2);
    expect(result.archived[0]!.title).toBe("A");
    expect(result.archived[1]!.title).toBe("B");
  });

  test("narrows multi-CWD sources instead of removing", () => {
    const entries = [
      makeEntry({ title: "Shared", cwds: testCwds("/myapp", "/other") }),
      makeEntry({ title: "Local", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    // Compound at index 0, narrowed "Shared" survives with ["/other"]
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.title).toBe("Compound");
    const narrowed = result.entries.find((e) => e.title === "Shared");
    expect(narrowed).toBeDefined();
    expect(narrowed!.cwds).toEqual(testCwds("/other"));
  });

  test("merges exposures deduped and sorted chronologically", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-10", sessionHash: "late0000" },
          { date: "2026-03-01", sessionHash: "shared00" },
        ],
      }),
      makeEntry({
        title: "B",
        cwds: testCwds("/myapp"),
        exposures: [
          { date: "2026-03-05", sessionHash: "mid00000" },
          { date: "2026-03-01", sessionHash: "shared00" }, // duplicate
        ],
      }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    const compound = result.entries[0]!;
    expect(compound.exposures).toHaveLength(3); // deduped from 4 to 3
    expect(compound.exposures[0]!.date).toBe("2026-03-01");
    expect(compound.exposures[1]!.date).toBe("2026-03-05");
    expect(compound.exposures[2]!.date).toBe("2026-03-10");
  });

  test("non-overlapping clusters from same candidate both applied", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
      makeEntry({ title: "C", cwds: testCwds("/myapp") }),
      makeEntry({ title: "D", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1, 2, 3] },
      clusters: [
        { indices: [0, 1], label: "First", title: "Compound 1", body: "Body 1." },
        { indices: [2, 3], label: "Second", title: "Compound 2", body: "Body 2." },
      ],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries).toHaveLength(2);
    expect(result.compoundsCreated).toBe(2);
    expect(result.entries[0]!.title).toBe("Compound 1");
    expect(result.entries[1]!.title).toBe("Compound 2");
  });

  test("overlapping clusters: first cluster wins, second skips overlap", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
      makeEntry({ title: "C", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1, 2] },
      clusters: [
        { indices: [0, 1], label: "First", title: "Compound 1", body: "Body 1." },
        { indices: [1, 2], label: "Second", title: "Compound 2", body: "Body 2." },
      ],
    };
    const result = applyCondensation(entries, [cwc]);

    // Second cluster has overlap on index 1, so it's skipped entirely
    expect(result.compoundsCreated).toBe(1);
    expect(result.entries[0]!.title).toBe("Compound 1");
    // Entry C survives since second cluster was skipped
    expect(result.entries.find((e) => e.title === "C")).toBeDefined();
  });

  test("insertion ordering: compound appears at position of first source", () => {
    const entries = [
      makeEntry({ title: "Keep First", cwds: testCwds("/other") }),
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "Keep Middle", cwds: testCwds("/other") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
      makeEntry({ title: "Keep Last", cwds: testCwds("/other") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries: [entries[1]!, entries[3]!], indices: [1, 3] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries.map((e) => e.title)).toEqual([
      "Keep First",
      "Compound",
      "Keep Middle",
      "Keep Last",
    ]);
  });

  test("returns complete CondensationResult with all fields", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
      makeEntry({ title: "Untouched", cwds: testCwds("/other") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries: [entries[0]!, entries[1]!], indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries).toHaveLength(2); // compound + untouched
    expect(result.archived).toHaveLength(2); // A and B
    expect(result.compoundsCreated).toBe(1);
  });

  test("nonglobal source prevents the entire condensation cluster", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp"), nonglobal: false }),
      makeEntry({ title: "B", cwds: testCwds("/myapp"), nonglobal: true }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    expect(result.entries).toEqual(entries);
    expect(result.archived).toEqual([]);
    expect(result.compoundsCreated).toBe(0);
  });

  test("multi-CWD entry processed by two candidates: both compounds preserved", () => {
    // Entry 0 has cwds=["/proj-a", "/proj-b"] and appears in both candidate groups.
    // Each candidate produces a cluster involving entry 0.
    // Per the narrowing design: entry 0 is condensed for /proj-a first (narrowed
    // to /proj-b), then condensed again for /proj-b (fully consumed).
    // Both compounds must survive — they represent the entry's knowledge
    // scoped to each project independently.
    const entries = [
      makeEntry({ title: "Shared", cwds: testCwds("/proj-a", "/proj-b") }),
      makeEntry({ title: "A-only", cwds: testCwds("/proj-a") }),
      makeEntry({ title: "B-only", cwds: testCwds("/proj-b") }),
    ];

    const candidatesWithClusters: CandidateWithClusters[] = [
      {
        candidate: {
          cwd: testCwd("/proj-a"),
          entries: [entries[0]!, entries[1]!],
          indices: [0, 1],
        },
        clusters: [
          { indices: [0, 1], label: "A-topic", title: "Compound A", body: "From proj-a." },
        ],
      },
      {
        candidate: {
          cwd: testCwd("/proj-b"),
          entries: [entries[0]!, entries[2]!],
          indices: [0, 2],
        },
        clusters: [
          { indices: [0, 1], label: "B-topic", title: "Compound B", body: "From proj-b." },
        ],
      },
    ];

    const result = applyCondensation(entries, candidatesWithClusters);

    // Both compounds created — each scoped to its own CWD
    expect(result.compoundsCreated).toBe(2);
    expect(result.entries.find((e) => e.title === "Compound A")).toBeDefined();
    expect(result.entries.find((e) => e.title === "Compound B")).toBeDefined();
    // Compound A scoped to /proj-a, Compound B scoped to /proj-b
    expect(result.entries.find((e) => e.title === "Compound A")!.cwds).toEqual(testCwds("/proj-a"));
    expect(result.entries.find((e) => e.title === "Compound B")!.cwds).toEqual(testCwds("/proj-b"));
    // Entry 0 fully consumed (narrowed by first, consumed by second)
    expect(result.entries.find((e) => e.title === "Shared")).toBeUndefined();
  });

  test("empty candidatesWithClusters returns entries unchanged", () => {
    const entries = [makeEntry({ title: "A" }), makeEntry({ title: "B" })];
    const result = applyCondensation(entries, []);

    expect(result.entries).toHaveLength(2);
    expect(result.archived).toHaveLength(0);
    expect(result.compoundsCreated).toBe(0);
  });

  test("3-CWD entry narrowed by two candidates survives with 1 remaining CWD", () => {
    const entries = [
      makeEntry({ title: "Shared", cwds: testCwds("/proj-a", "/proj-b", "/proj-c") }),
      makeEntry({ title: "A-only", cwds: testCwds("/proj-a") }),
      makeEntry({ title: "B-only", cwds: testCwds("/proj-b") }),
    ];

    const candidatesWithClusters: CandidateWithClusters[] = [
      {
        candidate: {
          cwd: testCwd("/proj-a"),
          entries: [entries[0]!, entries[1]!],
          indices: [0, 1],
        },
        clusters: [
          { indices: [0, 1], label: "A-topic", title: "Compound A", body: "From proj-a." },
        ],
      },
      {
        candidate: {
          cwd: testCwd("/proj-b"),
          entries: [entries[0]!, entries[2]!],
          indices: [0, 2],
        },
        clusters: [
          { indices: [0, 1], label: "B-topic", title: "Compound B", body: "From proj-b." },
        ],
      },
    ];

    const result = applyCondensation(entries, candidatesWithClusters);

    expect(result.compoundsCreated).toBe(2);
    // Shared entry survives with only /proj-c
    const shared = result.entries.find((e) => e.title === "Shared");
    expect(shared).toBeDefined();
    expect(shared!.cwds).toEqual(testCwds("/proj-c"));
  });

  test("multi-CWD entry processed by multiple candidates is archived only once", () => {
    const entries = [
      makeEntry({ title: "Shared", cwds: testCwds("/proj-a", "/proj-b") }),
      makeEntry({ title: "A-only", cwds: testCwds("/proj-a") }),
      makeEntry({ title: "B-only", cwds: testCwds("/proj-b") }),
    ];

    const candidatesWithClusters: CandidateWithClusters[] = [
      {
        candidate: {
          cwd: testCwd("/proj-a"),
          entries: [entries[0]!, entries[1]!],
          indices: [0, 1],
        },
        clusters: [{ indices: [0, 1], label: "A-topic", title: "Compound A", body: "A." }],
      },
      {
        candidate: {
          cwd: testCwd("/proj-b"),
          entries: [entries[0]!, entries[2]!],
          indices: [0, 2],
        },
        clusters: [{ indices: [0, 1], label: "B-topic", title: "Compound B", body: "B." }],
      },
    ];

    const result = applyCondensation(entries, candidatesWithClusters);

    // Shared entry should appear exactly once in archived (not duplicated)
    const archivedShared = result.archived.filter((e) => e.title === "Shared");
    expect(archivedShared).toHaveLength(1);
  });

  test("single-CWD entry exhausted by condensation is fully removed", () => {
    const entries = [
      makeEntry({ title: "A", cwds: testCwds("/myapp") }),
      makeEntry({ title: "B", cwds: testCwds("/myapp") }),
    ];
    const cwc: CandidateWithClusters = {
      candidate: { cwd: testCwd("/myapp"), entries, indices: [0, 1] },
      clusters: [{ indices: [0, 1], label: "Topic", title: "Compound", body: "Body." }],
    };
    const result = applyCondensation(entries, [cwc]);

    // No entry with empty cwds should exist
    const emptyCwds = result.entries.filter((e) => e.cwds.length === 0);
    expect(emptyCwds).toHaveLength(0);
    // Original entries fully removed
    expect(result.entries.find((e) => e.title === "A")).toBeUndefined();
    expect(result.entries.find((e) => e.title === "B")).toBeUndefined();
  });
});
