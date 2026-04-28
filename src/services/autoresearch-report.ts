import { join } from "node:path";
import {
  type AutoresearchMeta,
  type Direction,
  type LogEntry,
  parseAutoresearchSpec,
  readAutoresearchJsonlEntries,
  readAutoresearchMeta,
  summarizeHypothesis,
} from "./autoresearch";

type ReportVerdict = "baseline" | "keep" | "discard" | "incorrect";

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly verdict: ReportVerdict;
  readonly connected: boolean;
  readonly changeFromBaselinePct: number | null;
  readonly changeFromPreviousAcceptedPct: number | null;
  readonly hypothesis: string | null;
  readonly commit: string | null;
}

export interface ReportIteration {
  readonly iter: number;
  readonly verdict: LogEntry["verdict"];
  readonly metric: number | null;
  readonly improvementPct: number | null;
  readonly label: string;
  readonly hypothesis: string;
  readonly commit: string | null;
  readonly asi: readonly string[];
}

export interface ReportModel {
  readonly objective: string;
  readonly command: string;
  readonly unit: string;
  readonly direction: Direction;
  readonly baseline: AutoresearchMeta["baseline"];
  readonly bestMetric: number;
  readonly improvementPct: number | null;
  readonly acceptedSeries: readonly ChartPoint[];
  readonly rejectedPoints: readonly ChartPoint[];
  readonly iterations: readonly ReportIteration[];
  readonly failedIterations: readonly ReportIteration[];
  readonly generatedAt: string;
}

const TITLE_PATTERN = /^#\s+Autoresearch:\s*(.+?)\s*$/m;
const CHART_LABEL_CHARS = 28;
const POINT_RADIUS = 3;
const POINT_LABEL_OFFSET_X = 6;
const POINT_LABEL_OFFSET_Y = -6;
const POINT_LABEL_CHAR_WIDTH = 5;
const POINT_LABEL_HEIGHT = 11;
const Y_TICK_LABEL_MIN_GAP = 14;
const AXIS_TICK_LABEL_CHARS = 6;

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function pct(from: number, to: number): number | null {
  if (from === 0) return null;
  return ((to - from) / from) * 100;
}

function improvement(direction: Direction, baseline: number, best: number): number | null {
  if (baseline === 0) return null;
  return direction === "minimize"
    ? ((baseline - best) / baseline) * 100
    : ((best - baseline) / baseline) * 100;
}

function shortLabel(hypothesis: string, fallback: string): string {
  const plain = hypothesis
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_#{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return fallback;
  if (plain.length <= CHART_LABEL_CHARS) return plain;
  return `${plain.slice(0, CHART_LABEL_CHARS - 3).trimEnd()}...`;
}

function parseObjective(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Objective");
  if (start !== -1) {
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("## ")) break;
      body.push(line);
    }
    const section = body
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    if (section.length > 0) return section;
  }
  return md.match(TITLE_PATTERN)?.[1]?.trim() || "Autoresearch report";
}

function bestAccepted(
  entries: readonly LogEntry[],
  direction: Direction,
  baseline: number,
  expectedUnit: string,
): number {
  const kept = entries
    .filter(
      (entry) => entry.verdict === "keep" && entry.metric !== null && entry.unit === expectedUnit,
    )
    .map((entry) => entry.metric as number);
  if (kept.length === 0) return baseline;
  return direction === "minimize" ? Math.min(...kept) : Math.max(...kept);
}

function formatMetric(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

function formatAxisMetric(value: number): string {
  const full = formatMetric(value);
  if (full.length <= AXIS_TICK_LABEL_CHARS) return full;
  for (let significantDigits = 4; significantDigits >= 2; significantDigits -= 1) {
    const rounded = String(Number(value.toPrecision(significantDigits)));
    if (rounded.length <= AXIS_TICK_LABEL_CHARS) return rounded;
  }
  return value.toExponential(2);
}

export async function buildAutoresearchReportModel(cwd: string): Promise<ReportModel> {
  const specBody = await Bun.file(join(cwd, "autoresearch.md")).text();
  const spec = parseAutoresearchSpec(specBody);
  const meta = await readAutoresearchMeta(cwd);
  if (meta === null) {
    throw new Error("autoresearch.meta.json is required to generate an HTML report.");
  }
  if (meta.baseline.unit !== spec.unit) {
    throw new Error(
      `autoresearch.meta.json uses unit=${meta.baseline.unit} but autoresearch.md declares unit=${spec.unit}.`,
    );
  }
  if (meta.baseline.direction !== spec.direction) {
    throw new Error(
      `autoresearch.meta.json uses direction=${meta.baseline.direction} but autoresearch.md declares direction=${spec.direction}.`,
    );
  }

  const entries = await readAutoresearchJsonlEntries(cwd);
  const bestMetric = bestAccepted(entries, spec.direction, meta.baseline.metric, spec.unit);
  let previousAccepted = meta.baseline.metric;
  const acceptedSeries: ChartPoint[] = [
    {
      x: 0,
      y: meta.baseline.metric,
      label: "baseline",
      verdict: "baseline",
      connected: true,
      changeFromBaselinePct: null,
      changeFromPreviousAcceptedPct: null,
      hypothesis: null,
      commit: meta.baseline.commit,
    },
  ];
  const rejectedPoints: ChartPoint[] = [];
  const iterations: ReportIteration[] = [];
  const failedIterations: ReportIteration[] = [];

  for (const entry of entries) {
    const label = shortLabel(entry.hypothesis, `iter ${entry.iter}`);
    const row: ReportIteration = {
      iter: entry.iter,
      verdict: entry.verdict,
      metric: entry.metric,
      improvementPct:
        entry.metric === null
          ? null
          : improvement(spec.direction, meta.baseline.metric, entry.metric),
      label,
      hypothesis: entry.hypothesis,
      commit: entry.commit,
      asi: entry.asi,
    };
    if (entry.metric === null) {
      failedIterations.push(row);
      continue;
    }
    iterations.push(row);
    if (entry.verdict === "keep") {
      acceptedSeries.push({
        x: entry.iter,
        y: entry.metric,
        label,
        verdict: "keep",
        connected: true,
        changeFromBaselinePct: pct(meta.baseline.metric, entry.metric),
        changeFromPreviousAcceptedPct: pct(previousAccepted, entry.metric),
        hypothesis: entry.hypothesis,
        commit: entry.commit,
      });
      previousAccepted = entry.metric;
    } else if (entry.verdict === "discard" || entry.verdict === "incorrect") {
      rejectedPoints.push({
        x: entry.iter,
        y: entry.metric,
        label,
        verdict: entry.verdict,
        connected: false,
        changeFromBaselinePct: pct(meta.baseline.metric, entry.metric),
        changeFromPreviousAcceptedPct: null,
        hypothesis: entry.hypothesis,
        commit: entry.commit,
      });
    }
  }

  return {
    objective: parseObjective(specBody),
    command: spec.command,
    unit: spec.unit,
    direction: spec.direction,
    baseline: meta.baseline,
    bestMetric,
    improvementPct: improvement(spec.direction, meta.baseline.metric, bestMetric),
    acceptedSeries,
    rejectedPoints,
    iterations,
    failedIterations,
    generatedAt: new Date().toISOString(),
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function pointAttrs(point: ChartPoint): string {
  const tooltipLabel = point.hypothesis ?? point.label;
  const tooltip = [
    `iter: ${point.x}`,
    `verdict: ${point.verdict}`,
    `metric: ${formatMetric(point.y)}`,
    `vs baseline: ${fmt(point.changeFromBaselinePct)}`,
    `vs previous accepted: ${fmt(point.changeFromPreviousAcceptedPct)}`,
    `label: ${tooltipLabel}`,
    point.commit ? `commit: ${point.commit}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join("\n");
  return `data-tooltip="${escapeHtml(tooltip)}" tabindex="0"`;
}

function renderRows(rows: readonly ReportIteration[], filterable = false): string {
  return rows
    .map((row) => {
      const verdictAttr = filterable ? ` data-verdict="${escapeHtml(row.verdict)}"` : "";
      return `<tr${verdictAttr}><td>${row.iter}</td><td>${escapeHtml(row.verdict)}</td><td>${
        row.metric === null ? "n/a" : formatMetric(row.metric)
      }</td><td>${fmt(row.improvementPct)}</td><td>${escapeHtml(row.label)}</td><td>${escapeHtml(
        row.hypothesis,
      )}</td><td>${escapeHtml(row.commit ?? "")}</td><td>${escapeHtml(row.asi.join(" "))}</td></tr>`;
    })
    .join("");
}

function isSeparated(position: number, occupied: readonly number[], minGap: number): boolean {
  return occupied.every((previous) => Math.abs(previous - position) >= minGap);
}

function visibleYTickValues(
  values: readonly number[],
  y: (value: number) => number,
  priorityValues: readonly number[] = [],
): readonly number[] {
  const occupied: number[] = [];
  const visible: number[] = [];
  const seen = new Set<number>();
  const ordered = [...priorityValues, ...values].filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  for (const value of ordered) {
    const tickY = y(value);
    if (!isSeparated(tickY, occupied, Y_TICK_LABEL_MIN_GAP)) continue;
    occupied.push(tickY);
    visible.push(value);
  }
  return visible.sort((a, b) => a - b);
}

function pointKey(point: ChartPoint): string {
  return `${point.verdict}:${point.x}:${point.y}:${point.label}`;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function pointLabelRect(
  point: ChartPoint,
  x: (value: number) => number,
  y: (value: number) => number,
): Rect {
  const labelX = x(point.x) + POINT_LABEL_OFFSET_X;
  const labelY = y(point.y) + POINT_LABEL_OFFSET_Y;
  return {
    left: labelX,
    right: labelX + point.label.length * POINT_LABEL_CHAR_WIDTH,
    top: labelY - POINT_LABEL_HEIGHT,
    bottom: labelY + 2,
  };
}

function visiblePointLabelKeys(
  points: readonly ChartPoint[],
  x: (value: number) => number,
  y: (value: number) => number,
): ReadonlySet<string> {
  const occupied: Rect[] = [];
  const visible = new Set<string>();
  for (const point of points) {
    const rect = pointLabelRect(point, x, y);
    if (occupied.some((previous) => overlaps(rect, previous))) continue;
    occupied.push(rect);
    visible.add(pointKey(point));
  }
  return visible;
}

export function renderAutoresearchHtml(model: ReportModel): string {
  const points = [...model.acceptedSeries, ...model.rejectedPoints];
  const allIterations = [...model.iterations, ...model.failedIterations];
  const yValues = points.map((point) => point.y);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const maxX = Math.max(
    ...allIterations.map((row) => row.iter),
    ...points.map((point) => point.x),
    1,
  );
  const ySpan = maxY === minY ? 1 : maxY - minY;
  const plotLeft = 50;
  const plotRight = 550;
  const plotTop = 40;
  const plotBottom = 260;
  const tickSize = 6;
  const x = (value: number): number => plotLeft + (value / maxX) * (plotRight - plotLeft);
  const y = (value: number): number =>
    plotBottom - ((value - minY) / ySpan) * (plotBottom - plotTop);
  const acceptedPath = model.acceptedSeries
    .map(
      (point, idx) => `${idx === 0 ? "M" : "L"} ${x(point.x).toFixed(1)} ${y(point.y).toFixed(1)}`,
    )
    .join(" ");
  const xTicks = Array.from({ length: maxX + 1 }, (_, idx) => idx)
    .map((iter) => {
      const tickX = x(iter).toFixed(1);
      return `<line class="axis-tick axis-tick-x" x1="${tickX}" y1="${plotBottom}" x2="${tickX}" y2="${
        plotBottom + tickSize
      }"></line><text class="axis-tick-label axis-tick-label-x" x="${tickX}" y="${
        plotBottom + 20
      }" text-anchor="middle">${iter}</text>`;
    })
    .join("");
  const yTickValues = visibleYTickValues(
    [...new Set(points.map((point) => point.y))].sort((a, b) => a - b),
    y,
    [model.baseline.metric],
  );
  const yTicks = yTickValues
    .map((value) => {
      const tickY = y(value).toFixed(1);
      return `<line class="axis-tick axis-tick-y" x1="${plotLeft - tickSize}" y1="${tickY}" x2="${plotLeft}" y2="${tickY}"></line><text class="axis-tick-label axis-tick-label-y" x="${
        plotLeft - tickSize - 4
      }" y="${tickY}" text-anchor="end" dominant-baseline="middle">${formatAxisMetric(
        value,
      )}</text>`;
    })
    .join("");
  const visibleLabels = visiblePointLabelKeys(points, x, y);
  const renderPoint = (point: ChartPoint): string => {
    const pointClass = point.verdict === "baseline" ? "keep" : point.verdict;
    const cx = x(point.x).toFixed(1);
    const cy = y(point.y).toFixed(1);
    const label = visibleLabels.has(pointKey(point))
      ? `<text class="point-label" x="${(x(point.x) + POINT_LABEL_OFFSET_X).toFixed(1)}" y="${(
          y(point.y) + POINT_LABEL_OFFSET_Y
        ).toFixed(1)}">${escapeHtml(point.label)}</text>`
      : "";
    return `<circle class="${pointClass}" cx="${cx}" cy="${cy}" r="${POINT_RADIUS}" ${pointAttrs(
      point,
    )}></circle>${label}`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(model.objective)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:32px;color:#17202a;background:#f8fafc}
main{max-width:1100px;margin:0 auto}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.card{background:white;border:1px solid #d8dee9;border-radius:8px;padding:12px}
svg{width:100%;height:auto;background:white;border:1px solid #d8dee9;border-radius:8px}
.axis{stroke:#94a3b8;stroke-width:1.5}
.axis-tick{stroke:#94a3b8;stroke-width:1.5}
.axis-tick-label{fill:#475569;font-size:10px}
.point-label{fill:#475569;font-size:9px}
.keep{fill:#166534}.discard,.incorrect{fill:#b91c1c}.trend{fill:none;stroke:#166534;stroke-width:1}
table{width:100%;border-collapse:collapse;background:white;margin-top:20px}td,th{border:1px solid #d8dee9;padding:8px;text-align:left;vertical-align:top}
.table-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:24px}.table-heading h2{margin:0}.table-tools{display:flex;justify-content:flex-end}.table-tools label{font-size:14px;color:#334155}.table-tools select{margin-left:8px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;background:white}
#tooltip{position:fixed;display:none;white-space:pre-line;background:#111827;color:white;padding:8px;border-radius:6px;font-size:12px;pointer-events:none}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(model.objective)}</h1>
<p>Generated ${escapeHtml(model.generatedAt)}. Command: <code>${escapeHtml(model.command)}</code></p>
<section class="summary">
<div class="card">Baseline<br><strong>${formatMetric(model.baseline.metric)} ${escapeHtml(model.unit)}</strong></div>
<div class="card">Best accepted<br><strong>${formatMetric(model.bestMetric)} ${escapeHtml(model.unit)}</strong></div>
<div class="card">Improvement<br><strong>${fmt(model.improvementPct)}</strong></div>
<div class="card">Kept<br><strong>${model.acceptedSeries.length - 1}</strong></div>
<div class="card">Rejected<br><strong>${model.rejectedPoints.length}</strong></div>
</section>
<svg viewBox="0 0 620 320" role="img" aria-label="Autoresearch metric chart">
<line class="axis axis-y" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}"></line>
<line class="axis axis-x" x1="${plotLeft}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}"></line>
${xTicks}
${yTicks}
<text x="${plotLeft}" y="24">${escapeHtml(model.unit)}</text>
<text x="${plotRight - 10}" y="300">iteration</text>
<path class="trend" d="${acceptedPath}"></path>
${points.map(renderPoint).join("")}
</svg>
<div class="table-heading"><h2>Iterations</h2><div class="table-tools"><label for="verdict-filter">Verdict <select id="verdict-filter"><option value="all">all</option><option value="keep">keep</option><option value="discard">discard</option><option value="incorrect">incorrect</option><option value="crash">crash</option><option value="timeout">timeout</option></select></label></div></div>
<table><thead><tr><th>iter</th><th>verdict</th><th>metric</th><th>vs baseline</th><th>label</th><th>hypothesis</th><th>commit</th><th>ASI</th></tr></thead><tbody id="iterations-table-body">${renderRows(
    model.iterations,
    true,
  )}</tbody></table>
<h2>Failed iterations</h2>
<table><thead><tr><th>iter</th><th>verdict</th><th>metric</th><th>vs baseline</th><th>label</th><th>hypothesis</th><th>commit</th><th>ASI</th></tr></thead><tbody>${renderRows(
    model.failedIterations,
  )}</tbody></table>
</main>
<div id="tooltip"></div>
<script>
const tooltip=document.getElementById("tooltip");
const verdictFilter=document.getElementById("verdict-filter");
const applyVerdictFilter=()=>{const verdict=verdictFilter.value;for(const row of document.querySelectorAll("#iterations-table-body tr[data-verdict]")){row.hidden=verdict!=="all"&&row.dataset.verdict!==verdict;}};
verdictFilter.addEventListener("change",applyVerdictFilter);
for(const point of document.querySelectorAll("[data-tooltip]")){
  const show=(event)=>{tooltip.textContent=point.dataset.tooltip;tooltip.style.display="block";tooltip.style.left=(event.clientX+12)+"px";tooltip.style.top=(event.clientY+12)+"px";};
  point.addEventListener("mousemove",show);
  point.addEventListener("focus",(event)=>show(event));
  point.addEventListener("mouseleave",()=>tooltip.style.display="none");
  point.addEventListener("blur",()=>tooltip.style.display="none");
}
</script>
</body>
</html>`;
}
