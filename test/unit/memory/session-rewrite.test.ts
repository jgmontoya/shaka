import { describe, expect, test } from "bun:test";
import type { LearningEntry } from "../../../src/memory/learnings";
import {
  SessionRewriteValidationError,
  rewriteSessionLearnings,
  validateSessionRewriteInput,
} from "../../../src/memory/session-rewrite";
import { testCwd, testCwdInput, testCwds } from "../../helpers/memory-path";

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    category: "correction",
    cwds: testCwds("/work/company-a/project-1"),
    exposures: [{ date: "2026-07-01", sessionHash: "old" }],
    nonglobal: false,
    title: "Use the project convention",
    body: "Follow the existing project convention.",
    ...overrides,
  };
}

describe("rewriteSessionLearnings", () => {
  test("reinforcement extends a global learning's positive evidence", () => {
    const existing = entry({
      cwds: ["*"],
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-a/project-1"),
        excludedCwds: [],
        exposures: [{ date: "2026-07-01", sessionHash: "old" }],
        reasons: ["legacy-source-reconstruction"],
      },
    });

    const result = rewriteSessionLearnings(
      [existing],
      [
        {
          category: "fact",
          title: existing.title,
          body: "Fresh prose is not allowed to replace persisted prose.",
        },
      ],
      { date: "2026-07-21", sessionHash: "new", currentCwd: testCwd("/work/company-b/project-2") },
    );

    expect(result.entries).toEqual([
      {
        ...existing,
        exposures: [
          { date: "2026-07-01", sessionHash: "old" },
          { date: "2026-07-21", sessionHash: "new" },
        ],
        promotionEvidence: {
          sourceCwds: testCwds("/work/company-a/project-1", "/work/company-b/project-2"),
          excludedCwds: [],
          exposures: [
            { date: "2026-07-01", sessionHash: "old" },
            { date: "2026-07-21", sessionHash: "new" },
          ],
          reasons: ["legacy-source-reconstruction"],
        },
      },
    ]);
    expect(result.counts).toEqual({
      appended: 0,
      rewritten: 0,
      reinforced: 1,
      suppressed: 0,
      ambiguousTitles: 0,
      primaryExposuresRemoved: 0,
      orphansRemoved: 0,
      durableEntriesRetained: 0,
    });
  });

  test("reinforcement does not fabricate evidence for an evidence-less legacy global", () => {
    const existing = entry({ cwds: ["*"] });

    const result = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Ignored draft prose." }],
      { date: "2026-07-21", sessionHash: "new", currentCwd: testCwd("/work/another-project") },
    );

    expect(result.entries[0]).toEqual({
      ...existing,
      exposures: [
        { date: "2026-07-01", sessionHash: "old" },
        { date: "2026-07-21", sessionHash: "new" },
      ],
    });
    expect(result.entries[0]?.promotionEvidence).toBeUndefined();
  });

  test("reinforcement outside an active ancestor adds the exact active CWD", () => {
    const existing = entry({
      cwds: testCwds("/work/company-a"),
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-a/project-1"),
        excludedCwds: [],
        exposures: [{ date: "2026-07-01", sessionHash: "old" }],
        reasons: ["manual-common-ancestor-review"],
      },
    });

    const result = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Ignored." }],
      {
        date: "2026-07-21",
        sessionHash: "new",
        currentCwd: testCwdInput("/work/company-b/project-2/"),
      },
    );

    expect(result.entries[0]?.cwds).toEqual(
      testCwds("/work/company-a", "/work/company-b/project-2"),
    );
    expect(result.entries[0]?.promotionEvidence?.sourceCwds).toEqual(
      testCwds("/work/company-a/project-1", "/work/company-b/project-2"),
    );
  });

  test("an active descendant does not claim to cover reinforcement at its ancestor", () => {
    const existing = entry({ cwds: testCwds("/work/project/src") });

    const [updated] = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Ignored." }],
      { date: "2026-07-21", sessionHash: "new", currentCwd: testCwd("/work/project") },
    ).entries;

    expect(updated?.cwds).toEqual(testCwds("/work/project", "/work/project/src"));
  });

  test("reinforcement under an active ancestor preserves it and records the exact source", () => {
    const existing = entry({
      cwds: testCwds("/work/company-a"),
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-a/project-1"),
        excludedCwds: [],
        exposures: [],
        reasons: ["manual-common-ancestor-review"],
      },
    });

    const [updated] = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Ignored." }],
      { date: "2026-07-21", sessionHash: "new", currentCwd: testCwd("/work/company-a/project-2") },
    ).entries;

    expect(updated?.cwds).toEqual(testCwds("/work/company-a"));
    expect(updated?.promotionEvidence?.sourceCwds).toEqual(
      testCwds("/work/company-a/project-1", "/work/company-a/project-2"),
    );
  });

  test("an exclusion suppresses reinforcement after retracting the session's primary exposure", () => {
    const existing = entry({
      cwds: testCwds("/work/company-a/project-1"),
      exposures: [{ date: "2026-07-01", sessionHash: "rewritten" }],
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-a/project-1", "/work/company-b/project-2"),
        excludedCwds: testCwds("/work/company-b"),
        exposures: [{ date: "2026-07-01", sessionHash: "rewritten" }],
        reasons: ["manual-scope-correction"],
      },
    });

    const result = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Must not recreate this correction." }],
      {
        date: "2026-07-21",
        sessionHash: "rewritten",
        currentCwd: testCwd("/work/company-b/project-3"),
      },
    );

    expect(result.entries).toEqual([{ ...existing, exposures: [] }]);
    expect(result.counts).toEqual({
      appended: 0,
      rewritten: 0,
      reinforced: 0,
      suppressed: 1,
      ambiguousTitles: 0,
      primaryExposuresRemoved: 1,
      orphansRemoved: 0,
      durableEntriesRetained: 1,
    });
  });

  test("a valid empty rewrite removes an ordinary orphan", () => {
    const existing = entry({
      exposures: [
        { date: "2026-07-01", sessionHash: "rewritten" },
        { date: "2026-07-02", sessionHash: "rewritten" },
      ],
    });

    const result = rewriteSessionLearnings([existing], [], {
      date: "2026-07-21",
      sessionHash: "rewritten",
      currentCwd: testCwd("/work/company-a/project-1"),
    });

    expect(result.entries).toEqual([]);
    expect(result.counts.primaryExposuresRemoved).toBe(2);
    expect(result.counts.orphansRemoved).toBe(1);
  });

  test("a valid empty rewrite retains reviewed nonglobal state without a primary exposure", () => {
    const existing = entry({
      nonglobal: true,
      exposures: [{ date: "2026-07-01", sessionHash: "rewritten" }],
    });

    const result = rewriteSessionLearnings([existing], [], {
      date: "2026-07-21",
      sessionHash: "rewritten",
      currentCwd: testCwd("/work/company-a/project-1"),
    });

    expect(result.entries).toEqual([{ ...existing, exposures: [] }]);
    expect(result.counts.durableEntriesRetained).toBe(1);
  });

  test("new titles append in collapsed extraction order using the first draft", () => {
    const result = rewriteSessionLearnings(
      [],
      [
        { category: "correction", title: "First", body: "First body." },
        { category: "preference", title: "Second", body: "Second body." },
        { category: "fact", title: "First", body: "Discarded duplicate." },
      ],
      {
        date: "2026-07-21",
        sessionHash: "new",
        currentCwd: testCwdInput("/work/project/../project"),
      },
    );

    expect(result.entries).toEqual([
      {
        category: "correction",
        cwds: testCwds("/work/project"),
        exposures: [{ date: "2026-07-21", sessionHash: "new" }],
        nonglobal: false,
        title: "First",
        body: "First body.",
      },
      {
        category: "preference",
        cwds: testCwds("/work/project"),
        exposures: [{ date: "2026-07-21", sessionHash: "new" }],
        nonglobal: false,
        title: "Second",
        body: "Second body.",
      },
    ]);
    expect(result.counts.appended).toBe(2);
  });

  test("a sole ordinary match is rewritten in place from the collapsed draft", () => {
    const before = entry({
      title: "Before",
      exposures: [{ date: "2026-06-01", sessionHash: "a" }],
    });
    const replaced = entry({
      category: "fact",
      title: "Target",
      body: "Old prose.",
      exposures: [{ date: "2026-07-01", sessionHash: "rewritten" }],
    });
    const after = entry({ title: "After", exposures: [{ date: "2026-06-02", sessionHash: "b" }] });

    const result = rewriteSessionLearnings(
      [before, replaced, after],
      [
        { category: "preference", title: "Target", body: "Corrected prose." },
        { category: "correction", title: "Target", body: "Discarded prose." },
      ],
      {
        date: "2026-07-21",
        sessionHash: "rewritten",
        currentCwd: testCwd("/work/replacement"),
      },
    );

    expect(result.entries).toEqual([
      before,
      {
        category: "preference",
        cwds: testCwds("/work/replacement"),
        exposures: [{ date: "2026-07-21", sessionHash: "rewritten" }],
        nonglobal: false,
        title: "Target",
        body: "Corrected prose.",
      },
      after,
    ]);
    expect(result.counts.rewritten).toBe(1);
    expect(result.counts.orphansRemoved).toBe(0);
  });

  test("original duplicate titles remain ambiguous after exposure removal deletes one member", () => {
    const removed = entry({
      title: "Duplicate",
      body: "Removed member.",
      exposures: [{ date: "2026-07-01", sessionHash: "rewritten" }],
    });
    const retained = entry({
      title: "Duplicate",
      body: "Retained member.",
      exposures: [{ date: "2026-07-02", sessionHash: "other" }],
    });

    const result = rewriteSessionLearnings(
      [removed, retained],
      [
        { category: "fact", title: "Duplicate", body: "Must not resolve ambiguity." },
        { category: "pattern", title: "Duplicate", body: "Collapsed duplicate." },
      ],
      {
        date: "2026-07-21",
        sessionHash: "rewritten",
        currentCwd: testCwd("/work/project"),
      },
    );

    expect(result.entries).toEqual([retained]);
    expect(result.counts.ambiguousTitles).toBe(1);
    expect(result.counts.orphansRemoved).toBe(1);
    expect(result.counts.reinforced).toBe(0);
  });

  test("reinforcement preserves persisted prose and intent while canonicalizing exposures", () => {
    const existing = entry({
      category: "preference",
      body: "Persisted prose.",
      nonglobal: true,
      exposures: [
        { date: "2026-07-10", sessionHash: "later" },
        { date: "2026-07-01", sessionHash: "first" },
        { date: "2026-07-01", sessionHash: "first" },
      ],
    });

    const [updated] = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Draft prose." }],
      {
        date: "2026-07-05",
        sessionHash: "current",
        currentCwd: testCwd("/work/company-a/project-1"),
      },
    ).entries;

    expect(updated).toEqual({
      ...existing,
      exposures: [
        { date: "2026-07-01", sessionHash: "first" },
        { date: "2026-07-05", sessionHash: "current" },
        { date: "2026-07-10", sessionHash: "later" },
      ],
    });
  });

  test("session retraction never removes the monotonic promotion-evidence snapshot", () => {
    const existing = entry({
      cwds: ["*"],
      exposures: [
        { date: "2026-07-01", sessionHash: "rewritten" },
        { date: "2026-07-02", sessionHash: "other" },
      ],
      promotionEvidence: {
        sourceCwds: testCwds("/work/company-a/project-1"),
        excludedCwds: [],
        exposures: [
          { date: "2026-07-01", sessionHash: "rewritten" },
          { date: "2026-07-01", sessionHash: "rewritten" },
        ],
        reasons: ["legacy-source-reconstruction"],
      },
    });

    const result = rewriteSessionLearnings(
      [existing],
      [{ category: "fact", title: existing.title, body: "Ignored." }],
      {
        date: "2026-07-21",
        sessionHash: "rewritten",
        currentCwd: testCwd("/work/company-a/project-1"),
      },
    );

    expect(result.entries[0]?.exposures).toEqual([
      { date: "2026-07-02", sessionHash: "other" },
      { date: "2026-07-21", sessionHash: "rewritten" },
    ]);
    expect(result.entries[0]?.promotionEvidence?.exposures).toEqual([
      { date: "2026-07-01", sessionHash: "rewritten" },
      { date: "2026-07-21", sessionHash: "rewritten" },
    ]);
    expect(result.counts.primaryExposuresRemoved).toBe(1);
  });

  test("the pure transition refuses invalid input instead of creating invalid persisted state", () => {
    expect(() =>
      rewriteSessionLearnings([], [{ category: "fact", title: "Title", body: "Body." }], {
        date: "2026-02-30",
        sessionHash: "hash",
        currentCwd: "relative/project",
      }),
    ).toThrow(SessionRewriteValidationError);
  });
});

describe("validateSessionRewriteInput", () => {
  test("accepts valid drafts and returns a normalized absolute CWD", () => {
    const drafts = [{ category: "fact" as const, title: "A title", body: "" }];

    const result = validateSessionRewriteInput(drafts, {
      date: "2024-02-29",
      sessionHash: "abcd1234",
      currentCwd: testCwdInput("/work/project/../project/"),
    });

    expect(result).toEqual({
      ok: true,
      extracted: drafts,
      context: {
        date: "2024-02-29",
        sessionHash: "abcd1234",
        currentCwd: testCwd("/work/project"),
      },
    });
  });

  test("rejects malformed drafts and context with deterministic typed issues", () => {
    const result = validateSessionRewriteInput(
      [
        {
          category: "unknown",
          title: "  ",
          body: 42,
        } as never,
        undefined as never,
      ],
      {
        date: "2026-02-30",
        sessionHash: "",
        currentCwd: "relative/project",
      },
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "invalid-category",
          draftIndex: 0,
          message: "A learning draft must use a supported category.",
        },
        {
          code: "invalid-title",
          draftIndex: 0,
          message: "A learning draft must have a non-empty title.",
        },
        {
          code: "invalid-body",
          draftIndex: 0,
          message: "A learning draft body must be a string.",
        },
        {
          code: "invalid-draft",
          draftIndex: 1,
          message: "A learning draft must be an object.",
        },
        { code: "invalid-date", message: "The rewrite date must be a valid YYYY-MM-DD date." },
        {
          code: "invalid-session-hash",
          message: "The rewrite session hash must be non-empty.",
        },
        {
          code: "invalid-current-cwd",
          message: "The rewrite CWD must be a normalizable absolute path.",
        },
      ],
    });
  });

  test("rejects draft-supplied storage metadata", () => {
    const result = validateSessionRewriteInput(
      [
        {
          category: "fact",
          title: "A title",
          body: "A body.",
          cwds: ["*"],
          exposures: [],
          nonglobal: true,
        } as never,
      ],
      { date: "2026-07-21", sessionHash: "hash", currentCwd: testCwd("/work/project") },
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "unknown-draft-field",
          draftIndex: 0,
          message: "A learning draft may contain only category, title, and body.",
        },
      ],
    });
  });
});
