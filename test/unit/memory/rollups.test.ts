import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Rollup,
  type RollupPeriod,
  archiveRollup,
  buildDailyUpdatePrompt,
  buildFoldPrompt,
  currentIsoWeek,
  currentMonth,
  findMatchingProjects,
  gatherMonthWeeklies,
  gatherTodaySessions,
  gatherWeekDailies,
  isoWeekString,
  loadRollup,
  loadRollups,
  needsRollover,
  parseRollupFile,
  projectDir,
  projectSlug,
  serializeRollup,
  todayDateString,
  weekBelongsToMonth,
  writeRollup,
} from "../../../src/memory/rollups";
import type { SummaryIndex } from "../../../src/memory/storage";

const testDir = join(tmpdir(), `shaka-rollups-test-${process.pid}`);

function makeRollup(overrides: Partial<Rollup> = {}): Rollup {
  return {
    period: overrides.period ?? "daily",
    cwd: overrides.cwd ?? "/Users/j/Documents/shaka",
    date: overrides.date ?? "2026-02-22",
    lastUpdated: overrides.lastUpdated ?? "2026-02-22T17:30:00Z",
    sessionCount: overrides.sessionCount ?? 3,
    body: overrides.body ?? "- Fixed auth bug\n- Started rollups feature",
  };
}

function makeRollupContent(rollup: Rollup): string {
  return serializeRollup(rollup);
}

describe("Rollups", () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // --- Date helpers ---

  describe("todayDateString", () => {
    test("returns YYYY-MM-DD format", () => {
      const result = todayDateString(new Date("2026-02-22T12:00:00Z"));
      expect(result).toBe("2026-02-22");
    });

    test("handles year boundaries", () => {
      const result = todayDateString(new Date("2027-01-01T00:00:00Z"));
      expect(result).toBe("2027-01-01");
    });

    test("pads single-digit months and days", () => {
      const result = todayDateString(new Date("2026-03-05T12:00:00Z"));
      expect(result).toBe("2026-03-05");
    });
  });

  describe("isoWeekString", () => {
    test("returns correct ISO week", () => {
      // Feb 22, 2026 is a Sunday in ISO week 8
      const result = isoWeekString(new Date("2026-02-22T12:00:00Z"));
      expect(result).toBe("2026-W08");
    });

    test("handles ISO week 1 edge case (Jan 1 may be in previous year's last week)", () => {
      // Jan 1, 2026 is a Thursday → ISO week 1 of 2026
      const result = isoWeekString(new Date("2026-01-01T12:00:00Z"));
      expect(result).toBe("2026-W01");
    });

    test("handles year boundary where Jan 1 belongs to previous year", () => {
      // Jan 1, 2027 is a Friday → ISO week 53 of 2026
      const result = isoWeekString(new Date("2027-01-01T12:00:00Z"));
      expect(result).toBe("2026-W53");
    });

    test("handles Monday at week boundary", () => {
      // Feb 23, 2026 is a Monday → start of W09
      const result = isoWeekString(new Date("2026-02-23T12:00:00Z"));
      expect(result).toBe("2026-W09");
    });
  });

  describe("currentIsoWeek", () => {
    test("delegates to isoWeekString", () => {
      const date = new Date("2026-02-22T12:00:00Z");
      expect(currentIsoWeek(date)).toBe(isoWeekString(date));
    });
  });

  describe("currentMonth", () => {
    test("returns YYYY-MM format", () => {
      expect(currentMonth(new Date("2026-02-22T12:00:00Z"))).toBe("2026-02");
    });

    test("handles December→January", () => {
      expect(currentMonth(new Date("2027-01-01T12:00:00Z"))).toBe("2027-01");
    });
  });

  // --- Project identification ---

  describe("projectSlug", () => {
    test("replaces slashes with dashes", () => {
      expect(projectSlug("/Users/j/Documents/shaka")).toBe("-Users-j-Documents-shaka");
    });

    test("handles paths with dots", () => {
      expect(projectSlug("/Users/j/Documents/whitenoise/dr.marmot")).toBe(
        "-Users-j-Documents-whitenoise-dr.marmot",
      );
    });

    test("handles root path", () => {
      expect(projectSlug("/")).toBe("-");
    });

    test("handles Windows backslashes", () => {
      expect(projectSlug("C:\\Users\\j\\Documents\\shaka")).toBe(
        "C-Users-j-Documents-shaka",
      );
    });

    test("strips Windows drive colon", () => {
      expect(projectSlug("D:\\Projects\\api")).toBe("D-Projects-api");
    });

    test("handles mixed separators", () => {
      expect(projectSlug("C:\\Users/j\\Documents/shaka")).toBe(
        "C-Users-j-Documents-shaka",
      );
    });
  });

  describe("projectDir", () => {
    test("joins rollups dir with slug", () => {
      const result = projectDir("/memory/rollups", "/Users/j/Documents/shaka");
      expect(result).toBe(join("/memory/rollups", "-Users-j-Documents-shaka"));
    });
  });

  // --- Period detection ---

  describe("needsRollover", () => {
    test("daily: same day returns false", () => {
      const rollup = makeRollup({ period: "daily", date: "2026-02-22" });
      expect(needsRollover(rollup, new Date("2026-02-22T18:00:00Z"))).toBe(false);
    });

    test("daily: different day returns true", () => {
      const rollup = makeRollup({ period: "daily", date: "2026-02-21" });
      expect(needsRollover(rollup, new Date("2026-02-22T08:00:00Z"))).toBe(true);
    });

    test("weekly: same week returns false", () => {
      const rollup = makeRollup({ period: "weekly", date: "2026-W08" });
      // Feb 22 is Sunday of W08
      expect(needsRollover(rollup, new Date("2026-02-22T12:00:00Z"))).toBe(false);
    });

    test("weekly: different week returns true", () => {
      const rollup = makeRollup({ period: "weekly", date: "2026-W07" });
      expect(needsRollover(rollup, new Date("2026-02-22T12:00:00Z"))).toBe(true);
    });

    test("monthly: same month returns false", () => {
      const rollup = makeRollup({ period: "monthly", date: "2026-02" });
      expect(needsRollover(rollup, new Date("2026-02-28T12:00:00Z"))).toBe(false);
    });

    test("monthly: different month returns true", () => {
      const rollup = makeRollup({ period: "monthly", date: "2026-01" });
      expect(needsRollover(rollup, new Date("2026-02-01T12:00:00Z"))).toBe(true);
    });

    test("monthly: Dec→Jan rollover", () => {
      const rollup = makeRollup({ period: "monthly", date: "2026-12" });
      expect(needsRollover(rollup, new Date("2027-01-01T12:00:00Z"))).toBe(true);
    });
  });

  // --- weekBelongsToMonth ---

  describe("weekBelongsToMonth", () => {
    test("mid-month week belongs to its month", () => {
      // W08 of 2026: Feb 16-22 → Thursday is Feb 19 → month is 2026-02
      expect(weekBelongsToMonth("2026-W08", "2026-02")).toBe(true);
    });

    test("mid-month week does not belong to adjacent month", () => {
      expect(weekBelongsToMonth("2026-W08", "2026-03")).toBe(false);
    });

    test("boundary week: Thursday determines the month", () => {
      // W05 of 2026: Jan 26 – Feb 1. Thursday is Jan 29 → belongs to January
      expect(weekBelongsToMonth("2026-W05", "2026-01")).toBe(true);
      expect(weekBelongsToMonth("2026-W05", "2026-02")).toBe(false);
    });

    test("invalid week returns false", () => {
      expect(weekBelongsToMonth("not-a-week", "2026-02")).toBe(false);
    });
  });

  // --- Parsing ---

  describe("parseRollupFile", () => {
    test("parses valid rollup content", () => {
      const content = `---
period: daily
cwd: "/Users/j/Documents/shaka"
date: "2026-02-22"
last_updated: "2026-02-22T17:30:00Z"
session_count: 3
---

- Fixed auth bug
- Started rollups feature`;

      const rollup = parseRollupFile(content);
      expect(rollup).not.toBeNull();
      expect(rollup!.period).toBe("daily");
      expect(rollup!.cwd).toBe("/Users/j/Documents/shaka");
      expect(rollup!.date).toBe("2026-02-22");
      expect(rollup!.sessionCount).toBe(3);
      expect(rollup!.body).toBe("- Fixed auth bug\n- Started rollups feature");
    });

    test("returns null for missing period", () => {
      const content = `---
cwd: "/test"
date: "2026-02-22"
---

- Some items`;
      expect(parseRollupFile(content)).toBeNull();
    });

    test("returns null for missing cwd", () => {
      const content = `---
period: daily
date: "2026-02-22"
---

- Some items`;
      expect(parseRollupFile(content)).toBeNull();
    });

    test("returns null for missing date", () => {
      const content = `---
period: daily
cwd: "/test"
---

- Some items`;
      expect(parseRollupFile(content)).toBeNull();
    });

    test("returns null for corrupt YAML", () => {
      expect(parseRollupFile("not yaml at all")).toBeNull();
    });

    test("handles empty body", () => {
      const content = `---
period: weekly
cwd: "/test"
date: "2026-W08"
---
`;
      const rollup = parseRollupFile(content);
      expect(rollup).not.toBeNull();
      expect(rollup!.body).toBe("");
    });

    test("defaults sessionCount to 0 when missing", () => {
      const content = `---
period: weekly
cwd: "/test"
date: "2026-W08"
---

- Some content`;
      const rollup = parseRollupFile(content);
      expect(rollup!.sessionCount).toBe(0);
    });
  });

  describe("serializeRollup / parseRollupFile roundtrip", () => {
    test("roundtrips a daily rollup", () => {
      const original = makeRollup();
      const serialized = serializeRollup(original);
      const parsed = parseRollupFile(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.period).toBe(original.period);
      expect(parsed!.cwd).toBe(original.cwd);
      expect(parsed!.date).toBe(original.date);
      expect(parsed!.sessionCount).toBe(original.sessionCount);
      expect(parsed!.body).toBe(original.body);
    });

    test("roundtrips a weekly rollup", () => {
      const original = makeRollup({
        period: "weekly",
        date: "2026-W08",
        sessionCount: 0,
        body: "- Memory system improvements\n- Slash commands shipped",
      });
      const parsed = parseRollupFile(serializeRollup(original));
      expect(parsed!.period).toBe("weekly");
      expect(parsed!.date).toBe("2026-W08");
    });

    test("roundtrips a monthly rollup", () => {
      const original = makeRollup({
        period: "monthly",
        date: "2026-02",
        sessionCount: 0,
      });
      const parsed = parseRollupFile(serializeRollup(original));
      expect(parsed!.period).toBe("monthly");
      expect(parsed!.date).toBe("2026-02");
    });
  });

  // --- Prompt builders ---

  describe("buildDailyUpdatePrompt", () => {
    test("includes existing daily body when provided", () => {
      const prompt = buildDailyUpdatePrompt("- Existing work", ["### Session 1\n\nDid stuff"]);
      expect(prompt).toContain("<existing_daily>");
      expect(prompt).toContain("- Existing work");
      expect(prompt).toContain("<sessions>");
      expect(prompt).toContain("### Session 1");
    });

    test("uses placeholder when no existing daily", () => {
      const prompt = buildDailyUpdatePrompt(null, ["### Session\n\nNew work"]);
      expect(prompt).toContain("No existing summary yet.");
    });

    test("includes multiple sessions", () => {
      const prompt = buildDailyUpdatePrompt(null, [
        "### Session 1\n\nFirst",
        "### Session 2\n\nSecond",
      ]);
      expect(prompt).toContain("### Session 1");
      expect(prompt).toContain("### Session 2");
    });
  });

  describe("buildFoldPrompt", () => {
    test("weekly fold includes daily summaries", () => {
      const prompt = buildFoldPrompt("weekly", "- Existing weekly", [
        { label: "2026-02-21", body: "- Day work" },
      ]);
      expect(prompt).toContain("<existing_weekly>");
      expect(prompt).toContain("<daily_summaries>");
      expect(prompt).toContain("### 2026-02-21");
    });

    test("monthly fold includes weekly summaries", () => {
      const prompt = buildFoldPrompt("monthly", null, [
        { label: "2026-W07", body: "- Week work" },
        { label: "2026-W08", body: "- More work" },
      ]);
      expect(prompt).toContain("<existing_monthly>");
      expect(prompt).toContain("No existing summary yet.");
      expect(prompt).toContain("<weekly_summaries>");
      expect(prompt).toContain("### 2026-W07");
      expect(prompt).toContain("### 2026-W08");
    });
  });

  // --- Backfill filtering ---

  describe("gatherTodaySessions", () => {
    const summaries: SummaryIndex[] = [
      {
        filePath: "/a.md",
        title: "A",
        date: "2026-02-22",
        cwd: "/Users/j/Documents/shaka",
        tags: [],
        provider: "claude",
        sessionId: "a",
      },
      {
        filePath: "/b.md",
        title: "B",
        date: "2026-02-22",
        cwd: "/Users/j/Documents/other",
        tags: [],
        provider: "claude",
        sessionId: "b",
      },
      {
        filePath: "/c.md",
        title: "C",
        date: "2026-02-21",
        cwd: "/Users/j/Documents/shaka",
        tags: [],
        provider: "claude",
        sessionId: "c",
      },
    ];

    test("filters by date and cwd", () => {
      const result = gatherTodaySessions(summaries, "/Users/j/Documents/shaka", "2026-02-22");
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("A");
    });

    test("returns empty if no matches", () => {
      const result = gatherTodaySessions(summaries, "/Users/j/Documents/shaka", "2026-02-20");
      expect(result).toHaveLength(0);
    });
  });

  // --- I/O ---

  describe("loadRollup", () => {
    test("loads a valid rollup file", async () => {
      const projDir = join(testDir, "project");
      await mkdir(projDir, { recursive: true });
      const rollup = makeRollup();
      await Bun.write(join(projDir, "daily.md"), serializeRollup(rollup));

      const loaded = await loadRollup(join(projDir, "daily.md"));
      expect(loaded).not.toBeNull();
      expect(loaded!.period).toBe("daily");
      expect(loaded!.body).toBe(rollup.body);
    });

    test("returns null for missing file", async () => {
      const loaded = await loadRollup(join(testDir, "nonexistent.md"));
      expect(loaded).toBeNull();
    });
  });

  describe("writeRollup", () => {
    test("writes rollup atomically and is loadable", async () => {
      const projDir = join(testDir, "project");
      const rollup = makeRollup();
      await writeRollup(projDir, "daily", rollup);

      const loaded = await loadRollup(join(projDir, "daily.md"));
      expect(loaded).not.toBeNull();
      expect(loaded!.body).toBe(rollup.body);
    });

    test("creates project directory if needed", async () => {
      const projDir = join(testDir, "new-project");
      await writeRollup(projDir, "weekly", makeRollup({ period: "weekly", date: "2026-W08" }));

      const files = await readdir(projDir);
      expect(files).toContain("weekly.md");
    });
  });

  describe("archiveRollup", () => {
    test("moves active file to archive directory", async () => {
      const projDir = join(testDir, "project");
      await mkdir(projDir, { recursive: true });
      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ date: "2026-02-21" })),
      );

      await archiveRollup(projDir, "daily", "2026-02-21");

      // Active file should be gone
      expect(await Bun.file(join(projDir, "daily.md")).exists()).toBe(false);
      // Archived file should exist
      expect(await Bun.file(join(projDir, "archive", "daily", "2026-02-21.md")).exists()).toBe(
        true,
      );
    });
  });

  describe("gatherWeekDailies", () => {
    test("reads archived dailies for a given ISO week", async () => {
      const projDir = join(testDir, "project");
      const archiveDir = join(projDir, "archive", "daily");
      await mkdir(archiveDir, { recursive: true });

      // W08 2026: Feb 16 (Mon) to Feb 22 (Sun)
      await Bun.write(
        join(archiveDir, "2026-02-18.md"),
        serializeRollup(makeRollup({ date: "2026-02-18" })),
      );
      await Bun.write(
        join(archiveDir, "2026-02-20.md"),
        serializeRollup(makeRollup({ date: "2026-02-20" })),
      );
      // This is W09, should not be included
      await Bun.write(
        join(archiveDir, "2026-02-23.md"),
        serializeRollup(makeRollup({ date: "2026-02-23" })),
      );

      const result = await gatherWeekDailies(projDir, "2026-W08");
      expect(result).toHaveLength(2);
      expect(result[0]!.date).toBe("2026-02-18");
      expect(result[1]!.date).toBe("2026-02-20");
    });

    test("returns empty for nonexistent archive dir", async () => {
      const result = await gatherWeekDailies(join(testDir, "nope"), "2026-W08");
      expect(result).toHaveLength(0);
    });
  });

  describe("gatherMonthWeeklies", () => {
    test("reads archived weeklies for a given month", async () => {
      const projDir = join(testDir, "project");
      const archiveDir = join(projDir, "archive", "weekly");
      await mkdir(archiveDir, { recursive: true });

      // W06 2026: Feb 2-8 → Thursday Feb 5 → 2026-02 ✓
      await Bun.write(
        join(archiveDir, "2026-W06.md"),
        serializeRollup(makeRollup({ period: "weekly", date: "2026-W06" })),
      );
      // W09 2026: Feb 23-Mar 1 → Thursday Feb 26 → 2026-02 ✓
      await Bun.write(
        join(archiveDir, "2026-W09.md"),
        serializeRollup(makeRollup({ period: "weekly", date: "2026-W09" })),
      );
      // W14 2026: Mar 30-Apr 5 → Thursday Apr 2 → 2026-04 ✗
      await Bun.write(
        join(archiveDir, "2026-W14.md"),
        serializeRollup(makeRollup({ period: "weekly", date: "2026-W14" })),
      );

      const result = await gatherMonthWeeklies(projDir, "2026-02");
      expect(result).toHaveLength(2);
      expect(result[0]!.date).toBe("2026-W06");
      expect(result[1]!.date).toBe("2026-W09");
    });
  });

  // --- findMatchingProjects ---

  describe("findMatchingProjects", () => {
    test("finds exact CWD match", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-shaka");
      await mkdir(projDir, { recursive: true });
      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ cwd: "/Users/j/Documents/shaka" })),
      );

      const result = await findMatchingProjects(rollupsDir, "/Users/j/Documents/shaka");
      expect(result).toHaveLength(1);
    });

    test("finds subdirectory match", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-shaka");
      await mkdir(projDir, { recursive: true });
      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ cwd: "/Users/j/Documents/shaka" })),
      );

      const result = await findMatchingProjects(rollupsDir, "/Users/j/Documents/shaka/src");
      expect(result).toHaveLength(1);
    });

    test("does not match unrelated projects", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-other");
      await mkdir(projDir, { recursive: true });
      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ cwd: "/Users/j/Documents/other" })),
      );

      const result = await findMatchingProjects(rollupsDir, "/Users/j/Documents/shaka");
      expect(result).toHaveLength(0);
    });

    test("does not false-match path prefixes (repo vs repo-old)", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-repo");
      await mkdir(projDir, { recursive: true });
      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ cwd: "/Users/j/repo" })),
      );

      const result = await findMatchingProjects(rollupsDir, "/Users/j/repo-old");
      expect(result).toHaveLength(0);
    });

    test("returns empty for nonexistent rollups dir", async () => {
      const result = await findMatchingProjects(join(testDir, "nope"), "/any/path");
      expect(result).toHaveLength(0);
    });
  });

  // --- loadRollups (session-start) ---

  describe("loadRollups", () => {
    test("returns empty string when no rollups exist", async () => {
      const result = await loadRollups(testDir, "/Users/j/Documents/shaka");
      expect(result).toBe("");
    });

    test("returns formatted markdown with all available periods", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-shaka");
      await mkdir(projDir, { recursive: true });

      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ period: "daily", date: "2026-02-22", body: "- Daily work" })),
      );
      await Bun.write(
        join(projDir, "weekly.md"),
        serializeRollup(
          makeRollup({ period: "weekly", date: "2026-W08", body: "- Weekly themes" }),
        ),
      );
      await Bun.write(
        join(projDir, "monthly.md"),
        serializeRollup(
          makeRollup({ period: "monthly", date: "2026-02", body: "- Monthly direction" }),
        ),
      );

      const result = await loadRollups(testDir, "/Users/j/Documents/shaka");
      expect(result).toContain("## Rolling Summaries");
      expect(result).toContain("### Monthly Summary (2026-02)");
      expect(result).toContain("### Weekly Summary (2026-W08)");
      expect(result).toContain("### Daily Summary (2026-02-22)");
      // Monthly should come before weekly, weekly before daily
      const monthlyIdx = result.indexOf("Monthly Summary");
      const weeklyIdx = result.indexOf("Weekly Summary");
      const dailyIdx = result.indexOf("Daily Summary");
      expect(monthlyIdx).toBeLessThan(weeklyIdx);
      expect(weeklyIdx).toBeLessThan(dailyIdx);
    });

    test("skips rollups with empty body", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-shaka");
      await mkdir(projDir, { recursive: true });

      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ period: "daily", body: "" })),
      );
      await Bun.write(
        join(projDir, "weekly.md"),
        serializeRollup(makeRollup({ period: "weekly", date: "2026-W08", body: "- Has content" })),
      );

      const result = await loadRollups(testDir, "/Users/j/Documents/shaka");
      expect(result).not.toContain("Daily Summary");
      expect(result).toContain("Weekly Summary");
    });

    test("matches CWD prefix for subdirectory sessions", async () => {
      const rollupsDir = join(testDir, "rollups");
      const projDir = join(rollupsDir, "-Users-j-Documents-shaka");
      await mkdir(projDir, { recursive: true });

      await Bun.write(
        join(projDir, "daily.md"),
        serializeRollup(makeRollup({ cwd: "/Users/j/Documents/shaka", body: "- Some work" })),
      );

      // CWD is a subdirectory of the rollup's CWD
      const result = await loadRollups(testDir, "/Users/j/Documents/shaka/src");
      expect(result).toContain("## Rolling Summaries");
    });
  });
});
