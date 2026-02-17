import { describe, expect, test } from "bun:test";
import {
  applyDuplicateMerges,
  buildContradictionPrompt,
  buildDuplicatePrompt,
  parseContradictionOutput,
  parseDuplicateOutput,
  resolveContradictions,
} from "../../../src/memory/consolidation";
import type { LearningEntry } from "../../../src/memory/learnings";

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? ["/projects/myapp"],
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
    const prompt = buildDuplicatePrompt([makeEntry({ cwds: ["/secret/path"] })]);
    expect(prompt).not.toContain("/secret/path");
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
        cwds: ["/a"],
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "B",
        cwds: ["/b"],
        exposures: [{ date: "2026-02-10", sessionHash: "bbbb0000" }],
      }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1] }]);

    expect(result).toHaveLength(1);
    expect(result[0]?.cwds).toContain("/a");
    expect(result[0]?.cwds).toContain("/b");
    expect(result[0]?.exposures).toHaveLength(2);
  });

  test("nonglobal preserved if any source had it", () => {
    const entries = [
      makeEntry({ title: "A", nonglobal: false }),
      makeEntry({ title: "B", nonglobal: true }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1] }]);
    expect(result[0]?.nonglobal).toBe(true);
  });

  test("out-of-range index skips group", () => {
    const entries = [makeEntry()];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [99] }]);
    expect(result).toHaveLength(1);
  });

  test("result count equals original minus drops", () => {
    const entries = [
      makeEntry({ title: "A" }),
      makeEntry({ title: "B" }),
      makeEntry({ title: "C" }),
    ];
    const result = applyDuplicateMerges(entries, [{ keep: 0, drop: [1, 2] }]);
    expect(result).toHaveLength(1);
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
    expect(result[0]?.exposures[0]?.date).toBe("2026-02-09");
    expect(result[0]?.exposures[1]?.date).toBe("2026-02-11");
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
    const prompt = buildContradictionPrompt([makeEntry({ cwds: ["/secret"] })]);
    expect(prompt).not.toContain("/secret");
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
        cwds: ["/shaka", "/myapp"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: ["/myapp", "/tools"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);

    expect(result).toHaveLength(2);
    expect(result[0]?.cwds).toEqual(["/shaka"]);
    expect(result[1]?.cwds).toEqual(["/myapp", "/tools"]);
  });

  test("full CWD overlap: older removed entirely", () => {
    const entries = [
      makeEntry({
        title: "Use tabs",
        cwds: ["/shaka"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: ["/shaka"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Use spaces");
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
        cwds: ["/shaka"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("No semicolons");
  });

  test("global vs specific (global newer): specific removed", () => {
    const entries = [
      makeEntry({
        title: "No semicolons",
        cwds: ["/shaka"],
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Always semicolons",
        cwds: ["*"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Always semicolons");
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
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Spaces everywhere");
  });

  test("no CWD overlap: both unchanged (false positive safe)", () => {
    const entries = [
      makeEntry({
        title: "Use Bun",
        cwds: ["/shaka"],
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "Use Result",
        cwds: ["/tools"],
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result).toHaveLength(2);
  });

  test("out-of-range index: pair skipped", () => {
    const entries = [makeEntry()];
    const result = resolveContradictions(entries, [{ a: 0, b: 99 }]);
    expect(result).toHaveLength(1);
  });

  test("preserves original entry ordering", () => {
    const entries = [
      makeEntry({ title: "First", cwds: ["/a"] }),
      makeEntry({ title: "Second", cwds: ["/b"] }),
      makeEntry({ title: "Third", cwds: ["/c"] }),
    ];
    const result = resolveContradictions(entries, []);
    expect(result[0]?.title).toBe("First");
    expect(result[1]?.title).toBe("Second");
    expect(result[2]?.title).toBe("Third");
  });

  test("nonglobal preserved on surviving entries", () => {
    const entries = [
      makeEntry({
        title: "Use tabs",
        cwds: ["/shaka", "/myapp"],
        nonglobal: true,
        exposures: [{ date: "2026-02-09", sessionHash: "old00000" }],
      }),
      makeEntry({
        title: "Use spaces",
        cwds: ["/myapp"],
        exposures: [{ date: "2026-02-11", sessionHash: "new00000" }],
      }),
    ];
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result[0]?.nonglobal).toBe(true);
  });

  test("same-date tiebreak: more exposures wins, then B wins", () => {
    const entries = [
      makeEntry({
        title: "A",
        cwds: ["/x"],
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "B",
        cwds: ["/x"],
        exposures: [{ date: "2026-02-09", sessionHash: "bbbb0000" }],
      }),
    ];
    // Same date, same exposure count — B wins (A is removed)
    const result = resolveContradictions(entries, [{ a: 0, b: 1 }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("B");
  });
});
