import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAutoresearchReportModel,
  renderAutoresearchHtml,
} from "../../../src/services/autoresearch-report";

async function makeReportDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `shaka-report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "autoresearch.md"),
    [
      "# Autoresearch: Reduce runtime",
      "",
      "## Objective",
      "",
      "Reduce runtime without breaking correctness.",
      "",
      "## Metric",
      "- command: `./autoresearch.sh`",
      "- direction: minimize",
      "- unit: ms",
      "",
    ].join("\n"),
  );
  await Bun.write(
    join(dir, "autoresearch.meta.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      baseline: {
        ts: "2026-04-27T00:00:00.000Z",
        metric: 100,
        unit: "ms",
        direction: "minimize",
        command: "./autoresearch.sh",
        commit: "abc1234",
      },
    })}\n`,
  );
  await Bun.write(
    join(dir, "autoresearch.jsonl"),
    [
      {
        iter: 1,
        ts: "2026-04-27T00:01:00.000Z",
        provider: "claude",
        hypothesis: "Use a cache for lookups",
        metric: 80,
        unit: "ms",
        verdict: "keep",
        commit: "def5678",
        asi: ["#cache"],
        duration_ms: 1000,
      },
      {
        iter: 2,
        ts: "2026-04-27T00:02:00.000Z",
        provider: "claude",
        hypothesis: "Inline <script>alert(1)</script>",
        metric: 130,
        unit: "ms",
        verdict: "discard",
        commit: null,
        asi: ["#xss"],
        duration_ms: 1000,
      },
      {
        iter: 3,
        ts: "2026-04-27T00:03:00.000Z",
        provider: "claude",
        hypothesis: "Broken candidate",
        metric: null,
        unit: "ms",
        verdict: "crash",
        commit: null,
        asi: [],
        duration_ms: 1000,
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return dir;
}

describe("autoresearch report model", () => {
  test("builds baseline, accepted, rejected, and failed report data", async () => {
    const dir = await makeReportDir();
    try {
      const model = await buildAutoresearchReportModel(dir);

      expect(model.objective).toBe("Reduce runtime without breaking correctness.");
      expect(model.command).toBe("./autoresearch.sh");
      expect(model.baseline.metric).toBe(100);
      expect(model.bestMetric).toBe(80);
      expect(model.improvementPct).toBe(20);
      expect(model.acceptedSeries.map((p) => p.x)).toEqual([0, 1]);
      expect(model.rejectedPoints.map((p) => p.x)).toEqual([2]);
      expect(model.failedIterations.map((r) => r.iter)).toEqual([3]);
      expect(model.iterations[0]?.asi).toEqual(["#cache"]);
      expect(model.acceptedSeries[1]?.changeFromPreviousAcceptedPct).toBe(-20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails clearly when metadata is missing", async () => {
    const dir = await makeReportDir();
    try {
      await rm(join(dir, "autoresearch.meta.json"), { force: true });

      await expect(buildAutoresearchReportModel(dir)).rejects.toThrow(/autoresearch\.meta\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves multi-line Objective bodies", async () => {
    const dir = await makeReportDir();
    try {
      await Bun.write(
        join(dir, "autoresearch.md"),
        [
          "# Autoresearch: Reduce runtime",
          "",
          "## Objective",
          "",
          "Reduce runtime without breaking correctness.",
          "Keep benchmark variance low.",
          "",
          "## Metric",
          "- command: `./autoresearch.sh`",
          "- direction: minimize",
          "- unit: ms",
          "",
        ].join("\n"),
      );

      const model = await buildAutoresearchReportModel(dir);
      expect(model.objective).toBe(
        "Reduce runtime without breaking correctness. Keep benchmark variance low.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores kept entries recorded under a different unit", async () => {
    const dir = await makeReportDir();
    try {
      await Bun.write(
        join(dir, "autoresearch.jsonl"),
        [
          {
            iter: 1,
            ts: "2026-04-27T00:01:00.000Z",
            provider: "claude",
            hypothesis: "Use a cache for lookups",
            metric: 80,
            unit: "ms",
            verdict: "keep",
            commit: "def5678",
            asi: ["#cache"],
            duration_ms: 1000,
          },
          {
            iter: 2,
            ts: "2026-04-27T00:02:00.000Z",
            provider: "claude",
            hypothesis: "Switch to seconds",
            metric: 0.5,
            unit: "s",
            verdict: "keep",
            commit: "feedbee",
            asi: [],
            duration_ms: 1000,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );

      const model = await buildAutoresearchReportModel(dir);
      expect(model.bestMetric).toBe(80);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops a truncated trailing jsonl line while building the report", async () => {
    const dir = await makeReportDir();
    try {
      await Bun.write(
        join(dir, "autoresearch.jsonl"),
        `${await Bun.file(join(dir, "autoresearch.jsonl")).text()}{"iter":4,"hypothesis":"cut off`,
      );

      const model = await buildAutoresearchReportModel(dir);
      expect(model.iterations.map((row) => row.iter)).toEqual([1, 2]);
      expect(model.failedIterations.map((row) => row.iter)).toEqual([3]);

      const persisted = await Bun.file(join(dir, "autoresearch.jsonl")).text();
      expect(persisted).not.toContain('{"iter":4,"hypothesis":"cut off');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("autoresearch report HTML", () => {
  test("renders escaped interactive html with chart tooltip data", async () => {
    const dir = await makeReportDir();
    try {
      const html = renderAutoresearchHtml(await buildAutoresearchReportModel(dir));

      expect(html).toContain("<svg");
      expect(html).toContain('class="axis axis-y"');
      expect(html).toContain('class="axis axis-x"');
      expect(html).toContain('class="axis-tick axis-tick-x"');
      expect(html).toContain(">0</text>");
      expect(html).toContain(">1</text>");
      expect(html).toContain(">2</text>");
      expect(html).toContain(">3</text>");
      expect(html).toContain('class="axis-tick axis-tick-y"');
      expect(html).toContain(">80</text>");
      expect(html).toContain(">100</text>");
      expect(html).toContain(">130</text>");
      expect(html).toContain(".point-label{");
      // shortLabel strips the script tags from the hypothesis before HTML escaping,
      // so the chart label renders as plain "Inline alert(1)" text.
      expect(html).toContain("Inline alert(1)");
      expect(html).not.toContain("Inline script alert 1 /script");
      expect(html).toContain("data-tooltip");
      expect(html).toContain("20.0%");
      expect(html).toContain("#cache");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats floating-point metrics for display", async () => {
    const dir = await makeReportDir();
    try {
      await Bun.write(
        join(dir, "autoresearch.meta.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          baseline: {
            ts: "2026-04-27T00:00:00.000Z",
            metric: 0.30000000000000004,
            unit: "ms",
            direction: "minimize",
            command: "./autoresearch.sh",
            commit: "abc1234",
          },
        })}\n`,
      );
      await Bun.write(
        join(dir, "autoresearch.jsonl"),
        `${JSON.stringify({
          iter: 1,
          ts: "2026-04-27T00:01:00.000Z",
          provider: "claude",
          hypothesis: "Float display",
          metric: 0.30000000000000004,
          unit: "ms",
          verdict: "keep",
          commit: "def5678",
          asi: [],
          duration_ms: 1000,
        })}\n`,
      );

      const html = renderAutoresearchHtml(await buildAutoresearchReportModel(dir));

      expect(html).toContain("metric: 0.3");
      expect(html).toContain("<td>0.3</td>");
      expect(html).not.toContain("0.30000000000000004");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
