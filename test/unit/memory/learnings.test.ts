import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import {
  type ContradictionPair,
  type DuplicateGroup,
  type LearningEntry,
  applyDuplicateMerges,
  buildContradictionPrompt,
  buildDuplicatePrompt,
  buildExtractionPromptSection,
  findPromotionCandidates,
  loadLearnings,
  markNonglobal,
  mergeNewLearnings,
  parseContradictionOutput,
  parseDuplicateOutput,
  parseExtractedLearnings,
  parseLearnings,
  promoteToGlobal,
  renderEntry,
  renderLearnings,
  resolveContradictions,
  scoreEntry,
  selectLearnings,
  undoSessionLearnings,
  writeLearnings,
} from "../../../src/memory/learnings";
import { hashSessionId } from "../../../src/memory/utils";

const testMemoryDir = "/tmp/shaka-test-learnings";

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

// --- parseLearnings ---

describe("parseLearnings", () => {
  test("empty string returns empty array", () => {
    expect(parseLearnings("")).toEqual([]);
  });

  test("whitespace-only returns empty array", () => {
    expect(parseLearnings("   \n  \n  ")).toEqual([]);
  });

  test("single entry parses all fields", () => {
    const content = `# Learnings

Automatically captured.

---

<!-- correction | cwd: /projects/myapp | exposures: 2026-02-09@a1b2c3d4 -->

### Use Bun.file() instead of fs.readFile()

This project uses Bun runtime.

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).toBe("correction");
    expect(entries[0]?.cwds).toEqual(["/projects/myapp"]);
    expect(entries[0]?.exposures).toEqual([{ date: "2026-02-09", sessionHash: "a1b2c3d4" }]);
    expect(entries[0]?.nonglobal).toBe(false);
    expect(entries[0]?.title).toBe("Use Bun.file() instead of fs.readFile()");
    expect(entries[0]?.body).toBe("This project uses Bun runtime.");
  });

  test("multiple entries parse correctly", () => {
    const content = `# Learnings

---

<!-- correction | cwd: /a | exposures: 2026-02-09@aaaa0000 -->

### Title A

Body A.

---

<!-- preference | cwd: /b | exposures: 2026-02-10@bbbb0000 -->

### Title B

Body B.

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.category).toBe("correction");
    expect(entries[1]?.category).toBe("preference");
  });

  test("multiple exposures parse in order", () => {
    const content = `---

<!-- pattern | cwd: /a | exposures: 2026-02-09@aaaa0000,2026-02-11@bbbb0000,2026-02-14@cccc0000 -->

### Multi exposure

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries[0]?.exposures).toHaveLength(3);
    expect(entries[0]?.exposures[0]?.date).toBe("2026-02-09");
    expect(entries[0]?.exposures[2]?.date).toBe("2026-02-14");
  });

  test("multiple CWDs parse correctly", () => {
    const content = `---

<!-- correction | cwd: /a,/b,/c | exposures: 2026-02-09@aaaa0000 -->

### Multi CWD

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries[0]?.cwds).toEqual(["/a", "/b", "/c"]);
  });

  test("nonglobal flag parses correctly", () => {
    const content = `---

<!-- fact | cwd: /a | exposures: 2026-02-09@aaaa0000 | nonglobal -->

### Nonglobal entry

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries[0]?.nonglobal).toBe(true);
  });

  test("global cwd parses correctly", () => {
    const content = `---

<!-- preference | cwd: * | exposures: 2026-02-09@aaaa0000 -->

### Global entry

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries[0]?.cwds).toEqual(["*"]);
  });

  test("malformed metadata is skipped gracefully", () => {
    const content = `---

<!-- not valid metadata -->

### Bad entry

Body.

---

<!-- correction | cwd: /a | exposures: 2026-02-09@aaaa0000 -->

### Good entry

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Good entry");
  });

  test("entry without body has empty body string", () => {
    const content = `---

<!-- correction | cwd: /a | exposures: 2026-02-09@aaaa0000 -->

### Title only

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe("");
  });
});

// --- renderEntry / renderLearnings ---

describe("renderEntry", () => {
  test("renders a complete entry", () => {
    const entry = makeEntry();
    const rendered = renderEntry(entry);

    expect(rendered).toContain(
      "<!-- correction | cwd: /projects/myapp | exposures: 2026-02-09@a1b2c3d4 -->",
    );
    expect(rendered).toContain("### Use Bun.file() instead of fs.readFile()");
    expect(rendered).toContain("This project uses Bun runtime.");
  });

  test("renders nonglobal flag", () => {
    const entry = makeEntry({ nonglobal: true });
    expect(renderEntry(entry)).toContain("| nonglobal -->");
  });

  test("renders multiple CWDs as comma-separated", () => {
    const entry = makeEntry({ cwds: ["/a", "/b", "/c"] });
    expect(renderEntry(entry)).toContain("cwd: /a, /b, /c");
  });

  test("renders multiple exposures as comma-separated", () => {
    const entry = makeEntry({
      exposures: [
        { date: "2026-02-09", sessionHash: "aaaa0000" },
        { date: "2026-02-11", sessionHash: "bbbb0000" },
      ],
    });
    expect(renderEntry(entry)).toContain("exposures: 2026-02-09@aaaa0000,2026-02-11@bbbb0000");
  });
});

describe("renderLearnings", () => {
  test("includes file header", () => {
    const result = renderLearnings([]);
    expect(result).toContain("# Learnings");
    expect(result).toContain("Automatically captured");
  });

  test("round-trip: parse(render(entries)) equals original", () => {
    const entries = [
      makeEntry({ title: "Entry A", body: "Body A." }),
      makeEntry({
        category: "preference",
        title: "Entry B",
        body: "Body B.",
        cwds: ["*"],
        exposures: [
          { date: "2026-02-09", sessionHash: "aaaa0000" },
          { date: "2026-02-11", sessionHash: "bbbb0000" },
        ],
      }),
      makeEntry({
        category: "fact",
        title: "Entry C",
        body: "Body C.",
        nonglobal: true,
        cwds: ["/x", "/y", "/z"],
      }),
    ];

    const rendered = renderLearnings(entries);
    const parsed = parseLearnings(rendered);

    expect(parsed).toHaveLength(3);
    for (let i = 0; i < entries.length; i++) {
      expect(parsed[i]?.title).toBe(entries[i]?.title);
      expect(parsed[i]?.body).toBe(entries[i]?.body);
      expect(parsed[i]?.category).toBe(entries[i]?.category);
      expect(parsed[i]?.cwds).toEqual(entries[i]?.cwds);
      expect(parsed[i]?.exposures).toEqual(entries[i]?.exposures);
      expect(parsed[i]?.nonglobal).toBe(entries[i]?.nonglobal);
    }
  });
});

// --- scoreEntry ---

describe("scoreEntry", () => {
  const now = new Date("2026-02-12");

  test("recency: 1 day ago is close to 1.0", () => {
    const entry = makeEntry({
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const score = scoreEntry(entry, now);
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThan(1.05);
  });

  test("recency: 90+ days ago is 0.0", () => {
    const entry = makeEntry({
      exposures: [{ date: "2025-11-01", sessionHash: "aaaa0000" }],
    });
    expect(scoreEntry(entry, now)).toBe(0.0);
  });

  test("reinforcement: 1 exposure = 0.0", () => {
    const entry = makeEntry({
      exposures: [{ date: "2025-11-01", sessionHash: "aaaa0000" }],
    });
    expect(scoreEntry(entry, now)).toBe(0.0);
  });

  test("reinforcement: 3 exposures = 0.5", () => {
    const entry = makeEntry({
      exposures: [
        { date: "2025-11-01", sessionHash: "aaaa0000" },
        { date: "2025-11-01", sessionHash: "bbbb0000" },
        { date: "2025-11-01", sessionHash: "cccc0000" },
      ],
    });
    expect(scoreEntry(entry, now)).toBeCloseTo(0.5, 1);
  });

  test("reinforcement: 5+ exposures = 1.0", () => {
    const entry = makeEntry({
      exposures: [
        { date: "2025-11-01", sessionHash: "a0000000" },
        { date: "2025-11-01", sessionHash: "b0000000" },
        { date: "2025-11-01", sessionHash: "c0000000" },
        { date: "2025-11-01", sessionHash: "d0000000" },
        { date: "2025-11-01", sessionHash: "e0000000" },
      ],
    });
    expect(scoreEntry(entry, now)).toBeCloseTo(1.0, 1);
  });

  test("malformed date scores 0 recency (maximally stale)", () => {
    const entry = makeEntry({
      exposures: [{ date: "not-a-date", sessionHash: "aaaa0000" }],
    });
    expect(scoreEntry(entry, now)).toBe(0.0);
  });
});

// --- selectLearnings ---

describe("selectLearnings", () => {
  test("empty entries returns empty result", () => {
    expect(selectLearnings([], "/x")).toEqual([]);
  });

  test("respects budget — never truncates mid-entry", () => {
    const entries = [
      makeEntry({ title: "Short", body: "A." }),
      makeEntry({ title: "Also short", body: "B." }),
      makeEntry({ title: "Third", body: "C." }),
    ];
    // Tiny budget — should include at least the first entry
    const selected = selectLearnings(entries, "/projects/myapp", 50);
    expect(selected.length).toBeGreaterThanOrEqual(1);

    // Each selected entry should be a complete entry
    for (const entry of selected) {
      expect(entry.title).toBeTruthy();
    }
  });

  test("first entry always included even if over budget", () => {
    const longBody = "x".repeat(5000);
    const entries = [makeEntry({ body: longBody })];
    const selected = selectLearnings(entries, "/projects/myapp", 100);
    expect(selected).toHaveLength(1);
  });

  test("higher-scored entries selected first", () => {
    const cwdMatch = makeEntry({
      title: "CWD match",
      cwds: ["/projects/myapp"],
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const globalEntry = makeEntry({
      title: "Global entry",
      cwds: ["*"],
      exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
    });
    // Give enough budget for only one — CWD match has same base score as global
    const entrySize = renderEntry(cwdMatch).length;
    const selected = selectLearnings([globalEntry, cwdMatch], "/projects/myapp", entrySize + 10);
    expect(selected).toHaveLength(1);
  });

  test("excludes non-matching CWD entries before scoring", () => {
    const relevant = makeEntry({
      title: "Relevant",
      cwds: ["/projects/myapp"],
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const irrelevant = makeEntry({
      title: "Irrelevant",
      cwds: ["/projects/other"],
      // Heavily reinforced — would outscore relevant entry without pre-filtering
      exposures: [
        { date: "2026-02-11", sessionHash: "b0000000" },
        { date: "2026-02-11", sessionHash: "c0000000" },
        { date: "2026-02-11", sessionHash: "d0000000" },
        { date: "2026-02-11", sessionHash: "e0000000" },
        { date: "2026-02-11", sessionHash: "f0000000" },
      ],
    });
    const selected = selectLearnings([irrelevant, relevant], "/projects/myapp", 10000);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.title).toBe("Relevant");
  });

  test("global entries pass through pre-filter", () => {
    const global = makeEntry({
      title: "Global",
      cwds: ["*"],
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const selected = selectLearnings([global], "/any/path", 10000);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.title).toBe("Global");
  });
});

// --- undoSessionLearnings ---

describe("undoSessionLearnings", () => {
  test("removes entry when session is the only exposure", () => {
    const entries = [makeEntry({ exposures: [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }] })];
    const result = undoSessionLearnings(entries, "a1b2c3d4");
    expect(result).toHaveLength(0);
  });

  test("removes only session exposure when entry has multiple", () => {
    const entries = [
      makeEntry({
        exposures: [
          { date: "2026-02-09", sessionHash: "a1b2c3d4" },
          { date: "2026-02-11", sessionHash: "e5f6g7h8" },
        ],
      }),
    ];
    const result = undoSessionLearnings(entries, "a1b2c3d4");
    expect(result).toHaveLength(1);
    expect(result[0]?.exposures).toHaveLength(1);
    expect(result[0]?.exposures[0]?.sessionHash).toBe("e5f6g7h8");
  });

  test("leaves entries without matching session unchanged", () => {
    const entries = [makeEntry({ exposures: [{ date: "2026-02-09", sessionHash: "other000" }] })];
    const result = undoSessionLearnings(entries, "a1b2c3d4");
    expect(result).toHaveLength(1);
  });

  test("empty entries returns empty result", () => {
    expect(undoSessionLearnings([], "a1b2c3d4")).toEqual([]);
  });
});

// --- loadLearnings / writeLearnings ---

describe("loadLearnings / writeLearnings", () => {
  beforeEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
    await mkdir(testMemoryDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testMemoryDir, { recursive: true, force: true });
  });

  test("file missing returns empty array", async () => {
    const entries = await loadLearnings(testMemoryDir);
    expect(entries).toEqual([]);
  });

  test("write then load round-trips", async () => {
    const original = [makeEntry(), makeEntry({ title: "Second", category: "preference" })];
    await writeLearnings(testMemoryDir, original);
    const loaded = await loadLearnings(testMemoryDir);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.title).toBe(original[0]?.title);
    expect(loaded[1]?.title).toBe(original[1]?.title);
  });

  test("write creates learnings.md", async () => {
    await writeLearnings(testMemoryDir, [makeEntry()]);
    expect(await Bun.file(`${testMemoryDir}/learnings.md`).exists()).toBe(true);
  });

  test("no tmp file remains after successful write", async () => {
    await writeLearnings(testMemoryDir, [makeEntry()]);
    const glob = new Bun.Glob("*.tmp.*");
    const tmpFiles = await Array.fromAsync(glob.scan(testMemoryDir));
    expect(tmpFiles).toHaveLength(0);
  });
});

// --- mergeNewLearnings ---

describe("mergeNewLearnings", () => {
  test("new entry appended when no title match", () => {
    const existing = [makeEntry({ title: "A" })];
    const extracted = [makeEntry({ title: "B" })];
    const result = mergeNewLearnings(existing, extracted);
    expect(result).toHaveLength(2);
  });

  test("exact title match reinforces existing entry", () => {
    const existing = [
      makeEntry({
        title: "Same title",
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      }),
    ];
    const extracted = [
      makeEntry({
        title: "Same title",
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
      }),
    ];
    const result = mergeNewLearnings(existing, extracted);
    expect(result).toHaveLength(1);
    expect(result[0]?.exposures).toHaveLength(2);
  });

  test("title match merges CWDs", () => {
    const existing = [makeEntry({ title: "Same", cwds: ["/a"] })];
    const extracted = [makeEntry({ title: "Same", cwds: ["/b"] })];
    const result = mergeNewLearnings(existing, extracted);
    expect(result[0]?.cwds).toContain("/a");
    expect(result[0]?.cwds).toContain("/b");
  });
});

// --- findPromotionCandidates ---

describe("findPromotionCandidates", () => {
  test("entry with 3+ CWDs and not nonglobal is returned", () => {
    const entry = makeEntry({ cwds: ["/a", "/b", "/c"] });
    expect(findPromotionCandidates([entry])).toHaveLength(1);
  });

  test("entry with 2 CWDs is not returned", () => {
    const entry = makeEntry({ cwds: ["/a", "/b"] });
    expect(findPromotionCandidates([entry])).toHaveLength(0);
  });

  test("nonglobal entry is not returned", () => {
    const entry = makeEntry({ cwds: ["/a", "/b", "/c"], nonglobal: true });
    expect(findPromotionCandidates([entry])).toHaveLength(0);
  });

  test("already global entry is not returned", () => {
    const entry = makeEntry({ cwds: ["*"] });
    expect(findPromotionCandidates([entry])).toHaveLength(0);
  });
});

// --- promoteToGlobal / markNonglobal ---

describe("promoteToGlobal", () => {
  test("sets cwds to [*]", () => {
    const result = promoteToGlobal(makeEntry({ cwds: ["/a", "/b", "/c"] }));
    expect(result.cwds).toEqual(["*"]);
  });
});

describe("markNonglobal", () => {
  test("sets nonglobal to true", () => {
    const result = markNonglobal(makeEntry());
    expect(result.nonglobal).toBe(true);
  });
});

// --- hashSessionId ---

describe("hashSessionId", () => {
  test("produces 8 hex chars", () => {
    const hash = hashSessionId("ses-abc12345");
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });

  test("same input produces same hash", () => {
    expect(hashSessionId("test")).toBe(hashSessionId("test"));
  });

  test("different inputs produce different hashes", () => {
    expect(hashSessionId("a")).not.toBe(hashSessionId("b"));
  });
});

// --- buildExtractionPromptSection ---

describe("buildExtractionPromptSection", () => {
  test("includes quality control instructions", () => {
    const prompt = buildExtractionPromptSection([]);
    expect(prompt).toContain("Do NOT extract");
    expect(prompt).toContain("DO extract");
    expect(prompt).toContain("0-3 learnings");
  });

  test("includes existing titles when provided", () => {
    const prompt = buildExtractionPromptSection(["Use Bun.file()", "No emojis"]);
    expect(prompt).toContain("- Use Bun.file()");
    expect(prompt).toContain("- No emojis");
  });

  test("shows placeholder when no existing titles", () => {
    const prompt = buildExtractionPromptSection([]);
    expect(prompt).toContain("No existing learnings yet.");
  });
});

// --- parseExtractedLearnings ---

describe("parseExtractedLearnings", () => {
  const metadata = { date: "2026-02-12", cwd: "/projects/myapp", sessionHash: "abcd1234" };

  test("parses valid entries", () => {
    const raw = `## Summary

Some summary here.

## Learnings

### (correction) Use Bun.file() instead of fs.readFile()

This project uses Bun runtime.

### (preference) No emojis in comments

User prefers no emojis.`;

    const entries = parseExtractedLearnings(raw, metadata);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.category).toBe("correction");
    expect(entries[0]?.title).toBe("Use Bun.file() instead of fs.readFile()");
    expect(entries[0]?.cwds).toEqual(["/projects/myapp"]);
    expect(entries[0]?.exposures[0]?.sessionHash).toBe("abcd1234");
  });

  test("empty or missing Learnings section returns empty array", () => {
    expect(parseExtractedLearnings("## Summary\nDone.", metadata)).toEqual([]);
    expect(parseExtractedLearnings("No sections here.", metadata)).toEqual([]);
  });

  test("malformed entries are skipped", () => {
    const raw = `## Learnings

### Not a valid format

Some text.

### (correction) Valid entry

Body.`;

    const entries = parseExtractedLearnings(raw, metadata);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Valid entry");
  });

  test("invalid category is skipped", () => {
    const raw = `## Learnings

### (invalid) Bad category

Body.`;

    expect(parseExtractedLearnings(raw, metadata)).toEqual([]);
  });
});

// --- Consolidation: Pass 1 ---

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

// --- Consolidation: Pass 2 ---

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
