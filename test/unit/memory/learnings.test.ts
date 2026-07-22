import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mutateLearnings,
  removeLearningIfUnchanged,
  replaceLearningsIfUnchanged,
  updateLearningIfUnchanged,
  writeLearnings,
} from "../../../src/memory/learning-store";
import {
  type LearningEntry,
  buildExtractionPromptSection,
  buildQualityAssessmentPrompt,
  filterLearnings,
  findScopeReviewCandidates,
  generalizeLearningScopes,
  loadLearnings,
  markNonglobal,
  matchesCwd,
  mergePromotionEvidence,
  parseExtractedLearnings,
  parseLearnings,
  parseLearningsDocument,
  parseQualityAssessmentOutput,
  promoteToGlobal,
  renderEntry,
  renderEntryForContext,
  renderLearnings,
  scoreEntry,
  selectLearnings,
  sortByExposures,
} from "../../../src/memory/learnings";
import { hashSessionId } from "../../../src/memory/utils";
import { testCwd, testCwdInput, testCwds } from "../../helpers/memory-path";

const testMemoryDir = join(tmpdir(), "shaka-test-learnings");

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: overrides.category ?? "correction",
    cwds: overrides.cwds ?? testCwds("/projects/myapp"),
    exposures: overrides.exposures ?? [{ date: "2026-02-09", sessionHash: "a1b2c3d4" }],
    nonglobal: overrides.nonglobal ?? false,
    title: overrides.title ?? "Use Bun.file() instead of fs.readFile()",
    body: overrides.body ?? "This project uses Bun runtime.",
    ...(overrides.promotionEvidence === undefined
      ? {}
      : { promotionEvidence: overrides.promotionEvidence }),
  };
}

function promotionComment(value: unknown): string {
  return `<!-- promotion: ${JSON.stringify(value)} -->`;
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

<!-- correction | cwd: ${testCwd("/projects/myapp")} | exposures: 2026-02-09@a1b2c3d4 -->

### Use Bun.file() instead of fs.readFile()

This project uses Bun runtime.

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).toBe("correction");
    expect(entries[0]?.cwds).toEqual(testCwds("/projects/myapp"));
    expect(entries[0]?.exposures).toEqual([{ date: "2026-02-09", sessionHash: "a1b2c3d4" }]);
    expect(entries[0]?.nonglobal).toBe(false);
    expect(entries[0]?.title).toBe("Use Bun.file() instead of fs.readFile()");
    expect(entries[0]?.body).toBe("This project uses Bun runtime.");
  });

  test("multiple entries parse correctly", () => {
    const content = `# Learnings

---

<!-- correction | cwd: ${testCwd("/a")} | exposures: 2026-02-09@aaaa0000 -->

### Title A

Body A.

---

<!-- preference | cwd: ${testCwd("/b")} | exposures: 2026-02-10@bbbb0000 -->

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

<!-- pattern | cwd: ${testCwd("/a")} | exposures: 2026-02-09@aaaa0000,2026-02-11@bbbb0000,2026-02-14@cccc0000 -->

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

<!-- correction | cwd: ${testCwds("/a", "/b", "/c").join(",")} | exposures: 2026-02-09@aaaa0000 -->

### Multi CWD

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries[0]?.cwds).toEqual(testCwds("/a", "/b", "/c"));
  });

  test("nonglobal flag parses correctly", () => {
    const content = `---

<!-- fact | cwd: ${testCwd("/a")} | exposures: 2026-02-09@aaaa0000 | nonglobal -->

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

  test("legacy promotion metadata defaults missing exclusions to an empty list", () => {
    const content = `---

<!-- preference | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: testCwds("/a", "/b", "/c"),
  exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
  reasons: ["manual-cross-project-review"],
})}

### Legacy promoted entry

Body.

---`;

    const [entry] = parseLearnings(content);

    expect(entry?.promotionEvidence).toEqual({
      sourceCwds: testCwds("/a", "/b", "/c"),
      excludedCwds: [],
      exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      reasons: ["manual-cross-project-review"],
    });
  });

  test("normalizes the complete promotion schema deterministically", () => {
    const content = `---

<!-- pattern | cwd: ${testCwds("/a", "/b").join(",")} | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: [testCwdInput("/b/"), testCwd("/a"), testCwd("/a")],
  excludedCwds: [testCwdInput("/z/"), testCwd("/y"), testCwd("/z")],
  exposures: [],
  reasons: [
    "manual-scope-correction",
    "legacy-source-reconstruction",
    "manual-scope-correction",
    "contradiction-scope-subtraction",
  ],
})}

### Canonical evidence

Body.

---`;

    const [entry] = parseLearnings(content);

    expect(entry?.promotionEvidence).toEqual({
      sourceCwds: testCwds("/a", "/b"),
      excludedCwds: testCwds("/y", "/z"),
      exposures: [],
      reasons: [
        "contradiction-scope-subtraction",
        "legacy-source-reconstruction",
        "manual-scope-correction",
      ],
    });
  });

  test("accepts reviewed ancestor and global promotion reasons", () => {
    const content = `---

<!-- pattern | cwd: ${testCwd("/work")} | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: testCwds("/work/project"),
  excludedCwds: [],
  exposures: [],
  reasons: ["manual-global-review", "manual-common-ancestor-review"],
})}

### Reviewed scope reasons

Body.

---`;

    const [entry] = parseLearnings(content);

    expect(entry?.promotionEvidence?.reasons).toEqual([
      "manual-common-ancestor-review",
      "manual-global-review",
    ]);
  });

  test("round-trips automatic hierarchical generalization evidence", () => {
    const entry = makeEntry({
      cwds: testCwds("/work/company-a"),
      promotionEvidence: {
        sourceCwds: testCwds(
          "/work/company-a/project-1",
          "/work/company-a/project-2",
          "/work/company-a/project-3",
        ),
        excludedCwds: [],
        exposures: [{ date: "2026-07-22", sessionHash: "abcd1234" }],
        reasons: ["automatic-hierarchical-generalization"],
      },
    });

    expect(parseLearnings(renderLearnings([entry]))).toEqual([entry]);
  });

  test("withholds a scope that can still match an excluded CWD", () => {
    const content = `---

<!-- pattern | cwd: ${testCwd("/work/company")} | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: testCwds("/work/company/project"),
  excludedCwds: testCwds("/work/company/legacy"),
  exposures: [],
  reasons: ["manual-scope-correction"],
})}

### Invalid corrected scope

Body.

---

<!-- fact | cwd: ${testCwd("/work/other")} | exposures: 2026-02-10@bbbb0000 -->

### Valid sibling after scope error

Body.

---`;

    const document = parseLearningsDocument(content);

    expect(document.entries.map((entry) => entry.title)).toEqual([
      "Valid sibling after scope error",
    ]);
    expect(document.diagnostics).toEqual([
      {
        code: "invalid-learning-scope",
        title: "Invalid corrected scope",
        message:
          'Learning "Invalid corrected scope" has an invalid applicability scope. An active learning scope cannot be related to an excluded CWD.',
      },
    ]);
  });

  test("round-trips a reviewed entry with no primary exposures", () => {
    const entry: LearningEntry = {
      ...makeEntry({ cwds: testCwds("/work/project"), exposures: [] }),
      promotionEvidence: {
        sourceCwds: testCwds("/work/project"),
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-scope-correction"],
      },
    };

    const rendered = renderLearnings([entry]);

    expect(rendered).toContain("exposures: none");
    expect(parseLearnings(rendered)).toEqual([entry]);
  });

  test("round-trips a nonglobal entry with no primary exposures", () => {
    const entry = makeEntry({ exposures: [], nonglobal: true });

    expect(parseLearnings(renderLearnings([entry]))).toEqual([entry]);
  });

  test("rejects a zero-exposure global marked nonglobal without evidence", () => {
    const entry = makeEntry({ cwds: ["*"], exposures: [], nonglobal: true });

    const document = parseLearningsDocument(renderLearnings([entry]));

    expect(document.entries).toEqual([]);
    expect(document.diagnostics[0]).toMatchObject({
      code: "invalid-learning-scope",
      title: entry.title,
    });
  });

  test("withholds an ordinary entry with no primary exposures", () => {
    const content = `---

<!-- correction | cwd: ${testCwd("/work/project")} | exposures: none -->

### Ordinary orphan

Body.

---`;

    expect(parseLearningsDocument(content)).toEqual({
      entries: [],
      diagnostics: [
        {
          code: "invalid-learning-scope",
          title: "Ordinary orphan",
          message:
            'Learning "Ordinary orphan" has an invalid applicability scope. A learning without primary exposures must retain durable reviewed state.',
        },
      ],
    });
  });

  test("rejects none mixed with dated primary exposures", () => {
    const content = `---

<!-- correction | cwd: ${testCwd("/work/project")} | exposures: none,2026-02-09@aaaa0000 | nonglobal -->

### Mixed empty sentinel

Body.

---`;

    expect(parseLearningsDocument(content).entries).toEqual([]);
    expect(parseLearningsDocument(content).diagnostics[0]?.code).toBe("malformed-learning-record");
  });

  test("rejects noncanonical empty exposure sentinels", () => {
    const content = `---

<!-- correction | cwd: ${testCwd("/work/project")} | exposures: empty | nonglobal -->

### Wrong empty sentinel

Body.

---`;

    expect(parseLearningsDocument(content).entries).toEqual([]);
    expect(parseLearningsDocument(content).diagnostics[0]?.code).toBe("malformed-learning-record");
  });

  test("malformed metadata is skipped gracefully", () => {
    const content = `---

<!-- not valid metadata -->

### Bad entry

Body.

---

<!-- correction | cwd: ${testCwd("/a")} | exposures: 2026-02-09@aaaa0000 -->

### Good entry

Body.

---`;

    const entries = parseLearnings(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("Good entry");
  });

  test("reports an entry-like block with malformed primary metadata", () => {
    const content = `# Learnings

Automatically captured.

---

<!-- correction | cwd: ${testCwd("/projects/a")} | broken -->

### Lost learning

Body.

---`;

    expect(parseLearningsDocument(content)).toEqual({
      entries: [],
      diagnostics: [
        {
          code: "malformed-learning-record",
          title: "Lost learning",
          message: 'Learning "Lost learning" has malformed primary metadata.',
        },
      ],
    });
  });

  test("reports non-record content after a learning record", () => {
    const content = `# Learnings

Automatically captured.

---

<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->

### Legacy delimiter body

Keep before.

---

Keep after.`;

    const document = parseLearningsDocument(content);

    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]?.body).toBe("Keep before.");
    expect(document.diagnostics).toEqual([
      {
        code: "malformed-learning-record",
        message: "Learning storage contains content outside a complete learning record.",
      },
    ]);
  });

  test("does not treat arbitrary leading content as a learnings preamble", () => {
    expect(parseLearningsDocument("orphaned content").diagnostics).toEqual([
      {
        code: "malformed-learning-record",
        message: "Learning storage contains content outside a complete learning record.",
      },
    ]);
  });

  test("reports malformed primary metadata even when the title is missing", () => {
    const content = `# Learnings

Automatically captured.

---

<!-- correction | cwd: ${testCwd("/projects/a")} | broken -->

Body without a title.

---`;

    expect(parseLearningsDocument(content)).toEqual({
      entries: [],
      diagnostics: [
        {
          code: "malformed-learning-record",
          message: "Learning record has malformed primary metadata or title.",
        },
      ],
    });
  });

  test("reports orphaned promotion metadata as a malformed learning record", () => {
    const content = `---

${promotionComment({
  sourceCwds: testCwds("/a", "/b", "/c"),
  exposures: [{ date: "2026-07-18", sessionHash: "aaaa0000" }],
  reasons: ["automatic-cross-project-threshold"],
})}

---`;

    expect(parseLearningsDocument(content)).toEqual({
      entries: [],
      diagnostics: [
        {
          code: "malformed-learning-record",
          message: "Learning record has malformed primary metadata or title.",
        },
      ],
    });
  });

  test("reports primary metadata containing fields that cannot round-trip", () => {
    const metadataVariants = [
      `<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: missing-session-hash -->`,
      `<!-- correction | cwd: ${testCwd("/projects/a")}, | exposures: 2026-07-18@aaaa0000 -->`,
    ];

    for (const metadata of metadataVariants) {
      const content = `---

${metadata}

### Lossy metadata

Body.

---`;

      expect(parseLearningsDocument(content)).toEqual({
        entries: [],
        diagnostics: [
          {
            code: "malformed-learning-record",
            title: "Lossy metadata",
            message: 'Learning "Lossy metadata" has malformed primary metadata.',
          },
        ],
      });
    }
  });

  test("reports duplicate primary metadata instead of silently discarding it", () => {
    const metadataPairs = [
      [
        `<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->`,
        `<!-- preference | cwd: ${testCwd("/projects/b")} | exposures: 2026-07-18@bbbb0000 -->`,
      ],
      [
        `<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->`,
        `<!-- correction | cwd: ${testCwd("/projects/b")} | broken -->`,
      ],
    ];

    for (const metadata of metadataPairs) {
      const content = `---

${metadata.join("\n")}

### Ambiguous metadata

Body.

---`;

      expect(parseLearningsDocument(content)).toEqual({
        entries: [],
        diagnostics: [
          {
            code: "malformed-learning-record",
            title: "Ambiguous metadata",
            message: 'Learning "Ambiguous metadata" has malformed primary metadata.',
          },
        ],
      });
    }
  });

  test("withholds invalid promotion metadata while keeping valid siblings readable", () => {
    const validPromotion = promotionComment({
      sourceCwds: testCwds("/a", "/b", "/c"),
      exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      reasons: ["automatic-cross-project-threshold"],
    });
    const variants = [
      ["<!-- promotion: invalid-json -->", "malformed-promotion-metadata"],
      [`${validPromotion}\n${validPromotion}`, "duplicate-promotion-metadata"],
    ] as const;

    for (const [promotionMetadata, diagnosticCode] of variants) {
      const content = `---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${promotionMetadata}

### Global entry

Body.

---

<!-- pattern | cwd: ${testCwd("/work/valid")} | exposures: 2026-02-10@bbbb0000 -->

### Valid sibling

Sibling body.

---`;

      const { entries, diagnostics } = parseLearningsDocument(content);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.title).toBe("Valid sibling");
      expect(diagnostics).toEqual([
        {
          code: diagnosticCode,
          title: "Global entry",
          message:
            diagnosticCode === "duplicate-promotion-metadata"
              ? 'Learning "Global entry" contains more than one promotion metadata record.'
              : 'Learning "Global entry" contains malformed promotion metadata.',
        },
      ]);
    }
  });

  test("reports noncanonical promotion-looking metadata", () => {
    const malformedMarkers = [
      "<!-- Promotion: {bad-json} -->",
      "<!-- promotion{bad-json} -->",
      "<!-- promotion:{bad-json} -->",
      "<!--  promotion: {bad-json} -->",
      "<!-- promotion : {bad-json} -->",
      "<!-- promotion:\t{bad-json} -->",
      "<!-- promotion: {bad-json}",
    ];

    for (const marker of malformedMarkers) {
      const content = `---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${marker}

### Damaged promotion

Body.

---`;

      expect(parseLearningsDocument(content).diagnostics).toEqual([
        {
          code: "malformed-promotion-metadata",
          title: "Damaged promotion",
          message: 'Learning "Damaged promotion" contains malformed promotion metadata.',
        },
      ]);
    }
  });

  test("rejects unknown promotion fields that a rewrite could not preserve", () => {
    const content = `---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: testCwds("/a", "/b", "/c"),
  exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
  reasons: ["automatic-cross-project-threshold"],
  reviewer: "human",
})}

### Extended promotion

Body.

---`;

    const document = parseLearningsDocument(content);

    expect(document.entries).toEqual([]);
    expect(document.diagnostics).toEqual([
      {
        code: "malformed-promotion-metadata",
        title: "Extended promotion",
        message: 'Learning "Extended promotion" contains malformed promotion metadata.',
      },
    ]);
  });

  test("reports a canonical promotion paired with a mixed-case duplicate", () => {
    const canonical = promotionComment({
      sourceCwds: testCwds("/a", "/b", "/c"),
      exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      reasons: ["automatic-cross-project-threshold"],
    });
    const content = `---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${canonical}
<!-- Promotion: {bad-json} -->

### Duplicated promotion

Body.

---`;

    expect(parseLearningsDocument(content).diagnostics).toEqual([
      {
        code: "duplicate-promotion-metadata",
        title: "Duplicated promotion",
        message:
          'Learning "Duplicated promotion" contains more than one promotion metadata record.',
      },
    ]);
  });

  test("reads promotion metadata only from the region before the title", () => {
    const promotion = promotionComment({
      sourceCwds: testCwds("/a", "/b", "/c"),
      exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      reasons: ["automatic-cross-project-threshold"],
    });
    const primary = "<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->";

    const bodyOnlyDocument = parseLearningsDocument(`---

${primary}

### Body comment

${promotion}

---`);
    const metadataAndBodyDocument = parseLearningsDocument(`---

${primary}
${promotion}

### Real metadata

${promotion}

---`);
    const [bodyOnly] = bodyOnlyDocument.entries;
    const [metadataAndBody] = metadataAndBodyDocument.entries;

    expect(bodyOnly?.promotionEvidence).toBeUndefined();
    expect(bodyOnly?.body).toBe(promotion);
    expect(bodyOnlyDocument.diagnostics).toEqual([]);
    expect(metadataAndBody?.promotionEvidence?.sourceCwds).toEqual(testCwds("/a", "/b", "/c"));
    expect(metadataAndBody?.body).toBe(promotion);
    expect(metadataAndBodyDocument.diagnostics).toEqual([]);
  });

  test("entry without body has empty body string", () => {
    const content = `---

<!-- correction | cwd: ${testCwd("/a")} | exposures: 2026-02-09@aaaa0000 -->

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
      `<!-- correction | cwd: ${testCwd("/projects/myapp")} | exposures: 2026-02-09@a1b2c3d4 -->`,
    );
    expect(rendered).toContain("### Use Bun.file() instead of fs.readFile()");
    expect(rendered).toContain("This project uses Bun runtime.");
  });

  test("renders nonglobal flag", () => {
    const entry = makeEntry({ nonglobal: true });
    expect(renderEntry(entry)).toContain("| nonglobal -->");
  });

  test("renders multiple CWDs as comma-separated", () => {
    const entry = makeEntry({ cwds: testCwds("/a", "/b", "/c") });
    expect(renderEntry(entry)).toContain(`cwd: ${testCwds("/a", "/b", "/c").join(", ")}`);
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

describe("renderEntryForContext", () => {
  test("includes title and body", () => {
    const rendered = renderEntryForContext(makeEntry());
    expect(rendered).toContain("### Use Bun.file() instead of fs.readFile()");
    expect(rendered).toContain("This project uses Bun runtime.");
  });

  test("omits metadata comment", () => {
    const rendered = renderEntryForContext(
      promoteToGlobal(
        makeEntry({ cwds: testCwds("/a", "/b", "/c") }),
        "automatic-cross-project-threshold",
      ),
    );
    expect(rendered).not.toContain("<!--");
    expect(rendered).not.toContain("exposures:");
    expect(rendered).not.toContain("cwd:");
    expect(rendered).not.toContain("promotion");
  });

  test("entry without body renders just the title", () => {
    const rendered = renderEntryForContext(makeEntry({ body: "" }));
    expect(rendered).toBe("### Use Bun.file() instead of fs.readFile()");
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
        cwds: testCwds("/x", "/y", "/z"),
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

  test("round-trips promotion evidence without exposing an HTML comment terminator", () => {
    const entry: LearningEntry = {
      ...makeEntry({ cwds: ["*"] }),
      promotionEvidence: {
        sourceCwds: testCwds("/projects/alpha-->archive", "/projects/beta", "/projects/gamma"),
        excludedCwds: [],
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
        reasons: ["automatic-cross-project-threshold"],
      },
    };

    const rendered = renderLearnings([entry]);
    const promotionLine = rendered.split("\n").find((line) => line.startsWith("<!-- promotion: "));
    const payload = promotionLine?.slice("<!-- promotion: ".length, -" -->".length);

    expect(payload).toBeDefined();
    expect(payload).not.toContain("--");
    expect(payload).toContain('"excludedCwds":[]');
    expect(parseLearnings(rendered)).toEqual([entry]);
  });
});

// --- matchesCwd ---

describe("matchesCwd", () => {
  test("uses equal, ancestor, and descendant path relationships but not siblings", () => {
    const entry = makeEntry({ cwds: testCwds("/work/company/project") });

    expect(matchesCwd(entry, testCwd("/work/company/project"))).toBe(true);
    expect(matchesCwd(entry, testCwd("/work/company"))).toBe(true);
    expect(matchesCwd(entry, testCwd("/work/company/project/packages/api"))).toBe(true);
    expect(matchesCwd(entry, testCwd("/work/company/other-project"))).toBe(false);
    expect(matchesCwd(entry, testCwd("/other/company/project"))).toBe(false);
    expect(matchesCwd(makeEntry({ cwds: testCwds("/") }), testCwd("/work/company/project"))).toBe(
      true,
    );
  });
});

// --- scoreEntry ---

describe("scoreEntry", () => {
  const now = new Date("2026-02-12");

  test("returns zero recency and reinforcement for no primary exposures", () => {
    expect(scoreEntry(makeEntry({ exposures: [] }), now)).toBe(0);
  });

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

  test("custom recency window: 30 days treats 45-day-old entry as stale", () => {
    const entry = makeEntry({
      exposures: [{ date: "2025-12-29", sessionHash: "aaaa0000" }], // ~45 days ago from now
    });
    // With default 90-day window, this would have ~0.5 recency
    expect(scoreEntry(entry, now)).toBeGreaterThan(0.4);
    // With 30-day window, this should be 0 (older than window)
    expect(scoreEntry(entry, now, 30)).toBe(0.0);
  });

  test("custom recency window: 180 days treats 60-day-old entry as recent", () => {
    const entry = makeEntry({
      exposures: [{ date: "2025-12-14", sessionHash: "aaaa0000" }], // ~60 days ago
    });
    // With default 90-day window: ~0.33 recency
    const defaultScore = scoreEntry(entry, now);
    // With 180-day window: ~0.67 recency — should be higher
    const widerScore = scoreEntry(entry, now, 180);
    expect(widerScore).toBeGreaterThan(defaultScore);
  });
});

// --- selectLearnings ---

describe("selectLearnings", () => {
  test("empty entries returns empty result", () => {
    expect(selectLearnings([], testCwd("/x"))).toEqual([]);
  });

  test("respects budget — never truncates mid-entry", () => {
    const entries = [
      makeEntry({ title: "Short", body: "A." }),
      makeEntry({ title: "Also short", body: "B." }),
      makeEntry({ title: "Third", body: "C." }),
    ];
    // Tiny budget — should include at least the first entry
    const selected = selectLearnings(entries, testCwd("/projects/myapp"), 50);
    expect(selected.length).toBeGreaterThanOrEqual(1);

    // Each selected entry should be a complete entry
    for (const entry of selected) {
      expect(entry.title).toBeTruthy();
    }
  });

  test("first entry always included even if over budget", () => {
    const longBody = "x".repeat(5000);
    const entries = [makeEntry({ body: longBody })];
    const selected = selectLearnings(entries, testCwd("/projects/myapp"), 100);
    expect(selected).toHaveLength(1);
  });

  test("higher-scored entries selected first", () => {
    const cwdMatch = makeEntry({
      title: "CWD match",
      cwds: testCwds("/projects/myapp"),
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const globalEntry = makeEntry({
      title: "Global entry",
      cwds: ["*"],
      exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
    });
    // Give enough budget for only one — CWD match has same base score as global
    const entrySize = renderEntryForContext(cwdMatch).length;
    const selected = selectLearnings(
      [globalEntry, cwdMatch],
      testCwd("/projects/myapp"),
      entrySize + 10,
    );
    expect(selected).toHaveLength(1);
  });

  test("budget is measured against context render, not storage render", () => {
    const a = makeEntry({ title: "Entry A", body: "Body A." });
    const b = makeEntry({ title: "Entry B", body: "Body B." });
    // Budget fits exactly two context-rendered entries. The storage render
    // is larger (it carries metadata), so a probe sized against storage
    // would admit only one entry and under-fill the budget.
    const budget = renderEntryForContext(a).length + renderEntryForContext(b).length;

    expect(selectLearnings([a, b], testCwd("/projects/myapp"), budget)).toHaveLength(2);
  });

  test("excludes non-matching CWD entries before scoring", () => {
    const relevant = makeEntry({
      title: "Relevant",
      cwds: testCwds("/projects/myapp"),
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const irrelevant = makeEntry({
      title: "Irrelevant",
      cwds: testCwds("/projects/other"),
      // Heavily reinforced — would outscore relevant entry without pre-filtering
      exposures: [
        { date: "2026-02-11", sessionHash: "b0000000" },
        { date: "2026-02-11", sessionHash: "c0000000" },
        { date: "2026-02-11", sessionHash: "d0000000" },
        { date: "2026-02-11", sessionHash: "e0000000" },
        { date: "2026-02-11", sessionHash: "f0000000" },
      ],
    });
    const selected = selectLearnings([irrelevant, relevant], testCwd("/projects/myapp"), 10000);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.title).toBe("Relevant");
  });

  test("global entries pass through pre-filter", () => {
    const global = makeEntry({
      title: "Global",
      cwds: ["*"],
      exposures: [{ date: "2026-02-11", sessionHash: "aaaa0000" }],
    });
    const selected = selectLearnings([global], testCwd("/any/path"), 10000);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.title).toBe("Global");
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

  test("mutation rejects malformed promotion metadata without changing the file", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
<!-- promotion: invalid-json -->

### Global entry

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    await Bun.write(filePath, raw);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => [
        ...entries,
        makeEntry({ title: "New learning" }),
      ]),
    ).rejects.toThrow("promotion metadata");

    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects invalid applicability evidence without changing the file", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: ${testCwd("/work/company")} | exposures: 2026-02-09@aaaa0000 -->
${promotionComment({
  sourceCwds: testCwds("/work/company/project"),
  excludedCwds: testCwds("/work/company/legacy"),
  exposures: [],
  reasons: ["manual-scope-correction"],
})}

### Invalid corrected scope

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    let callbackInvoked = false;
    await Bun.write(filePath, raw);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => {
        callbackInvoked = true;
        return entries;
      }),
    ).rejects.toThrow("invalid applicability scope");

    expect(callbackInvoked).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects mixed-case promotion metadata without changing the file", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
<!-- Promotion: invalid-json -->

### Global entry

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    await Bun.write(filePath, raw);

    await expect(mutateLearnings(testMemoryDir, (entries) => entries)).rejects.toThrow(
      "promotion metadata",
    );

    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects a malformed learning record before invoking the callback", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: ${testCwd("/projects/a")} | broken -->

### Lost learning

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    let callbackInvoked = false;
    await Bun.write(filePath, raw);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => {
        callbackInvoked = true;
        return entries;
      }),
    ).rejects.toThrow("invalid learning storage");

    expect(callbackInvoked).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects legacy orphan content without changing the file", async () => {
    const raw = `# Learnings

Automatically captured.

---

<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->

### Legacy delimiter body

Keep before.

---

Keep after.`;
    const filePath = `${testMemoryDir}/learnings.md`;
    let callbackInvoked = false;
    await Bun.write(filePath, raw);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => {
        callbackInvoked = true;
        return entries;
      }),
    ).rejects.toThrow("outside a complete learning record");

    expect(callbackInvoked).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects duplicate primary metadata without changing the file", async () => {
    const raw = `# Learnings

---

<!-- correction | cwd: ${testCwd("/projects/a")} | exposures: 2026-07-18@aaaa0000 -->
<!-- correction | cwd: ${testCwd("/projects/b")} | broken -->

### Ambiguous metadata

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    await Bun.write(filePath, raw);

    await expect(mutateLearnings(testMemoryDir, (entries) => entries)).rejects.toThrow(
      "invalid learning storage",
    );

    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("mutation rejects a symlinked learnings file without replacing it", async () => {
    const filePath = `${testMemoryDir}/learnings.md`;
    const targetPath = `${testMemoryDir}/linked-learnings.md`;
    const raw = renderLearnings([makeEntry({ title: "Linked learning" })]);
    let callbackInvoked = false;
    await Bun.write(targetPath, raw);
    await symlink(targetPath, filePath);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => {
        callbackInvoked = true;
        return entries;
      }),
    ).rejects.toThrow("regular file");

    expect(callbackInvoked).toBe(false);
    expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(targetPath).text()).toBe(raw);
  });

  test("mutation rejects a dangling learnings symlink without replacing it", async () => {
    const filePath = `${testMemoryDir}/learnings.md`;
    const missingTarget = `${testMemoryDir}/missing-learnings.md`;
    let callbackInvoked = false;
    await symlink(missingTarget, filePath);

    await expect(
      mutateLearnings(testMemoryDir, (entries) => {
        callbackInvoked = true;
        return entries;
      }),
    ).rejects.toThrow("regular file");

    expect(callbackInvoked).toBe(false);
    expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(missingTarget).exists()).toBe(false);
  });

  test("direct write rejects duplicate promotion metadata without changing the file", async () => {
    const promotion = promotionComment({
      sourceCwds: testCwds("/a", "/b", "/c"),
      exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
      reasons: ["automatic-cross-project-threshold"],
    });
    const raw = `# Learnings

---

<!-- correction | cwd: * | exposures: 2026-02-09@aaaa0000 -->
${promotion}
${promotion}

### Global entry

Body.
`;
    const filePath = `${testMemoryDir}/learnings.md`;
    await Bun.write(filePath, raw);

    await expect(writeLearnings(testMemoryDir, [makeEntry()])).rejects.toThrow(
      "promotion metadata",
    );

    expect(await Bun.file(filePath).text()).toBe(raw);
  });

  test("direct write rejects replacement entries with invalid storage metadata", async () => {
    const original = [makeEntry({ title: "Existing learning" })];
    const filePath = `${testMemoryDir}/learnings.md`;
    await writeLearnings(testMemoryDir, original);
    const source = await Bun.file(filePath).text();

    await expect(
      writeLearnings(testMemoryDir, [makeEntry({ title: "Invalid learning", exposures: [] })]),
    ).rejects.toThrow("invalid learning storage");

    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("direct write rejects a body containing a learning record delimiter", async () => {
    const original = [makeEntry({ title: "Existing learning" })];
    const filePath = `${testMemoryDir}/learnings.md`;
    await writeLearnings(testMemoryDir, original);
    const source = await Bun.file(filePath).text();

    await expect(
      writeLearnings(testMemoryDir, [makeEntry({ body: "Keep before.\n---\nKeep after." })]),
    ).rejects.toThrow("outside a complete learning record");

    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("direct write rejects a CWD containing the storage delimiter", async () => {
    const original = [makeEntry({ title: "Existing learning" })];
    const filePath = `${testMemoryDir}/learnings.md`;
    await writeLearnings(testMemoryDir, original);
    const source = await Bun.file(filePath).text();

    await expect(
      writeLearnings(testMemoryDir, [makeEntry({ cwds: testCwds("/projects/team,alpha") })]),
    ).rejects.toThrow("invalid applicability scope");

    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("direct write rejects sparse replacement arrays", async () => {
    const original = [makeEntry({ title: "Existing learning" })];
    const replacement = [makeEntry({ title: "Sparse replacement" })];
    const filePath = `${testMemoryDir}/learnings.md`;
    replacement.length = 2;
    await writeLearnings(testMemoryDir, original);
    const source = await Bun.file(filePath).text();

    await expect(writeLearnings(testMemoryDir, replacement)).rejects.toThrow(
      "cannot be represented without data loss",
    );

    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("concurrent mutations preserve both updates", async () => {
    const first = makeEntry({ title: "First concurrent update" });
    const second = makeEntry({ title: "Second concurrent update" });

    await Promise.all([
      mutateLearnings(testMemoryDir, async (entries) => {
        await Bun.sleep(20);
        return [...entries, first];
      }),
      mutateLearnings(testMemoryDir, async (entries) => {
        await Bun.sleep(20);
        return [...entries, second];
      }),
    ]);

    const stored = await loadLearnings(testMemoryDir);
    expect(stored.map((entry) => entry.title).sort()).toEqual([
      "First concurrent update",
      "Second concurrent update",
    ]);
  });

  test("exported mutation establishes migration readiness before rewriting a canonical global", async () => {
    await writeLearnings(testMemoryDir, [makeEntry({ cwds: ["*"] })]);

    await mutateLearnings(testMemoryDir, (entries) => [
      ...entries,
      makeEntry({ title: "Added", cwds: testCwds("/work/project") }),
    ]);

    expect(await Bun.file(`${testMemoryDir}/.learning-scope-migration-v1.json`).exists()).toBe(
      true,
    );
    expect((await loadLearnings(testMemoryDir)).map((entry) => entry.title)).toContain("Added");
  });

  test("stale locks are recovered before applying a mutation", async () => {
    const lockPath = `${testMemoryDir}/.learnings.lock`;
    await mkdir(lockPath);
    const staleTime = new Date(Date.now() - 1_000);
    await utimes(lockPath, staleTime, staleTime);

    await mutateLearnings(testMemoryDir, () => [makeEntry()], {
      pollMs: 5,
      timeoutMs: 100,
      staleMs: 50,
    });

    expect(await loadLearnings(testMemoryDir)).toHaveLength(1);
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("conditional replacement refuses to overwrite a newer mutation", async () => {
    const original = [makeEntry({ title: "Original" })];
    await writeLearnings(testMemoryDir, original);

    await mutateLearnings(testMemoryDir, (entries) => [
      ...entries,
      makeEntry({ title: "Concurrent update" }),
    ]);

    const replaced = await replaceLearningsIfUnchanged(testMemoryDir, original, [
      makeEntry({ title: "Stale replacement" }),
    ]);

    expect(replaced).toBe(false);
    expect((await loadLearnings(testMemoryDir)).map((entry) => entry.title)).toEqual([
      "Original",
      "Concurrent update",
    ]);
  });

  test("conditional replacement rejects the removed before-write callback at runtime", async () => {
    const original = [makeEntry({ title: "Original" })];
    const replacement = [makeEntry({ title: "Replacement" })];
    await writeLearnings(testMemoryDir, original);
    let callbackCalled = false;
    const legacyCall = replaceLearningsIfUnchanged as unknown as (
      memoryDir: string,
      expected: readonly LearningEntry[],
      replacement: readonly LearningEntry[],
      beforeWrite: () => Promise<void>,
    ) => Promise<boolean>;

    await expect(
      legacyCall(testMemoryDir, original, replacement, async () => {
        callbackCalled = true;
      }),
    ).rejects.toThrow("replaceLearningsIfUnchanged no longer accepts a before-write callback");

    expect(callbackCalled).toBe(false);
    expect(await loadLearnings(testMemoryDir)).toEqual(original);
  });

  test("conditional replacement compares the expected snapshot structurally", async () => {
    const current = [makeEntry({ cwds: testCwds("/projects/team", "/projects/alpha") })];
    const expected = [makeEntry({ cwds: testCwds("/projects/team, /projects/alpha") })];
    const filePath = `${testMemoryDir}/learnings.md`;
    await writeLearnings(testMemoryDir, current);
    const source = await Bun.file(filePath).text();

    const replaced = await replaceLearningsIfUnchanged(testMemoryDir, expected, [
      makeEntry({ title: "Replacement" }),
    ]);

    expect(replaced).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("conditional replacement compares the expected snapshot cardinality", async () => {
    const current = [makeEntry({ title: "Current" })];
    const expected = [makeEntry({ title: "Current" })];
    const filePath = `${testMemoryDir}/learnings.md`;
    expected.length = 2;
    await writeLearnings(testMemoryDir, current);
    const source = await Bun.file(filePath).text();

    const replaced = await replaceLearningsIfUnchanged(testMemoryDir, expected, [
      makeEntry({ title: "Replacement" }),
    ]);

    expect(replaced).toBe(false);
    expect(await Bun.file(filePath).text()).toBe(source);
  });

  test("direct write currently rejects a zero-primary-exposure entry", async () => {
    const filePath = `${testMemoryDir}/learnings.md`;
    const original = [makeEntry({ title: "Original" })];
    await writeLearnings(testMemoryDir, original);

    await expect(
      writeLearnings(testMemoryDir, [makeEntry({ title: "Durable", exposures: [] })]),
    ).rejects.toThrow("invalid learning storage");

    expect(await Bun.file(filePath).text()).toBe(renderLearnings(original));
  });

  test("conditional removal deletes only the selected duplicate title", async () => {
    const selected = makeEntry({ title: "Duplicate", body: "Selected body." });
    const sameTitle = makeEntry({ title: "Duplicate", body: "Different body." });
    await writeLearnings(testMemoryDir, [selected, sameTitle]);

    const result = await removeLearningIfUnchanged(testMemoryDir, selected);

    expect(result.status).toBe("removed");
    expect(result.entries).toEqual([sameTitle]);
  });

  test("conditional removal preserves an entry that changed after review", async () => {
    const selected = makeEntry({ title: "Reviewed", body: "Original body." });
    const changed = makeEntry({
      title: "Reviewed",
      body: "Updated body.",
      exposures: [
        { date: "2026-02-09", sessionHash: "a1b2c3d4" },
        { date: "2026-02-10", sessionHash: "b2c3d4e5" },
      ],
    });
    await writeLearnings(testMemoryDir, [changed]);

    const result = await removeLearningIfUnchanged(testMemoryDir, selected);

    expect(result.status).toBe("stale");
    expect(result.entries).toEqual([changed]);
  });

  test("conditional update derives the replacement from the fresh unique match", async () => {
    const selected = makeEntry({ title: "Scoped learning", nonglobal: false });
    await writeLearnings(testMemoryDir, [selected]);

    const result = await updateLearningIfUnchanged(testMemoryDir, selected, (fresh) => ({
      ...fresh,
      nonglobal: true,
    }));

    expect(result.status).toBe("updated");
    expect(result.entries[0]).toEqual({ ...selected, nonglobal: true });
    expect(await loadLearnings(testMemoryDir)).toEqual(result.entries);
  });

  test("conditional update reports stale without invoking its update", async () => {
    const selected = makeEntry({ title: "Scoped learning", body: "Reviewed body." });
    const changed = { ...selected, body: "Concurrent body." };
    await writeLearnings(testMemoryDir, [changed]);
    let invoked = false;

    const result = await updateLearningIfUnchanged(testMemoryDir, selected, (fresh) => {
      invoked = true;
      return fresh;
    });

    expect(result.status).toBe("stale");
    expect(invoked).toBe(false);
    expect(result.entries).toEqual([changed]);
  });

  test("conditional update and removal report ambiguous for identical persisted entries", async () => {
    const duplicate = makeEntry({ title: "Exact duplicate" });
    await writeLearnings(testMemoryDir, [duplicate, duplicate]);

    const update = await updateLearningIfUnchanged(testMemoryDir, duplicate, (fresh) => ({
      ...fresh,
      nonglobal: true,
    }));
    const removal = await removeLearningIfUnchanged(testMemoryDir, duplicate);

    expect(update.status).toBe("ambiguous");
    expect(removal.status).toBe("ambiguous");
    expect(await loadLearnings(testMemoryDir)).toEqual([duplicate, duplicate]);
  });

  test("conditional update rejects an invalid fresh replacement without changing storage", async () => {
    const selected = makeEntry({ title: "Valid persisted scope" });
    const filePath = join(testMemoryDir, "learnings.md");
    await writeLearnings(testMemoryDir, [selected]);
    const source = await Bun.file(filePath).text();

    await expect(
      updateLearningIfUnchanged(testMemoryDir, selected, (fresh) => ({
        ...fresh,
        cwds: ["*"],
        nonglobal: true,
      })),
    ).rejects.toThrow("invalid applicability scope");

    expect(await Bun.file(filePath).text()).toBe(source);
  });
});

describe("mergePromotionEvidence", () => {
  test("unions every evidence field deterministically", () => {
    const merged = mergePromotionEvidence(
      {
        sourceCwds: testCwds("/b"),
        excludedCwds: testCwds("/z"),
        exposures: [{ date: "2026-02-11", sessionHash: "bbbb0000" }],
        reasons: ["manual-scope-correction"],
      },
      {
        sourceCwds: testCwds("/a"),
        excludedCwds: testCwds("/y"),
        exposures: [{ date: "2026-02-09", sessionHash: "aaaa0000" }],
        reasons: ["contradiction-scope-subtraction"],
      },
    );

    expect(merged).toEqual({
      sourceCwds: testCwds("/a", "/b"),
      excludedCwds: testCwds("/y", "/z"),
      exposures: [
        { date: "2026-02-09", sessionHash: "aaaa0000" },
        { date: "2026-02-11", sessionHash: "bbbb0000" },
      ],
      reasons: ["contradiction-scope-subtraction", "manual-scope-correction"],
    });
  });
});

// --- automatic scope generalization ---

describe("generalizeLearningScopes", () => {
  test("generalizes every eligible entry and counts changed scopes once", () => {
    const qualifying = makeEntry({
      title: "Company pattern",
      cwds: testCwds(
        "/work/company-a/project-1",
        "/work/company-a/project-2",
        "/work/company-a/project-3",
      ),
    });
    const unchanged = makeEntry({
      title: "Project pattern",
      cwds: testCwds("/work/company-b/project-1"),
    });

    const result = generalizeLearningScopes([qualifying, unchanged], []);

    expect(result.generalized).toBe(1);
    expect(result.entries[0]?.cwds).toEqual(testCwds("/work/company-a"));
    expect(result.entries[1]).toBe(unchanged);
  });

  test("rejects the whole transition when any persisted scope is invalid", () => {
    const valid = makeEntry({
      title: "Valid pattern",
      cwds: testCwds("/work/company-a/project-1", "/work/company-a/project-2"),
    });
    const invalid = makeEntry({
      title: "Invalid pattern",
      cwds: testCwds("/work/company-b"),
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-c/project-1"),
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-common-ancestor-review"],
      },
    });

    expect(() => generalizeLearningScopes([valid, invalid], [])).toThrow(
      'Cannot generalize learning "Invalid pattern"',
    );
    expect(valid.cwds).toEqual(testCwds("/work/company-a/project-1", "/work/company-a/project-2"));
  });
});

// --- findScopeReviewCandidates ---

describe("findScopeReviewCandidates", () => {
  test("entry with 3+ CWDs and not nonglobal is returned", () => {
    const entry = makeEntry({ cwds: testCwds("/a", "/b", "/c") });
    expect(findScopeReviewCandidates([entry])).toHaveLength(1);
  });

  test("entry with 2 CWDs is not returned", () => {
    const entry = makeEntry({ cwds: testCwds("/a", "/b") });
    expect(findScopeReviewCandidates([entry])).toHaveLength(0);
  });

  test("nonglobal entry is not returned", () => {
    const entry = makeEntry({ cwds: testCwds("/a", "/b", "/c"), nonglobal: true });
    expect(findScopeReviewCandidates([entry])).toHaveLength(0);
  });

  test("already global entry is not returned", () => {
    const entry = makeEntry({ cwds: ["*"] });
    expect(findScopeReviewCandidates([entry])).toHaveLength(0);
  });

  test("ancestor-scoped entry uses independent effective source evidence", () => {
    const entry = makeEntry({
      cwds: testCwds("/company-a"),
      promotionEvidence: {
        sourceCwds: testCwds("/company-a/a", "/company-a/b", "/company-a/c"),
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-common-ancestor-review"],
      },
    });

    expect(findScopeReviewCandidates([entry])).toEqual([entry]);
  });

  test("nested and excluded sources do not satisfy the independent-root threshold", () => {
    const entry = makeEntry({
      cwds: testCwds("/company-a/a"),
      promotionEvidence: {
        sourceCwds: testCwds(
          "/company-a/a",
          "/company-a/a/package",
          "/company-a/b",
          "/company-a/c",
        ),
        excludedCwds: testCwds("/company-a/b", "/company-a/c"),
        exposures: [],
        reasons: ["manual-scope-correction"],
      },
    });

    expect(findScopeReviewCandidates([entry])).toEqual([]);
  });

  test("entries with any exclusion are never widening candidates", () => {
    const entry = makeEntry({
      cwds: testCwds("/a", "/b", "/c"),
      promotionEvidence: {
        sourceCwds: testCwds("/a", "/b", "/c", "/d"),
        excludedCwds: testCwds("/d"),
        exposures: [],
        reasons: ["manual-scope-correction"],
      },
    });

    expect(findScopeReviewCandidates([entry])).toEqual([]);
  });
});

// --- promoteToGlobal / markNonglobal ---

describe("promoteToGlobal", () => {
  test("sets cwds to [*]", () => {
    const result = promoteToGlobal(
      makeEntry({ cwds: testCwds("/a", "/b", "/c") }),
      "automatic-cross-project-threshold",
    );
    expect(result.cwds).toEqual(["*"]);
  });

  test("snapshots the evidence that justified global scope", () => {
    const source = makeEntry({
      cwds: testCwds("/a", "/b", "/c"),
      exposures: [
        { date: "2026-02-09", sessionHash: "aaaa0000" },
        { date: "2026-02-11", sessionHash: "bbbb0000" },
      ],
    });

    const result = promoteToGlobal(source, "automatic-cross-project-threshold");
    source.cwds.push(testCwd("/d"));
    source.exposures.push({ date: "2026-02-12", sessionHash: "cccc0000" });

    expect(result.promotionEvidence).toEqual({
      sourceCwds: testCwds("/a", "/b", "/c"),
      excludedCwds: [],
      exposures: [
        { date: "2026-02-09", sessionHash: "aaaa0000" },
        { date: "2026-02-11", sessionHash: "bbbb0000" },
      ],
      reasons: ["automatic-cross-project-threshold"],
    });
  });

  test("records the reviewed reason when evidence already exists", () => {
    const result = promoteToGlobal(
      makeEntry({
        cwds: testCwds("/company-a"),
        promotionEvidence: {
          sourceCwds: testCwds("/company-a/a", "/company-a/b", "/company-a/c"),
          excludedCwds: [],
          exposures: [],
          reasons: ["manual-common-ancestor-review"],
        },
      }),
      "manual-global-review",
    );

    expect(result.promotionEvidence.reasons).toEqual([
      "manual-common-ancestor-review",
      "manual-global-review",
    ]);
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
    expect(prompt).toContain("0-2 learnings");
    expect(prompt).toContain("return exactly `None.`");
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
  test("parses valid entries", () => {
    const raw = `## Summary

Some summary here.

## Learnings

### (correction) Use Bun.file() instead of fs.readFile()

This project uses Bun runtime.

### (preference) No emojis in comments

User prefers no emojis.`;

    const result = parseExtractedLearnings(raw);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("Expected valid extraction");
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      category: "correction",
      title: "Use Bun.file() instead of fs.readFile()",
      body: "This project uses Bun runtime.",
    });
  });

  test("distinguishes missing and valid empty Learnings sections", () => {
    expect(parseExtractedLearnings("## Summary\nDone.")).toEqual({ status: "missing" });
    expect(parseExtractedLearnings("## Learnings\n\n")).toEqual({
      status: "valid",
      entries: [],
    });
    expect(parseExtractedLearnings("## Learnings\n\nNone.\n")).toEqual({
      status: "valid",
      entries: [],
    });
  });

  test("one malformed block rejects the entire section", () => {
    const raw = `## Learnings

### Not a valid format

Some text.

### (correction) Valid entry

Body.`;

    const result = parseExtractedLearnings(raw);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") throw new Error("Expected malformed extraction");
    expect(result.issues).toContain("Invalid learning heading: Not a valid format");
  });

  test("a bare level-three heading after a valid draft rejects the entire section", () => {
    const result = parseExtractedLearnings(`## Learnings

### (fact) Valid learning

Learning body.

###

Malformed body.`);

    expect(result.status).toBe("malformed");
  });

  test("a level-three heading without a separator after a valid draft rejects the section", () => {
    const result = parseExtractedLearnings(`## Learnings

### (fact) Valid learning

Learning body.

###(pattern) Missing space

Malformed body.`);

    expect(result.status).toBe("malformed");
  });

  test("invalid category makes the section malformed", () => {
    const raw = `## Learnings

### (invalid) Bad category

Body.`;

    expect(parseExtractedLearnings(raw).status).toBe("malformed");
  });

  test("bounds Learnings at the next level-two heading", () => {
    const result = parseExtractedLearnings(`## Learnings

### (fact) Valid learning

Learning body.

## Knowledge

### This is not a learning

Knowledge body.`);

    expect(result).toEqual({
      status: "valid",
      entries: [{ category: "fact", title: "Valid learning", body: "Learning body." }],
    });
  });

  test("rejects duplicate Learnings headings regardless of section contents", () => {
    expect(
      parseExtractedLearnings(`## Learnings

## Summary

Done.

## Learnings

### (fact) Later learning

Body.`).status,
    ).toBe("malformed");
    expect(
      parseExtractedLearnings(`## Learnings

### (fact) First learning

Body.

## Learnings

### malformed`).status,
    ).toBe("malformed");
  });

  test("rejects None sentinel combined with learning blocks", () => {
    expect(
      parseExtractedLearnings(`## Learnings

None.

### (fact) Contradictory learning

Body.`).status,
    ).toBe("malformed");
  });

  test("rejects unknown text outside a learning block", () => {
    expect(
      parseExtractedLearnings(`## Learnings

Unexpected prose.

### (fact) Valid learning

Body.`).status,
    ).toBe("malformed");
  });
});

// --- Consolidation: Pass 1 ---

// --- Quality Assessment ---

describe("buildQualityAssessmentPrompt", () => {
  test("includes numbered entries with exposure counts", () => {
    const entries = [
      makeEntry({
        title: "First",
        body: "Body one",
        exposures: [{ date: "2026-02-10", sessionHash: "aaaa0000" }],
      }),
      makeEntry({
        title: "Second",
        body: "Body two",
        exposures: [
          { date: "2026-02-10", sessionHash: "bbbb0000" },
          { date: "2026-02-11", sessionHash: "cccc0000" },
        ],
      }),
    ];
    const prompt = buildQualityAssessmentPrompt(entries);
    expect(prompt).toContain("[1] (correction) First [1 exposure(s)]");
    expect(prompt).toContain("[2] (correction) Second [2 exposure(s)]");
    expect(prompt).toContain("LOW [N]");
  });
});

describe("parseQualityAssessmentOutput", () => {
  test("parses LOW verdicts", () => {
    const raw = `LOW [2] — Generic engineering advice
LOW [5] — One-time code review finding`;
    const verdicts = parseQualityAssessmentOutput(raw);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({ index: 1, reason: "Generic engineering advice" });
    expect(verdicts[1]).toEqual({ index: 4, reason: "One-time code review finding" });
  });

  test("returns empty for ALL HIGH QUALITY", () => {
    expect(parseQualityAssessmentOutput("ALL HIGH QUALITY")).toEqual([]);
  });

  test("ignores malformed lines", () => {
    const raw = `LOW [3] — Valid reason
Not a valid line
LOW [] — Missing index`;
    const verdicts = parseQualityAssessmentOutput(raw);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.index).toBe(2);
  });
});

// --- filterLearnings ---

describe("filterLearnings", () => {
  const entries = [
    makeEntry({
      title: "Path check",
      cwds: testCwds("/Users/j/Documents/shaka"),
      body: "Use relative",
    }),
    makeEntry({
      title: "USD cents",
      cwds: testCwds("/Users/j/Documents/arbitrage/sasori"),
      body: "Mills",
    }),
    makeEntry({ title: "Global rule", cwds: ["*"], body: "Always do this" }),
    makeEntry({
      title: "Whitenoise pattern",
      cwds: testCwds("/Users/j/Documents/whitenoise/whitenoise-rs"),
      body: "Interior mutability",
    }),
  ];

  test("empty query returns all", () => {
    expect(filterLearnings(entries, "")).toHaveLength(4);
  });

  test("'all' returns all", () => {
    expect(filterLearnings(entries, "all")).toHaveLength(4);
  });

  test("filters by CWD path substring", () => {
    const result = filterLearnings(entries, "sasori");
    // sasori entry + global entry
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.title)).toContain("USD cents");
    expect(result.map((e) => e.title)).toContain("Global rule");
  });

  test("global entries always included in project filter", () => {
    const result = filterLearnings(entries, "shaka");
    expect(result.map((e) => e.title)).toContain("Global rule");
    expect(result.map((e) => e.title)).toContain("Path check");
  });

  test("'global' keyword shows only global entries", () => {
    const result = filterLearnings(entries, "global");
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Global rule");
  });

  test("matches title text", () => {
    const result = filterLearnings(entries, "whitenoise");
    expect(result).toHaveLength(2); // whitenoise + global
    expect(result.map((e) => e.title)).toContain("Whitenoise pattern");
  });

  test("matches body text", () => {
    const result = filterLearnings(entries, "mutability");
    expect(result).toHaveLength(2); // whitenoise (body match) + global
  });

  test("case insensitive", () => {
    const result = filterLearnings(entries, "SASORI");
    expect(result).toHaveLength(2);
  });

  test("no matches returns only global", () => {
    const result = filterLearnings(entries, "nonexistent");
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Global rule");
  });
});

// --- sortByExposures ---

describe("sortByExposures", () => {
  test("sorts by exposure count descending", () => {
    const entries = [
      makeEntry({ title: "One", exposures: [{ date: "2026-02-10", sessionHash: "aaaa0000" }] }),
      makeEntry({
        title: "Three",
        exposures: [
          { date: "2026-02-10", sessionHash: "bbbb0000" },
          { date: "2026-02-11", sessionHash: "cccc0000" },
          { date: "2026-02-12", sessionHash: "dddd0000" },
        ],
      }),
      makeEntry({
        title: "Two",
        exposures: [
          { date: "2026-02-10", sessionHash: "eeee0000" },
          { date: "2026-02-11", sessionHash: "ffff0000" },
        ],
      }),
    ];
    const sorted = sortByExposures(entries);
    expect(sorted.map((e) => e.title)).toEqual(["Three", "Two", "One"]);
  });

  test("does not mutate original array", () => {
    const entries = [
      makeEntry({ title: "B", exposures: [{ date: "2026-02-10", sessionHash: "aaaa0000" }] }),
      makeEntry({
        title: "A",
        exposures: [
          { date: "2026-02-10", sessionHash: "bbbb0000" },
          { date: "2026-02-11", sessionHash: "cccc0000" },
        ],
      }),
    ];
    sortByExposures(entries);
    expect(entries[0]?.title).toBe("B");
  });
});
