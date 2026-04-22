/**
 * Autoresearch runner — hypothesize → benchmark → keep/discard loop.
 *
 * Drives iterations against a user-authored benchmark, letting an agent
 * propose changes and keeping only the ones that improve the metric.
 * See docs/architecture-decisions.md for why this is a command, not a
 * workflow.
 */

import { appendFile, chmod, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  type AgentExecutionOptions,
  type AgentExecutionResult,
  runAgentStep,
} from "../domain/agent-execution";
import type { WidgetState } from "./autoresearch-widget";
import {
  addWorktree,
  commitAll,
  commitAllExcept,
  isCleanExcept,
  listDirtyPaths,
  listWorktrees,
  revertWorkingTree,
} from "./git";
import type { DetectedProviders, ProviderName } from "./provider-detection";

export type { WidgetState } from "./autoresearch-widget";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Verdict = "keep" | "discard" | "incorrect" | "crash" | "timeout";

export type Direction = "minimize" | "maximize";

export interface Measurement {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

export interface BenchResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Null iff parse failed or the script exited non-zero. */
  readonly measurement: Measurement | null;
}

export interface LogEntry {
  readonly iter: number;
  readonly ts: string;
  readonly provider: ProviderName | null;
  readonly hypothesis: string;
  readonly metric: number | null;
  readonly verdict: Verdict;
  readonly commit: string | null;
  /** Diagnostic for a failed keep commit, e.g. pre-commit hook rejection. */
  readonly commitError?: string;
  readonly asi: readonly string[];
  readonly duration_ms: number;
}

export interface LoopState {
  readonly iter: number;
  readonly kept: number;
  readonly discarded: number;
  /** Consecutive non-keep iterations since the last keep (or since start). */
  readonly consecutiveDiscards: number;
  readonly baseline: number;
  readonly best: number;
  readonly lastMetric: number | null;
}

export interface RunLoopConfig {
  readonly cwd: string;
  readonly providers: DetectedProviders;
  readonly stopWhen?: (state: LoopState) => boolean;
  readonly signal?: AbortSignal;
  /**
   * Content of the Autoresearch skill (SKILL.md body) to prepend to the agent
   * prompt each iteration. Command layer resolves this from disk; tests inject
   * a fixed string. Empty string is valid — the runner still functions, just
   * without the protocol guidance.
   */
  readonly skillContent?: string;
}

export interface RunLoopDeps {
  readonly agent?: (
    opts: AgentExecutionOptions,
    detected: DetectedProviders,
  ) => Promise<AgentExecutionResult>;
  readonly benchmark?: (cwd: string) => Promise<BenchResult>;
  readonly checks?: (cwd: string) => Promise<{ readonly exitCode: number }>;
  readonly appendLog?: (cwd: string, entry: LogEntry) => Promise<void>;
  readonly now?: () => Date;
  /** Observer called once per completed iteration with a widget-friendly snapshot. */
  readonly onTick?: (state: WidgetState) => void;
}

export interface VerdictInput {
  readonly metric: number | null;
  readonly benchmarkExitCode: number;
  readonly beatsBest: boolean;
  readonly correctnessOk: boolean;
  readonly commitSucceeded: boolean;
  readonly agentTimedOut: boolean;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Decide the verdict for an iteration. Ordering is deliberate: a timed-out
 * agent dominates all downstream signals, a crashed benchmark dominates
 * correctness checks, and a failed commit hook downgrades what would have
 * been `keep` to `incorrect`.
 */
export function classifyVerdict(input: VerdictInput): Verdict {
  if (input.agentTimedOut) return "timeout";
  if (input.benchmarkExitCode !== 0 || input.metric === null) return "crash";
  if (!input.correctnessOk) return "incorrect";
  if (!input.beatsBest) return "discard";
  if (!input.commitSucceeded) return "incorrect";
  return "keep";
}

/** True iff `metric` improves on `best` in the configured direction. Ties don't improve. */
export function improvesBest(metric: number, best: number, direction: Direction): boolean {
  return direction === "minimize" ? metric < best : metric > best;
}

/** Anchored per line (multiline) — substrings inside other output don't match. */
const METRIC_PATTERN = /^METRIC name=(\S+) value=(\S+) unit=(\S+)\s*$/gm;

/**
 * Extract the final `METRIC name=<n> value=<v> unit=<u>` measurement from
 * benchmark stdout. Last match wins — benchmarks may emit debug lines before
 * the canonical result. Returns null when no line matches or the value is
 * non-finite (NaN / ±Infinity / non-numeric text).
 */
export function parseMetricLine(stdout: string): Measurement | null {
  let lastMatch: RegExpExecArray | null = null;
  METRIC_PATTERN.lastIndex = 0;
  for (
    let match = METRIC_PATTERN.exec(stdout);
    match !== null;
    match = METRIC_PATTERN.exec(stdout)
  ) {
    lastMatch = match;
  }

  if (!lastMatch) return null;

  const [, name, rawValue, unit] = lastMatch;
  if (name === undefined || rawValue === undefined || unit === undefined) return null;

  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;

  return { name, value, unit };
}

const DIRECTION_PATTERN = /^\s*-\s*direction:\s*(minimize|maximize)\s*$/m;

/** Parse the minimum fields the runner needs out of `autoresearch.md`. */
export function parseSpec(md: string): { readonly direction: Direction } {
  const match = md.match(DIRECTION_PATTERN);
  if (!match) {
    throw new Error(
      "autoresearch.md is missing a '- direction: minimize|maximize' line in ## Metric.",
    );
  }
  return { direction: match[1] as Direction };
}

const HYPOTHESIS_PATTERN = /^HYPOTHESIS:\s*(.+?)\s*$/m;
const HYPOTHESIS_SUMMARY_CHARS = 200;

/** Pull the one-line hypothesis the agent is asked to emit; empty string if missing. */
export function extractHypothesis(stdout: string): string {
  return stdout.match(HYPOTHESIS_PATTERN)?.[1] ?? "";
}

/** Bound hypotheses for prompts, commit subjects, and terminal display without changing jsonl history. */
export function summarizeHypothesis(hypothesis: string): string {
  if (hypothesis.length <= HYPOTHESIS_SUMMARY_CHARS) return hypothesis;
  return `${hypothesis.slice(0, HYPOTHESIS_SUMMARY_CHARS - 3)}...`;
}

const ASI_PATTERN = /^ASI:\s*(.+?)\s*$/m;

/**
 * Parse the optional `ASI: <tags>` line the agent emits for free-form
 * annotation. Tags are whitespace-separated and preserved verbatim — the
 * convention recommends `#tag`, but the parser doesn't enforce it so agents
 * that forget aren't silently ignored.
 */
export function extractAsi(stdout: string): readonly string[] {
  const match = stdout.match(ASI_PATTERN);
  if (!match?.[1]) return [];
  return match[1].split(/\s+/).filter((t) => t.length > 0);
}

function renderRecentEntry(e: LogEntry): string {
  const metricPart = e.metric === null ? "" : ` ${e.metric.toFixed(2)}`;
  const asiPart = e.asi.length > 0 ? `  [asi: ${e.asi.join(" ")}]` : "";
  return `- iter ${e.iter} [${e.verdict}]${metricPart} — ${summarizeHypothesis(e.hypothesis)}${asiPart}`;
}

export interface BuildPromptInput {
  readonly skill: string;
  readonly spec: string;
  readonly recent: readonly LogEntry[];
  readonly iter: number;
}

/**
 * Compose the iteration prompt the runner sends to the agent.
 *
 * Structure is intentionally plain Markdown so any provider CLI can render
 * it sensibly: skill first (the "how to think"), spec next (the "what to
 * optimize"), then a short history of recent iterations, then the task.
 */
export function buildPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  if (input.skill.trim().length > 0) sections.push(input.skill.trim());
  if (input.spec.trim().length > 0) sections.push(input.spec.trim());

  const recent =
    input.recent.length > 0
      ? input.recent.map(renderRecentEntry).join("\n")
      : "(no prior iterations)";
  sections.push(`## Recent iterations\n\n${recent}`);

  sections.push(
    `## Your task

This is iteration ${input.iter} of the autoresearch loop. Propose ONE targeted change. Do not re-propose any hypothesis that already appears as a 'discard' above. Apply the change by editing files directly. Do NOT run the benchmark — the runner will measure.

Respond in exactly this format:

HYPOTHESIS: <one-line description of the change>
ASI: <optional space-separated #tags for future-you>`,
  );

  return sections.join("\n\n");
}

// ─── Loop ──────────────────────────────────────────────────────────────────

const JSONL_FILE = "autoresearch.jsonl";
const JSONL_EXCLUDES = [JSONL_FILE] as const;

/**
 * Setup files the runner owns — the agent must never modify them, and callers
 * that commit worktree state must partition dirty paths against this set.
 */
export const SETUP_ARTIFACTS = [
  "autoresearch.md",
  "autoresearch.sh",
  "autoresearch.checks.sh",
] as const;

/**
 * Ensure the only dirty paths in `worktreePath` are setup artifacts
 * (`autoresearch.md` / `.sh` / `.checks.sh`). Throws an Error naming every
 * unrelated path when any other file is dirty; resolves silently when the
 * worktree is clean or only setup artifacts have changed.
 *
 * Delegates porcelain parsing to `listDirtyPaths` so the command and service
 * layers share one source of truth for dirty-path partitioning.
 */
export async function assertOnlySetupDirty(worktreePath: string): Promise<void> {
  const dirty = await listDirtyPaths(worktreePath);
  if (dirty.length === 0) return;

  const setupSet = new Set<string>(SETUP_ARTIFACTS);
  const unrelated = dirty.filter((path) => !setupSet.has(path));
  if (unrelated.length > 0) {
    throw new Error(
      `Unrelated changes in worktree after editor session: ${unrelated.join(", ")}. Commit or stash them before continuing, then run \`shaka autoresearch resume\`.`,
    );
  }
}

/**
 * Return true iff the agent touched any setup artifact this iteration — whether
 * by modifying a tracked file, deleting one, or creating a brand-new untracked
 * one (e.g. adding an `autoresearch.checks.sh` that didn't exist at setup). We
 * use `git status --porcelain` rather than `git diff HEAD` because the latter
 * only sees tracked changes and silently misses new untracked files.
 */
async function setupArtifactsDirty(cwd: string): Promise<boolean> {
  // `--ignored=matching` so a setup artifact matching a .gitignore pattern
  // (e.g. the user's repo ignores `*.sh`) is still reported as dirty —
  // otherwise defaultChecks would keep running autoresearch.checks.sh while
  // tamper detection silently missed edits to it.
  const proc = Bun.spawn(
    ["git", "status", "--porcelain", "--ignored=matching", "--", ...SETUP_ARTIFACTS],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git status failed in ${cwd} while checking setup artifacts`);
  return out.trim().length > 0;
}

async function defaultAppendLog(cwd: string, entry: LogEntry): Promise<void> {
  // Append via POSIX O_APPEND (atomic up to PIPE_BUF for a single line) so
  // a mid-write crash can't truncate the existing log. The prior read-
  // modify-write via Bun.write truncated the file on open, which meant an
  // interrupted write lost all history, not just the in-flight line.
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(join(cwd, JSONL_FILE), line, "utf8");
}

/** Run the benchmark script at `<cwd>/autoresearch.sh` and parse its METRIC output. */
export async function runBenchmark(cwd: string): Promise<BenchResult> {
  const proc = Bun.spawn(["./autoresearch.sh"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    measurement: exitCode === 0 ? parseMetricLine(stdout) : null,
  };
}

/**
 * Run `<cwd>/autoresearch.checks.sh` if it exists. Absent script = always pass
 * (correctness gate is opt-in per the state format spec).
 */
async function defaultChecks(cwd: string): Promise<{ readonly exitCode: number }> {
  const path = join(cwd, "autoresearch.checks.sh");
  if (!(await Bun.file(path).exists())) return { exitCode: 0 };
  const proc = Bun.spawn(["./autoresearch.checks.sh"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode };
}

// ─── Setup validation ──────────────────────────────────────────────────────

export type SetupValidationResult =
  | { readonly ok: true; readonly measurement: Measurement; readonly checksExitCode?: number }
  | {
      readonly ok: false;
      readonly phase: "spec" | "benchmark" | "checks" | "dirty";
      readonly message: string;
      readonly stdout?: string;
      readonly stderr?: string;
    };

export interface ValidateSetupDeps {
  readonly runBenchmark?: (cwd: string) => Promise<BenchResult>;
  readonly parseSpec?: (md: string) => unknown;
  readonly assertOnlySetupDirty?: (cwd: string) => Promise<void>;
}

async function validateSpec(
  worktreePath: string,
  spec: (md: string) => unknown,
): Promise<SetupValidationResult | null> {
  try {
    const specBody = await Bun.file(join(worktreePath, "autoresearch.md")).text();
    spec(specBody);
    return null;
  } catch (err) {
    return {
      ok: false,
      phase: "spec",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function benchmarkFailure(benchResult: BenchResult): SetupValidationResult {
  return {
    ok: false,
    phase: "benchmark",
    message:
      benchResult.exitCode !== 0
        ? `autoresearch.sh exited ${benchResult.exitCode}`
        : "autoresearch.sh did not emit a parseable METRIC line",
    stdout: benchResult.stdout,
    stderr: benchResult.stderr,
  };
}

/**
 * Run `autoresearch.checks.sh` and capture stdout/stderr for failure diagnostics.
 * Inlined (not delegated to `defaultChecks`) because the validation path needs
 * the streams; widening `defaultChecks` for one caller costs more surface than
 * duplicating this short spawn.
 */
async function runChecksCapturing(cwd: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(["./autoresearch.checks.sh"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Validate the setup artifacts in `worktreePath` after the interactive setup
 * session exits. Composition order: spec parse → defensive `+x` on bench +
 * checks scripts → benchmark run → optional checks → dirty gate. Returns a
 * discriminated union so callers can narrow on `result.ok` for diagnostics
 * without null-branching.
 *
 * The defensive chmod covers setup agents that produce `autoresearch.sh`
 * without the bit set. It's idempotent; scripts that already have the bit
 * keep it unchanged.
 */
export async function validateSetup(
  worktreePath: string,
  deps: ValidateSetupDeps = {},
): Promise<SetupValidationResult> {
  const bench = deps.runBenchmark ?? runBenchmark;
  const spec = deps.parseSpec ?? parseSpec;
  const dirtyGate = deps.assertOnlySetupDirty ?? assertOnlySetupDirty;

  // 1. Spec parse.
  const specFailure = await validateSpec(worktreePath, spec);
  if (specFailure !== null) return specFailure;

  // 2. Defensive chmod +x on bench + checks scripts when present.
  const benchPath = join(worktreePath, "autoresearch.sh");
  const checksPath = join(worktreePath, "autoresearch.checks.sh");
  if (!(await Bun.file(benchPath).exists())) {
    return { ok: false, phase: "benchmark", message: "autoresearch.sh missing" };
  }
  await chmod(benchPath, 0o755);
  const checksExists = await Bun.file(checksPath).exists();
  if (checksExists) await chmod(checksPath, 0o755);

  // 3. Benchmark run.
  const benchResult = await bench(worktreePath);
  if (benchResult.exitCode !== 0 || benchResult.measurement === null) {
    return benchmarkFailure(benchResult);
  }
  const measurement = benchResult.measurement;

  // 4. Optional checks.
  let checksExitCode: number | undefined;
  if (checksExists) {
    const { exitCode, stdout, stderr } = await runChecksCapturing(worktreePath);
    if (exitCode !== 0) {
      return {
        ok: false,
        phase: "checks",
        message: `autoresearch.checks.sh exited ${exitCode}`,
        stdout,
        stderr,
      };
    }
    checksExitCode = 0;
  }

  // 5. Dirty gate.
  try {
    await dirtyGate(worktreePath);
  } catch (err) {
    return {
      ok: false,
      phase: "dirty",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return checksExitCode === undefined
    ? { ok: true, measurement }
    : { ok: true, measurement, checksExitCode };
}

interface ResolvedDeps {
  readonly agent: NonNullable<RunLoopDeps["agent"]>;
  readonly benchmark: NonNullable<RunLoopDeps["benchmark"]>;
  readonly checks: NonNullable<RunLoopDeps["checks"]>;
  readonly appendLog: NonNullable<RunLoopDeps["appendLog"]>;
  readonly now: NonNullable<RunLoopDeps["now"]>;
  readonly onTick: NonNullable<RunLoopDeps["onTick"]>;
}

function resolveDeps(deps: RunLoopDeps): ResolvedDeps {
  return {
    agent: deps.agent ?? runAgentStep,
    benchmark: deps.benchmark ?? runBenchmark,
    checks: deps.checks ?? defaultChecks,
    appendLog: deps.appendLog ?? defaultAppendLog,
    now: deps.now ?? (() => new Date()),
    onTick: deps.onTick ?? ((): void => undefined),
  };
}

async function measureBaseline(cwd: string, benchmark: ResolvedDeps["benchmark"]): Promise<number> {
  const r = await benchmark(cwd);
  if (r.exitCode !== 0 || r.measurement === null) {
    const diag = (r.stderr || r.stdout).trim();
    throw new Error(`Baseline benchmark failed (exit ${r.exitCode}).${diag ? ` ${diag}` : ""}`);
  }
  return r.measurement.value;
}

/** State reconstructed from a prior run's jsonl, used when resuming. */
interface PriorRunState {
  readonly iter: number;
  readonly kept: number;
  readonly discarded: number;
  readonly consecutiveDiscards: number;
  /**
   * Best metric represented by `HEAD`. Null iff no `keep` entries exist yet —
   * in that case the caller re-measures baseline at HEAD (the reverted
   * candidates from prior iterations aren't represented anywhere in the tree).
   */
  readonly best: number | null;
  readonly lastMetric: number | null;
}

/**
 * Parse jsonl content into entries. Drops a single truncated trailing line
 * (likely a SIGKILL mid-write) with a warning; throws on any earlier parse
 * failure, since that signals real corruption.
 */
function parseJsonlEntries(raw: string): {
  readonly entries: LogEntry[];
  readonly droppedTail: boolean;
} {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries: LogEntry[] = [];
  let droppedTail = false;
  for (const [idx, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      if (idx === lines.length - 1) {
        console.warn(
          `autoresearch: dropping truncated last line of ${JSONL_FILE} (likely killed mid-write)`,
        );
        droppedTail = true;
        continue;
      }
      throw new Error(`${JSONL_FILE} line ${idx + 1} is not valid JSON: ${line.slice(0, 80)}`);
    }
  }
  return { entries, droppedTail };
}

function renderJsonlEntries(entries: readonly LogEntry[]): string {
  return entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/**
 * Pick the best metric represented by `HEAD` — i.e. the min/max across `keep`
 * entries only. Returns null when there are no keeps; the caller then
 * re-measures the baseline by running the benchmark at HEAD, which is the
 * honest truth (reverted candidates aren't represented anywhere in the tree).
 */
function deriveBestMetric(entries: readonly LogEntry[], direction: Direction): number | null {
  const keptMetrics = entries
    .filter((e) => e.verdict === "keep")
    .map((e) => e.metric)
    .filter((m): m is number => m !== null);
  if (keptMetrics.length === 0) return null;
  return direction === "minimize" ? Math.min(...keptMetrics) : Math.max(...keptMetrics);
}

function countConsecutiveDiscards(entries: readonly LogEntry[]): number {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.verdict === "keep") break;
    n++;
  }
  return n;
}

/**
 * Read an existing jsonl and reconstruct loop state. Returns null for an empty
 * or missing file. Truncated trailing lines are dropped with a warning and the
 * file is rewritten cleanly so future appends don't concatenate to the bad tail.
 */
async function loadPriorState(cwd: string, direction: Direction): Promise<PriorRunState | null> {
  const path = join(cwd, JSONL_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const raw = await file.text();
  if (raw.trim() === "") return null;

  const { entries, droppedTail } = parseJsonlEntries(raw);
  if (droppedTail) {
    await Bun.write(path, renderJsonlEntries(entries));
  }
  if (entries.length === 0) return null;

  const iter = Math.max(...entries.map((e) => e.iter));
  const kept = entries.filter((e) => e.verdict === "keep").length;
  return {
    iter,
    kept,
    discarded: entries.length - kept,
    consecutiveDiscards: countConsecutiveDiscards(entries),
    best: deriveBestMetric(entries, direction),
    lastMetric: entries[entries.length - 1]?.metric ?? null,
  };
}

/** Outcome of one iteration — what the loop bookkeeping needs to advance. */
interface IterationOutcome {
  readonly verdict: Verdict;
  readonly metric: number | null;
  readonly commit: string | null;
  readonly entry: LogEntry;
}

interface JsonlSnapshot {
  readonly path: string;
  readonly content: string | null;
}

async function snapshotJsonl(cwd: string): Promise<JsonlSnapshot> {
  const path = join(cwd, JSONL_FILE);
  const file = Bun.file(path);
  return { path, content: (await file.exists()) ? await file.text() : null };
}

async function restoreJsonlIfChanged(snapshot: JsonlSnapshot): Promise<boolean> {
  const file = Bun.file(snapshot.path);
  const current = (await file.exists()) ? await file.text() : null;
  if (current === snapshot.content) return false;
  if (snapshot.content === null) {
    await rm(snapshot.path, { force: true });
  } else {
    await Bun.write(snapshot.path, snapshot.content);
  }
  return true;
}

function incorrectOutcome(args: {
  readonly iter: number;
  readonly deps: ResolvedDeps;
  readonly agentResult: AgentExecutionResult;
  readonly hypothesis: string;
  readonly asi: readonly string[];
  readonly iterStart: number;
}): IterationOutcome {
  return {
    verdict: "incorrect",
    metric: null,
    commit: null,
    entry: {
      iter: args.iter,
      ts: args.deps.now().toISOString(),
      provider: args.agentResult.provider,
      hypothesis: args.hypothesis,
      metric: null,
      verdict: "incorrect",
      commit: null,
      asi: args.asi,
      duration_ms: Date.now() - args.iterStart,
    },
  };
}

async function tryCommitKeep(
  iter: number,
  hypothesis: string,
  cwd: string,
): Promise<{
  readonly commit: string | null;
  readonly commitError?: string;
}> {
  try {
    return {
      commit: await commitAllExcept(JSONL_EXCLUDES, commitMessage(iter, hypothesis), cwd),
    };
  } catch (err) {
    const commitError = err instanceof Error ? err.message : String(err);
    console.warn(
      `autoresearch iter ${iter}: commit failed (${commitError}); classifying as incorrect`,
    );
    return { commit: null, commitError };
  }
}

/** Decide verdict + side-effect (commit or revert) for one iteration. */
async function runIteration(args: {
  readonly cwd: string;
  readonly iter: number;
  readonly direction: Direction;
  readonly best: number;
  readonly providers: DetectedProviders;
  readonly deps: ResolvedDeps;
  readonly prompt: string;
}): Promise<IterationOutcome> {
  const { cwd, iter, direction, best, providers, deps, prompt } = args;
  const iterStart = Date.now();

  const jsonlSnapshot = await snapshotJsonl(cwd);
  const agentResult = await deps.agent({ prompt, cwd }, providers);

  // Infrastructure failures (no provider, spawn error, CLI crash) are not
  // iteration outcomes — they indicate the user's environment is broken.
  // Surface the real cause instead of coercing to discard/incorrect.
  //
  // Restore the JSONL snapshot before throwing so a misbehaving provider that
  // wrote to autoresearch.jsonl and then exited non-zero can't poison the
  // next resume (prompt context + prior-state reconstruction both read jsonl).
  if (agentResult.exitCode !== 0 && !agentResult.timedOut) {
    const diag = agentResult.stderr.trim() || agentResult.stdout.trim() || "(no output)";
    await restoreJsonlIfChanged(jsonlSnapshot);
    throw new Error(`Agent failed on iter ${iter}: ${diag}`);
  }

  const hypothesis = extractHypothesis(agentResult.stdout);
  const asi = extractAsi(agentResult.stdout);

  if (await restoreJsonlIfChanged(jsonlSnapshot)) {
    await revertWorkingTree(JSONL_EXCLUDES, cwd);
    return incorrectOutcome({ iter, deps, agentResult, hypothesis, asi, iterStart });
  }

  // Skipping benchmark on tampered iterations: (a) the spec/bench may no
  // longer measure what we claim, and (b) we don't want to commit the agent's
  // edits to setup files as part of a legitimate keep. Tamper wins over
  // timeout because an illegitimate iteration is a stronger failure mode
  // than simply running out of time.
  if (await setupArtifactsDirty(cwd)) {
    await revertWorkingTree(JSONL_EXCLUDES, cwd);
    return incorrectOutcome({ iter, deps, agentResult, hypothesis, asi, iterStart });
  }

  // Skipping benchmark on timed-out iterations: the agent's edits are, by
  // definition, mid-stream. Benchmarking half-finished state wastes compute
  // and risks side effects (crashes, corrupted shared state, compounding
  // timeouts). classifyVerdict already treats agentTimedOut as terminal,
  // so running benchmark/checks on this tree cannot produce a keep — it
  // only produces wasted work and noisy signals.
  if (agentResult.timedOut) {
    await revertWorkingTree(JSONL_EXCLUDES, cwd);
    return {
      verdict: "timeout",
      metric: null,
      commit: null,
      entry: {
        iter,
        ts: deps.now().toISOString(),
        provider: agentResult.provider,
        hypothesis,
        metric: null,
        verdict: "timeout",
        commit: null,
        asi,
        duration_ms: Date.now() - iterStart,
      },
    };
  }

  const benchResult = await deps.benchmark(cwd);
  const metric = benchResult.measurement?.value ?? null;
  const beatsBest = metric !== null && improvesBest(metric, best, direction);

  // Only run correctness checks when the benchmark actually produced a number —
  // otherwise we waste work on a run that'll be `crash` regardless.
  const correctnessOk =
    benchResult.exitCode === 0 && metric !== null ? (await deps.checks(cwd)).exitCode === 0 : true;

  const baseInput = {
    metric,
    benchmarkExitCode: benchResult.exitCode,
    beatsBest,
    correctnessOk,
    agentTimedOut: agentResult.timedOut,
  };

  let verdict = classifyVerdict({ ...baseInput, commitSucceeded: true });
  let commit: string | null = null;
  let commitError: string | undefined;

  if (verdict === "keep") {
    const result = await tryCommitKeep(iter, hypothesis, cwd);
    commit = result.commit;
    commitError = result.commitError;
    if (commitError !== undefined) {
      // Hook failure or similar — classifier downgrades keep → incorrect.
      verdict = classifyVerdict({ ...baseInput, commitSucceeded: false });
    }
  }

  if (verdict !== "keep") {
    await revertWorkingTree(JSONL_EXCLUDES, cwd);
  }

  const entry: LogEntry = {
    iter,
    ts: deps.now().toISOString(),
    provider: agentResult.provider,
    hypothesis,
    metric,
    verdict,
    commit,
    commitError,
    asi,
    duration_ms: Date.now() - iterStart,
  };

  return { verdict, metric, commit, entry };
}

/** Mutable bookkeeping for an in-progress loop — kept isolated so runLoop stays flat. */
interface LoopBookkeeping {
  iter: number;
  kept: number;
  discarded: number;
  consecutiveDiscards: number;
  best: number;
  lastMetric: number | null;
}

function applyOutcome(book: LoopBookkeeping, outcome: IterationOutcome): void {
  if (outcome.verdict === "keep") {
    if (outcome.metric !== null) book.best = outcome.metric;
    book.kept++;
    book.consecutiveDiscards = 0;
  } else {
    book.discarded++;
    book.consecutiveDiscards++;
  }
  book.lastMetric = outcome.metric;
}

const RECENT_ENTRY_WINDOW = 5;

async function loadRecentEntries(cwd: string): Promise<readonly LogEntry[]> {
  const file = Bun.file(join(cwd, JSONL_FILE));
  if (!(await file.exists())) return [];
  const raw = (await file.text()).split("\n").filter((l) => l.length > 0);
  const entries: LogEntry[] = [];
  for (const line of raw) {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Truncated lines are dealt with by loadPriorState on resume; the
      // running loop writes whole lines, so this path is defensive only.
    }
  }
  return entries.slice(-RECENT_ENTRY_WINDOW);
}

export async function runLoop(cfg: RunLoopConfig, deps: RunLoopDeps = {}): Promise<void> {
  const { cwd, providers, stopWhen, signal, skillContent = "" } = cfg;
  const resolved = resolveDeps(deps);

  const specBody = await Bun.file(join(cwd, "autoresearch.md")).text();
  const spec = parseSpec(specBody);
  const prior = await loadPriorState(cwd, spec.direction);

  // If no prior `keep` exists, HEAD is still the setup commit — re-measure.
  // Otherwise the prior run's best-kept metric is the accurate reference.
  const baseline = prior?.best ?? (await measureBaseline(cwd, resolved.benchmark));

  const book: LoopBookkeeping = {
    iter: prior?.iter ?? 0,
    kept: prior?.kept ?? 0,
    discarded: prior?.discarded ?? 0,
    consecutiveDiscards: prior?.consecutiveDiscards ?? 0,
    best: prior?.best ?? baseline,
    lastMetric: prior?.lastMetric ?? null,
  };

  while (!signal?.aborted) {
    if (stopWhen?.({ ...book, baseline })) break;

    book.iter++;
    const recent = await loadRecentEntries(cwd);
    const prompt = buildPrompt({
      skill: skillContent,
      spec: specBody,
      recent,
      iter: book.iter,
    });
    const outcome = await runIteration({
      cwd,
      iter: book.iter,
      direction: spec.direction,
      best: book.best,
      providers,
      deps: resolved,
      prompt,
    });

    applyOutcome(book, outcome);
    await resolved.appendLog(cwd, outcome.entry);

    resolved.onTick({
      iter: book.iter,
      kept: book.kept,
      discarded: book.discarded,
      baseline,
      best: book.best,
      currentMetric: outcome.metric ?? book.best,
    });

    // Belt-and-braces: a rogue agent edit that survived revert would show up here.
    if (outcome.verdict !== "keep" && !(await isCleanExcept(JSONL_EXCLUDES, cwd))) {
      throw new Error(`Post-revert worktree is dirty at iteration ${book.iter}`);
    }
  }
}

function commitMessage(iter: number, hypothesis: string): string {
  const trimmed = hypothesis.trim() || "(no hypothesis)";
  return `autoresearch(iter ${iter}): ${summarizeHypothesis(trimmed)}`;
}

// ─── Workspace setup ───────────────────────────────────────────────────────

const MAX_SLUG_WORDS = 6;
const MAX_SLUG_CHARS = 50;

/**
 * Turn an objective string into a filesystem-safe slug.
 *
 * Lowercases, collapses any run of non-`[a-z0-9]` into a single `-`, trims
 * leading/trailing dashes, keeps only the first six hyphen-separated words,
 * and hard-caps at 50 characters. Empty input (or input that reduces to
 * nothing) falls back to `experiment-<YYYYMMDD-HHMMSS>`.
 */
export function slugify(objective: string, now: () => Date = () => new Date()): string {
  const raw = objective
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (raw === "") {
    const d = now();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `experiment-${stamp}`;
  }

  const firstWords = raw.split("-").slice(0, MAX_SLUG_WORDS).join("-");
  return firstWords.length <= MAX_SLUG_CHARS
    ? firstWords
    : firstWords.slice(0, MAX_SLUG_CHARS).replace(/-+$/, "");
}

export interface SetupResult {
  readonly slug: string;
  readonly branch: string;
  readonly worktreePath: string;
}

export interface WizardAnswers {
  readonly objective: string;
  readonly benchmarkCommand: string;
  readonly direction: Direction;
  readonly unit: string;
  /** Empty string = no correctness gate. */
  readonly checksCommand: string;
  /** Free-form text; may be multi-line. Empty string = user skipped. */
  readonly filesInScope: string;
  /** Free-form text; may be multi-line. Empty string = user skipped. */
  readonly constraints: string;
}

export interface RenderedTemplates {
  readonly md: string;
  readonly sh: string;
  /** Null when the user didn't provide a checks command. */
  readonly checks: string | null;
}

/** Render free-form user text as a Markdown bullet list; placeholder when empty. */
function renderBulletList(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "_(not specified)_";
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `- ${line}`)
    .join("\n");
}

function normalizeCommentText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validateUnitToken(unit: string): string {
  const trimmed = unit.trim();
  if (!/^[A-Za-z0-9_.%/+:-]+$/.test(trimmed)) {
    throw new Error(
      "Metric unit must be a single token using letters, digits, _, ., %, /, +, :, or -",
    );
  }
  return trimmed;
}

/**
 * Produce the three setup files from a set of wizard answers. Pure — no file
 * I/O. The caller writes the bytes. `checks` is null when the user opted out
 * of a correctness gate; the caller should skip writing the file in that case.
 */
export function renderTemplates(answers: WizardAnswers): RenderedTemplates {
  const shellObjective = normalizeCommentText(answers.objective);
  const unit = validateUnitToken(answers.unit);
  const checksSection = answers.checksCommand.trim()
    ? "\n## Checks\n\n- command: `./autoresearch.checks.sh`\n"
    : "";

  const md = `# Autoresearch: ${answers.objective}\n\n## Objective\n\n${answers.objective}\n\n## Metric\n\n- command: \`./autoresearch.sh\`\n- unit: ${unit}\n- direction: ${answers.direction}\n- baseline: measured at setup\n\n## Files in scope\n\n${renderBulletList(answers.filesInScope)}\n\n## Off-limits\n\n- \`autoresearch.*\` (run config; never modify)\n\n## Constraints\n\n${renderBulletList(answers.constraints)}\n${checksSection}`;

  const sh = `#!/usr/bin/env sh\n# Benchmark for: ${shellObjective}\n# Metric: ${answers.direction} ${unit}\n#\n# This script must emit a single line on stdout of the form:\n#   METRIC name=<name> value=<number> unit=${unit}\n# Non-zero exit OR missing METRIC line = crash verdict.\nset -e\n\n# Your command:\n${answers.benchmarkCommand}\n\n# TODO: replace the two lines below with your METRIC emission, e.g.:\n#   echo "METRIC name=runtime value=<value> unit=${unit}"\necho "autoresearch.sh has a TODO marker — edit it and run \\\`shaka autoresearch resume\\\`." >&2\nexit 1\n`;

  const checks = answers.checksCommand.trim()
    ? `#!/usr/bin/env sh\n# Correctness gate — exit 0 when the candidate is acceptable.\n# Non-zero exit = 'incorrect' verdict even if the metric improved.\nset -e\n\n${answers.checksCommand.trim()}\n`
    : null;

  return { md, sh, checks };
}

/** Legacy TODO-marker template used when the wizard didn't run (non-TTY setups). */
const TODO_ANSWERS: WizardAnswers = {
  objective: "<objective>",
  benchmarkCommand: "# TODO: replace with a real benchmark",
  direction: "minimize",
  unit: "TODO",
  checksCommand: "",
  filesInScope: "",
  constraints: "",
};

async function sourceIsCleanEnough(repoRoot: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git status failed in ${repoRoot}`);
  // Untracked lines start with '?? '. Tracked modifications do not.
  const trackedDirty = out.split("\n").some((l) => l.length > 0 && !l.startsWith("?? "));
  return !trackedDirty;
}

/**
 * Controls whether `setupWorkspace` renders setup templates and, if so, from
 * which source.
 *
 * - `"wizard"`: render from caller-supplied `WizardAnswers` (interactive
 *   six-question path).
 * - `"todo"`: render from the built-in TODO_ANSWERS stencil (non-TTY
 *   placeholder path — the user finalizes the `METRIC` emission by hand).
 * - `"defer"`: skip template rendering and file writing entirely. The worktree
 *   is created with inherited HEAD contents only. Used by full-auto setup
 *   where an interactive agent produces the files after the worktree exists.
 */
export type SetupWorkspaceArgs =
  | {
      readonly repoRoot: string;
      readonly objective: string;
      readonly templateMode: "wizard";
      readonly answers: WizardAnswers;
    }
  | {
      readonly repoRoot: string;
      readonly objective: string;
      readonly templateMode: "todo" | "defer";
    };

/**
 * Prepare a worktree for a new autoresearch experiment.
 *
 * Aborts if the source repo has tracked modifications — those would be
 * invisible inside the worktree and the user would likely lose track of
 * them. Untracked files are tolerated (they're already self-evident in the
 * user's `git status`).
 *
 * Template handling is controlled by `templateMode`:
 * - `"wizard"` renders from `args.answers`.
 * - `"todo"` renders from the TODO stencil using `args.objective`.
 * - `"defer"` skips template rendering and the `autoresearch: setup` commit
 *   entirely. Any `autoresearch.{md,sh,checks.sh}` inherited from the source
 *   repo's HEAD survives untouched; the caller is responsible for authoring
 *   missing files before the loop runs.
 */
export async function setupWorkspace(args: SetupWorkspaceArgs): Promise<SetupResult> {
  if (!(await sourceIsCleanEnough(args.repoRoot))) {
    throw new Error(
      "Source repo has uncommitted changes. Commit or stash before starting autoresearch.",
    );
  }

  const slug = slugify(args.objective);
  const branch = `autoresearch/${slug}`;
  const worktreePath = join(dirname(args.repoRoot), `${basename(args.repoRoot)}.ar-${slug}`);

  // Render templates up-front (outside the try/catch) when needed, so invalid
  // wizard answers fail before we mutate the repo with a worktree we'd then
  // have to clean up.
  const rendered =
    args.templateMode === "defer"
      ? null
      : args.templateMode === "wizard"
        ? renderTemplates(args.answers)
        : renderTemplates({ ...TODO_ANSWERS, objective: args.objective });

  try {
    await addWorktree(worktreePath, branch, args.repoRoot);
  } catch (err) {
    throw new Error(
      `An experiment worktree at '${worktreePath}' already exists. Use \`shaka autoresearch resume\` to continue it, or \`git worktree remove\` if abandoned.`,
      { cause: err },
    );
  }

  // Defer mode: worktree only. The setup agent authors files afterwards; any
  // templates already tracked at HEAD are inherited into the worktree and
  // left alone by the caller's dirty-gate discipline.
  if (rendered === null) {
    return { slug, branch, worktreePath };
  }

  // Auto-generate templates when absent. When they already exist (e.g. user
  // tracked them in the source repo's HEAD), the worktree inherits them and
  // we leave them alone.
  const mdPath = join(worktreePath, "autoresearch.md");
  const shPath = join(worktreePath, "autoresearch.sh");
  const checksPath = join(worktreePath, "autoresearch.checks.sh");
  const mdExists = await Bun.file(mdPath).exists();
  const shExists = await Bun.file(shPath).exists();
  const checksExisted = await Bun.file(checksPath).exists();

  if (!mdExists) await Bun.write(mdPath, rendered.md);
  if (!shExists) {
    await Bun.write(shPath, rendered.sh);
    await chmod(shPath, 0o755);
  }
  if (!checksExisted && rendered.checks !== null) {
    await Bun.write(checksPath, rendered.checks);
    await chmod(checksPath, 0o755);
  }

  const wroteAnything = !mdExists || !shExists || (!checksExisted && rendered.checks !== null);
  if (wroteAnything) {
    await commitAll("autoresearch: setup", worktreePath);
  }

  return { slug, branch, worktreePath };
}

// ─── Discovery + resume ────────────────────────────────────────────────────

const AUTORESEARCH_SLUG_PREFIX = "autoresearch/";
const AUTORESEARCH_BRANCH_PREFIX = `refs/heads/${AUTORESEARCH_SLUG_PREFIX}`;

export interface ExperimentWorktree {
  readonly slug: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly head: string;
  readonly locked: string | null;
  readonly prunable: string | null;
}

/**
 * True iff `worktreePath` is a linked worktree created via `git worktree add`.
 * A `.git` file alone is not enough: submodules and separate-git-dir checkouts
 * use one too. Linked worktree git dirs live under the common dir's
 * `worktrees/<id>` metadata directory.
 */
async function isLinkedWorktree(worktreePath: string): Promise<boolean> {
  // Bun.spawn throws ENOENT when cwd points to a deleted/invalid directory
  // (stale git worktree metadata pointing at a path the user rm-rf'd). Without
  // the try/catch, one stale entry rejects findExperimentWorktree's
  // Promise.all and blocks discovery/resume for every OTHER experiment.
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-dir", "--git-common-dir"], {
      cwd: worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return false;

    const [gitDirRaw, commonDirRaw] = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!gitDirRaw || !commonDirRaw) return false;

    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(worktreePath, gitDirRaw);
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : join(worktreePath, commonDirRaw);
    const [realGitDir, realCommonDir] = await Promise.all([
      realpath(gitDir).catch(() => gitDir),
      realpath(commonDir).catch(() => commonDir),
    ]);
    const rel = relative(join(realCommonDir, "worktrees"), realGitDir);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * All autoresearch experiments reachable from `cwd` via `git worktree list`.
 *
 * Filters to linked worktrees whose branch starts with `autoresearch/`. Main
 * worktrees are excluded even when they happen to sit on such a branch —
 * that's a masquerading situation the caller should not confuse with a real
 * experiment checkout.
 */
export async function findExperimentWorktree(cwd: string): Promise<readonly ExperimentWorktree[]> {
  const candidates = (await listWorktrees(cwd)).filter((w) =>
    w.branch?.startsWith(AUTORESEARCH_BRANCH_PREFIX),
  );
  const linked = await Promise.all(
    candidates.map(async (w) => ((await isLinkedWorktree(w.path)) ? w : null)),
  );
  return linked
    .filter((w): w is NonNullable<typeof w> => w !== null)
    .map((w) => ({
      slug: (w.branch as string).slice(AUTORESEARCH_BRANCH_PREFIX.length),
      worktreePath: w.path,
      branch: w.branch as string,
      head: w.head,
      locked: w.locked,
      prunable: w.prunable,
    }));
}

/**
 * Resolve a single experiment worktree by slug (or the unique one when slug is
 * omitted). Throws with actionable messages on misses and ambiguity so command
 * handlers can relay them verbatim.
 */
export async function resolveExperimentWorktree(
  repoRoot: string,
  slug: string | undefined,
): Promise<ExperimentWorktree> {
  const experiments = await findExperimentWorktree(repoRoot);

  if (slug !== undefined) {
    const match = experiments.find((e) => e.slug === slug);
    if (!match) {
      const candidates = experiments.map((e) => e.slug).join(", ") || "(none)";
      throw new Error(
        `No autoresearch experiment with slug '${slug}'. Known experiments: ${candidates}.`,
      );
    }
    return match;
  }

  const active = experiments.filter((e) => e.locked === null && e.prunable === null);
  if (active.length === 0) {
    throw new Error("No active autoresearch experiments found in this repository.");
  }
  if (active.length > 1) {
    const slugs = active.map((e) => e.slug).join(", ");
    throw new Error(
      `Multiple autoresearch experiments are active (${slugs}). Specify one: \`shaka autoresearch resume <slug>\`.`,
    );
  }
  return active[0] as ExperimentWorktree;
}

/** True iff `autoresearch.md` is tracked at HEAD in `cwd`. */
async function specTrackedAtHead(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "ls-tree", "--name-only", "HEAD", "autoresearch.md"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim() === "autoresearch.md";
}

/**
 * Pick the worktree `resume` should run against.
 *
 * When `cwd` is already inside one of the discovered experiment worktrees —
 * verified by realpath-matching against `findExperimentWorktree` — we short
 * to that worktree. Otherwise we defer to {@link resolveExperimentWorktree},
 * which looks up by slug or picks the unique active experiment.
 *
 * This replaces the earlier heuristic that trusted any `autoresearch/*`
 * branch name as proof of being in an experiment worktree. A main repo that
 * merely happens to be on such a branch would otherwise receive revert
 * operations targeting its primary checkout.
 */
export async function resolveResumeTarget(
  cwd: string,
  repoRoot: string,
  slug: string | undefined,
): Promise<string> {
  const experiments = await findExperimentWorktree(repoRoot);
  if (slug !== undefined) {
    return (await resolveExperimentWorktree(repoRoot, slug)).worktreePath;
  }
  // Realpath both sides of the comparison: `cwd` can arrive via user-accessible
  // symlinks (e.g. macOS exposes /tmp, but git worktree list reports the
  // canonical /private/tmp). Without symmetric resolution, a textual mismatch
  // between the two otherwise-equal paths makes the in-worktree check fail and
  // falls through to the by-slug resolver, which throws on ambiguity.
  const realCwd = await realpath(cwd);
  const realExperiments = await Promise.all(
    experiments.map(async (e) => ({
      ...e,
      realPath: await realpath(e.worktreePath).catch(() => e.worktreePath),
    })),
  );
  const inside = realExperiments.find((e) => {
    const rel = relative(e.realPath, realCwd);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (inside) return inside.worktreePath;
  return (await resolveExperimentWorktree(repoRoot, slug)).worktreePath;
}

/**
 * Resume an in-progress experiment. `cfg.cwd` must be an autoresearch worktree
 * (autoresearch.md tracked at HEAD AND current branch starts with
 * `autoresearch/`). Both checks rule out the common false positive of a random
 * repo that happens to carry a similarly-named file.
 *
 * Caller contract: the worktree must be clean except for `autoresearch.jsonl`.
 * The command layer enforces this by calling `commitFinalizeIfDirty` (which
 * auto-commits legitimate setup edits and throws on unrelated dirty state)
 * before handing control here. Duplicating that check at this layer would
 * conflict with the command-layer policy that setup-artifact edits are
 * expected and should be committed rather than rejected.
 */
export async function runResume(cfg: RunLoopConfig, deps: RunLoopDeps = {}): Promise<void> {
  if (!(await isLinkedWorktree(cfg.cwd))) {
    throw new Error(
      `Not inside an autoresearch worktree: ${cfg.cwd} is not a linked worktree. Use \`shaka autoresearch resume <slug>\` from the source repo instead.`,
    );
  }

  if (!(await specTrackedAtHead(cfg.cwd))) {
    throw new Error(
      `autoresearch.md not tracked at HEAD in ${cfg.cwd} — not inside an autoresearch worktree. Run \`shaka autoresearch start\` first.`,
    );
  }

  const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: cfg.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [branchOut, branchExit] = await Promise.all([
    new Response(branchProc.stdout).text(),
    branchProc.exited,
  ]);
  const branch = branchOut.trim();
  if (branchExit !== 0 || !branch.startsWith(AUTORESEARCH_SLUG_PREFIX)) {
    throw new Error(
      `Not inside an autoresearch worktree (current branch: '${branch}'). Use \`shaka autoresearch resume <slug>\` from the source repo instead.`,
    );
  }

  await runLoop(cfg, deps);
}
