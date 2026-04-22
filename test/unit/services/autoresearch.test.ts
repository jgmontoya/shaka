import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentExecutionOptions,
  AgentExecutionResult,
} from "../../../src/domain/agent-execution";
import {
  type BenchResult,
  type Direction,
  type LogEntry,
  type VerdictInput,
  type WidgetState,
  type WizardAnswers,
  assertOnlySetupDirty,
  buildPrompt,
  classifyVerdict,
  extractAsi,
  extractHypothesis,
  findExperimentWorktree,
  improvesBest,
  parseMetricLine,
  renderTemplates,
  resolveExperimentWorktree,
  resolveResumeTarget,
  runBenchmark,
  runLoop,
  runResume,
  setupWorkspace,
  slugify,
  summarizeHypothesis,
} from "../../../src/services/autoresearch";
import { isCleanExcept } from "../../../src/services/git";
import type { DetectedProviders } from "../../../src/services/provider-detection";

const NO_PROVIDERS: DetectedProviders = { claude: false, opencode: false, codex: false };

async function headSha(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git rev-parse failed (exit ${code})`);
  return out.trim();
}

async function run(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (exit ${code}): ${stderr}`);
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`);
  return stdout;
}

async function setupExperimentRepo(opts: { direction: Direction }): Promise<string> {
  const dir = join(tmpdir(), `shaka-ar-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  await run(["git", "init", "-q", "-b", "main"], dir);
  await run(["git", "config", "user.email", "test@shaka"], dir);
  await run(["git", "config", "user.name", "Test"], dir);

  await Bun.write(
    join(dir, "autoresearch.md"),
    `# Autoresearch: test\n\n## Metric\n- direction: ${opts.direction}\n`,
  );
  await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\necho 'METRIC name=t value=1 unit=ms'\n");

  await run(["git", "add", "-A"], dir);
  await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "setup"], dir);
  return dir;
}

function scriptedAgent(responses: Array<{ stdout: string; timedOut?: boolean }>) {
  let i = 0;
  return async (_opts: AgentExecutionOptions, _det: DetectedProviders): Promise<AgentExecutionResult> => {
    const r = responses[i++];
    if (!r) throw new Error(`scriptedAgent exhausted after ${i - 1} calls`);
    return {
      exitCode: 0,
      stdout: r.stdout,
      stderr: "",
      provider: "claude",
      timedOut: r.timedOut ?? false,
    };
  };
}

function scriptedBenchmark(results: Array<Partial<BenchResult> & { value?: number }>) {
  let i = 0;
  return async (_cwd: string): Promise<BenchResult> => {
    const r = results[i++];
    if (!r) throw new Error(`scriptedBenchmark exhausted after ${i - 1} calls`);
    if (r.value !== undefined) {
      return {
        exitCode: 0,
        stdout: `METRIC name=t value=${r.value} unit=ms`,
        stderr: "",
        measurement: { name: "t", value: r.value, unit: "ms" },
      };
    }
    return {
      exitCode: r.exitCode ?? 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      measurement: r.measurement ?? null,
    };
  };
}

describe("parseMetricLine", () => {
  test("parses a single valid METRIC line", () => {
    const result = parseMetricLine("METRIC name=runtime value=42.5 unit=ms\n");
    expect(result).toEqual({ name: "runtime", value: 42.5, unit: "ms" });
  });

  test("last METRIC line wins when multiple are present", () => {
    const stdout = [
      "METRIC name=runtime value=100 unit=ms",
      "debug: something happened",
      "METRIC name=runtime value=42 unit=ms",
    ].join("\n");
    expect(parseMetricLine(stdout)).toEqual({ name: "runtime", value: 42, unit: "ms" });
  });

  test("returns null when no METRIC line is present", () => {
    expect(parseMetricLine("just some output\nno metric here")).toBeNull();
  });

  test("returns null on non-finite value", () => {
    expect(parseMetricLine("METRIC name=x value=NaN unit=ms")).toBeNull();
    expect(parseMetricLine("METRIC name=x value=Infinity unit=ms")).toBeNull();
    expect(parseMetricLine("METRIC name=x value=-Infinity unit=ms")).toBeNull();
    expect(parseMetricLine("METRIC name=x value=notanumber unit=ms")).toBeNull();
  });

  test("ignores METRIC substring inside other lines (anchored)", () => {
    // Not a real METRIC line — substring anchored regex must reject it
    const stdout = "Error: expected METRIC name=x value=5 unit=ms in output";
    expect(parseMetricLine(stdout)).toBeNull();
  });

  test("accepts integer values", () => {
    expect(parseMetricLine("METRIC name=count value=7 unit=iterations")).toEqual({
      name: "count",
      value: 7,
      unit: "iterations",
    });
  });

  test("accepts negative finite values", () => {
    expect(parseMetricLine("METRIC name=delta value=-3.14 unit=units")).toEqual({
      name: "delta",
      value: -3.14,
      unit: "units",
    });
  });
});

describe("improvesBest", () => {
  test("minimize: lower beats higher", () => {
    expect(improvesBest(5, 10, "minimize")).toBe(true);
    expect(improvesBest(10, 5, "minimize")).toBe(false);
  });

  test("maximize: higher beats lower", () => {
    expect(improvesBest(10, 5, "maximize")).toBe(true);
    expect(improvesBest(5, 10, "maximize")).toBe(false);
  });

  test("equal values do not improve", () => {
    expect(improvesBest(5, 5, "minimize")).toBe(false);
    expect(improvesBest(5, 5, "maximize")).toBe(false);
  });
});

describe("classifyVerdict", () => {
  const goodRun: VerdictInput = {
    metric: 5,
    benchmarkExitCode: 0,
    beatsBest: true,
    correctnessOk: true,
    commitSucceeded: true,
    agentTimedOut: false,
  };

  test("happy path returns keep", () => {
    expect(classifyVerdict(goodRun)).toBe("keep");
  });

  test("agent timeout dominates everything", () => {
    expect(classifyVerdict({ ...goodRun, agentTimedOut: true })).toBe("timeout");
  });

  test("benchmark non-zero exit → crash", () => {
    expect(classifyVerdict({ ...goodRun, benchmarkExitCode: 1 })).toBe("crash");
  });

  test("missing METRIC (metric=null) → crash even with exit 0", () => {
    expect(classifyVerdict({ ...goodRun, metric: null })).toBe("crash");
  });

  test("failed correctness check → incorrect", () => {
    expect(classifyVerdict({ ...goodRun, correctnessOk: false })).toBe("incorrect");
  });

  test("metric did not improve → discard", () => {
    expect(classifyVerdict({ ...goodRun, beatsBest: false })).toBe("discard");
  });

  test("would-be keep but commit hook failed → incorrect", () => {
    expect(classifyVerdict({ ...goodRun, commitSucceeded: false })).toBe("incorrect");
  });

  test("timeout beats crash when both would apply", () => {
    expect(
      classifyVerdict({ ...goodRun, agentTimedOut: true, benchmarkExitCode: 1 }),
    ).toBe("timeout");
  });

  test("crash beats incorrect and discard", () => {
    expect(
      classifyVerdict({
        ...goodRun,
        benchmarkExitCode: 1,
        correctnessOk: false,
        beatsBest: false,
      }),
    ).toBe("crash");
  });
});

describe("runLoop", () => {
  let cwd: string;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  test("one iteration with worse metric → discard; HEAD unchanged, jsonl has 1 line", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    const agent = scriptedAgent([{ stdout: "HYPOTHESIS: noop" }]);
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 150 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent, benchmark },
    );

    const jsonl = (await Bun.file(join(cwd, "autoresearch.jsonl")).text()).trim();
    const entries = jsonl.split("\n").map((l) => JSON.parse(l));

    expect(entries).toHaveLength(1);
    expect(entries[0].iter).toBe(1);
    expect(entries[0].verdict).toBe("discard");
    expect(entries[0].metric).toBe(150);
    expect(entries[0].commit).toBeNull();
    expect(entries[0].provider).toBe("claude");

    expect(await headSha(cwd)).toBe(headBefore);
    expect(await isCleanExcept(["autoresearch.jsonl"], cwd)).toBe(true);
  });

  test("metric beats baseline → keep; commit advances HEAD, jsonl stays untracked", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    // Add a source file the agent will "edit"
    await Bun.write(join(cwd, "slow.ts"), "export const x = 1;\n");
    await run(["git", "add", "-A"], cwd);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "add slow.ts"], cwd);
    const headBefore = await headSha(cwd);

    // Agent writes a file change as a side effect before returning its hypothesis
    const editingAgent = async (
      _opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "slow.ts"), "export const x = 2;\n");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: bumped x",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    // baseline=100, iter1=50 (beats it)
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 50 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: editingAgent, benchmark },
    );

    const headAfter = await headSha(cwd);
    expect(headAfter).not.toBe(headBefore);

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("keep");
    expect(entries[0].metric).toBe(50);
    expect(entries[0].commit).toMatch(/^[0-9a-f]{7}$/);

    // The jsonl is untracked and clean-except-jsonl still holds
    expect(await isCleanExcept(["autoresearch.jsonl"], cwd)).toBe(true);

    // The keep commit must not contain the jsonl
    const lsTreeProc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const treeFiles = (await new Response(lsTreeProc.stdout).text()).split("\n");
    expect(treeFiles).not.toContain("autoresearch.jsonl");
    expect(treeFiles).toContain("slow.ts");
  });

  test("benchmark exits non-zero → crash; revert, no commit", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    const agent = scriptedAgent([{ stdout: "HYPOTHESIS: bad idea" }]);
    const benchmark = scriptedBenchmark([
      { value: 100 },
      { exitCode: 1, stdout: "", stderr: "boom", measurement: null },
    ]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent, benchmark },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0].verdict).toBe("crash");
    expect(entries[0].metric).toBeNull();
    expect(entries[0].commit).toBeNull();
    expect(await headSha(cwd)).toBe(headBefore);
  });

  test("checks script fails → incorrect; revert, no commit", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    // Agent edits a file; bench improves; but checks say the result is wrong
    const editingAgent = async (
      _opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "note.txt"), "agent was here");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: cheated",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 50 }]);
    const checks = async (_cwd: string) => ({ exitCode: 1 });

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: editingAgent, benchmark, checks },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0].verdict).toBe("incorrect");
    expect(entries[0].commit).toBeNull();
    expect(await headSha(cwd)).toBe(headBefore);
    expect(await isCleanExcept(["autoresearch.jsonl"], cwd)).toBe(true);
  });

  test("commit hook failures are recorded in jsonl diagnostics", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
    await Bun.write(
      join(cwd, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\necho 'blocked by hook' >&2\nexit 1\n",
    );
    await run(["chmod", "+x", join(cwd, ".git", "hooks", "pre-commit")], cwd);
    await Bun.write(join(cwd, "slow.ts"), "export const x = 1;\n");
    await run(["git", "add", "-A"], cwd);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-q", "-m", "add slow"], cwd);

    const editingAgent = async (): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "slow.ts"), "export const x = 2;\n");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: commit hook should be visible",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 50 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: editingAgent, benchmark },
    );

    const [entry] = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entry.verdict).toBe("incorrect");
    expect(entry.commit).toBeNull();
    expect(entry.commitError).toContain("blocked by hook");
  });

  test("resumes from existing jsonl: next iter continues numbering, no baseline re-measurement", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });

    // Pre-seed a jsonl with a single keep entry at iter 1
    const seedEntry = {
      iter: 1,
      ts: "2026-04-18T00:00:00.000Z",
      provider: "claude",
      hypothesis: "prior run win",
      metric: 80,
      verdict: "keep",
      commit: "abcdef0",
      asi: [],
      duration_ms: 1000,
    };
    await Bun.write(join(cwd, "autoresearch.jsonl"), `${JSON.stringify(seedEntry)}\n`);

    let benchCalls = 0;
    const benchmark = async (_cwd: string): Promise<BenchResult> => {
      benchCalls++;
      // Only iter 2's call should happen — no baseline remeasurement
      return {
        exitCode: 0,
        stdout: "METRIC name=t value=70 unit=ms",
        stderr: "",
        measurement: { name: "t", value: 70, unit: "ms" },
      };
    };
    const editingAgent = async (
      _opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "new.txt"), "touched");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: resumed",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 2 },
      { agent: editingAgent, benchmark },
    );

    expect(benchCalls).toBe(1); // only iter 2, no baseline

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
    expect(entries[0].iter).toBe(1);
    expect(entries[0].hypothesis).toBe("prior run win");
    expect(entries[1].iter).toBe(2);
    expect(entries[1].verdict).toBe("keep"); // 70 beat prior best of 80
  });

  test("resume drops an entirely truncated jsonl tail before appending", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    await Bun.write(join(cwd, "autoresearch.jsonl"), '{"iter":1,"hypothesis":"cut off');

    const editingAgent = async (): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "patch.txt"), "fresh");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: fresh start after truncated log",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 90 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: editingAgent, benchmark },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].iter).toBe(1);
    expect(entries[0].hypothesis).toBe("fresh start after truncated log");
  });

  test("agent exiting non-zero (not a timeout) aborts the loop with a clear error", async () => {
    // Regression: infrastructure failures (no provider, spawn error, CLI
    // crash) must not be silently coerced into an iteration verdict —
    // otherwise the user sees a misleading jsonl history instead of the real
    // root cause.
    cwd = await setupExperimentRepo({ direction: "minimize" });

    const crashingAgent = async (): Promise<AgentExecutionResult> => ({
      exitCode: 1,
      stdout: "",
      stderr: "provider CLI crashed",
      provider: null,
      timedOut: false,
    });
    const benchmark = scriptedBenchmark([{ value: 100 }]); // baseline only

    await expect(
      runLoop(
        { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
        { agent: crashingAgent, benchmark },
      ),
    ).rejects.toThrow(/provider CLI crashed/i);

    // No iteration entry should have been written — the loop failed before
    // getting to its own bookkeeping.
    const file = Bun.file(join(cwd, "autoresearch.jsonl"));
    expect(await file.exists()).toBe(false);
  });

  test("agent creating an untracked setup artifact also trips the tamper guard", async () => {
    // Regression: `git diff HEAD` only sees tracked changes. An agent that
    // creates a brand-new autoresearch.checks.sh (not previously tracked)
    // would slip past a diff-based guard and land in the keep commit.
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    const creatingAgent = async (): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "legit.txt"), "real code change");
      // Fresh, untracked setup artifact — this is the attack surface the
      // diff-based guard missed.
      await Bun.write(join(cwd, "autoresearch.checks.sh"), "#!/bin/sh\nexit 0\n");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: sneak in a checks script",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    // Metric improves — if the guard misses, this would be a `keep` and the
    // new checks.sh would ride along in the commit.
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 50 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: creatingAgent, benchmark },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0].verdict).toBe("incorrect");
    expect(entries[0].commit).toBeNull();
    expect(await headSha(cwd)).toBe(headBefore);
    // Revert should have dropped the untracked file too
    expect(await Bun.file(join(cwd, "autoresearch.checks.sh")).exists()).toBe(false);
  });

  test("agent tampering with setup artifacts → incorrect verdict, no benchmark, revert", async () => {
    // Regression: the plan mandates "runner asserts tracked setup files
    // unchanged before verdict" — else an agent that ignores the skill can
    // commit spec/benchmark edits as legitimate wins.
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    const tamperingAgent = async (): Promise<AgentExecutionResult> => {
      // Edit a real source file (so there'd be something to commit)
      await Bun.write(join(cwd, "legit.txt"), "harmless");
      // Also edit a setup artifact — this is what should trip the safety gate
      await Bun.write(
        join(cwd, "autoresearch.md"),
        "# Autoresearch: hijacked\n\n## Metric\n- direction: minimize\n",
      );
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: tamper with spec",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    let benchCalls = 0;
    const benchmark = async (_cwd: string): Promise<BenchResult> => {
      benchCalls++;
      return {
        exitCode: 0,
        stdout: "METRIC name=t value=100 unit=ms",
        stderr: "",
        measurement: { name: "t", value: 100, unit: "ms" },
      };
    };

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent: tamperingAgent, benchmark },
    );

    // Only baseline was measured; tampered iteration short-circuited.
    expect(benchCalls).toBe(1);
    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("incorrect");
    expect(entries[0].commit).toBeNull();

    // HEAD is unchanged and the worktree is back to clean-except-jsonl.
    expect(await headSha(cwd)).toBe(headBefore);
    expect(await isCleanExcept(["autoresearch.jsonl"], cwd)).toBe(true);
  });

  test("agent tampering with jsonl is restored and classified incorrect", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const prior = {
      iter: 1,
      ts: "2026-04-18T00:00:00.000Z",
      provider: "claude",
      hypothesis: "prior",
      metric: 80,
      verdict: "keep",
      commit: "abc1234",
      asi: [],
      duration_ms: 100,
    };
    await Bun.write(join(cwd, "autoresearch.jsonl"), `${JSON.stringify(prior)}\n`);

    let benchCalls = 0;
    const tamperingAgent = async (): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "candidate.txt"), "should be reverted");
      await Bun.write(join(cwd, "autoresearch.jsonl"), "agent-owned history\n");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: tamper with history",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = async (): Promise<BenchResult> => {
      benchCalls++;
      return {
        exitCode: 0,
        stdout: "METRIC name=t value=70 unit=ms",
        stderr: "",
        measurement: { name: "t", value: 70, unit: "ms" },
      };
    };

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 2 },
      { agent: tamperingAgent, benchmark },
    );

    expect(benchCalls).toBe(0);
    expect(await Bun.file(join(cwd, "candidate.txt")).exists()).toBe(false);
    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(prior);
    expect(entries[1].iter).toBe(2);
    expect(entries[1].verdict).toBe("incorrect");
    expect(entries[1].hypothesis).toBe("tamper with history");
  });

  test("resume with only reverted (discard/incorrect) history re-measures baseline against HEAD", async () => {
    // Regression: a prior run that never produced a `keep` leaves HEAD at the
    // setup commit. The jsonl records reverted candidate metrics that do NOT
    // represent HEAD's performance. If the runner trusts those as 'best', a
    // genuinely improving metric gets misclassified as `discard`.
    cwd = await setupExperimentRepo({ direction: "minimize" });

    // Seed a reverted iteration whose candidate metric was better than baseline
    // but was never kept (checks failed → incorrect → revert).
    const revertedEntry = {
      iter: 1,
      ts: "2026-04-19T00:00:00.000Z",
      provider: "claude",
      hypothesis: "tempting but incorrect",
      metric: 50,
      verdict: "incorrect",
      commit: null,
      asi: [],
      duration_ms: 100,
    };
    await Bun.write(
      join(cwd, "autoresearch.jsonl"),
      `${JSON.stringify(revertedEntry)}\n`,
    );

    // True baseline (HEAD state) is 100; new iter measures 80 — a real improvement.
    let benchCalls = 0;
    const benchmark = async (_cwd: string): Promise<BenchResult> => {
      benchCalls++;
      const value = benchCalls === 1 ? 100 : 80;
      return {
        exitCode: 0,
        stdout: `METRIC name=t value=${value} unit=ms`,
        stderr: "",
        measurement: { name: "t", value, unit: "ms" },
      };
    };
    const editingAgent = async (): Promise<AgentExecutionResult> => {
      await Bun.write(join(cwd, "change.txt"), "edit");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: real improvement",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 2 },
      { agent: editingAgent, benchmark },
    );

    expect(benchCalls).toBe(2); // baseline + iter 2
    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const newEntry = entries.find((e) => e.iter === 2);
    expect(newEntry.verdict).toBe("keep");
    expect(newEntry.metric).toBe(80);
  });

  test("resume skips a truncated trailing line and continues from the last valid entry", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });

    const validEntry = {
      iter: 3,
      ts: "2026-04-18T00:00:00.000Z",
      provider: "claude",
      hypothesis: "prior keep",
      metric: 40,
      verdict: "keep",
      commit: "deadbee",
      asi: [],
      duration_ms: 500,
    };
    // Last line is deliberately truncated mid-JSON — simulates SIGKILL during appendLog
    const truncated = `{"iter":4,"ts":"2026-04-18T00:00:01.000Z","provider":"claude","hypothesis":"cut off`;
    await Bun.write(
      join(cwd, "autoresearch.jsonl"),
      `${JSON.stringify(validEntry)}\n${truncated}`,
    );

    const agent = scriptedAgent([{ stdout: "HYPOTHESIS: after recovery" }]);
    const benchmark = scriptedBenchmark([{ value: 35 }]); // beats prior best 40

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 4 },
      { agent, benchmark },
    );

    // The bad line must be gone after appendLog rewrites; actually appendLog
    // just appends. Let's read and parse what we have.
    const raw = await Bun.file(join(cwd, "autoresearch.jsonl")).text();
    const validLines = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    // Prior valid + new iter 4 entry
    const iters = validLines.map((e) => e.iter);
    expect(iters).toContain(3);
    expect(iters).toContain(4);
    // Truncated line may still be on disk but no valid entry with its iter exists
    const iter4 = validLines.find((e) => e.iter === 4);
    expect(iter4?.hypothesis).toBe("after recovery");
  });

  test("agent receives a prompt built from skill + spec + recent + iter; entry.asi reflects agent output", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });

    // Seed a prior entry so the "recent" section is non-empty
    const prior = {
      iter: 1,
      ts: "2026-04-19T00:00:00.000Z",
      provider: "claude",
      hypothesis: "set lookup",
      metric: 90,
      verdict: "keep",
      commit: "aaaaaaa",
      asi: ["#lookup"],
      duration_ms: 100,
    };
    await Bun.write(join(cwd, "autoresearch.jsonl"), `${JSON.stringify(prior)}\n`);

    let capturedPrompt = "";
    const capturingAgent = async (
      opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      capturedPrompt = opts.prompt;
      await Bun.write(join(cwd, "touch.txt"), "edit");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: smaller set\nASI: #micro-opt #follow-up",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = scriptedBenchmark([{ value: 80 }]); // beats prior best of 90

    await runLoop(
      {
        cwd,
        providers: NO_PROVIDERS,
        stopWhen: (s) => s.iter >= 2,
        skillContent: "## Autoresearch Protocol\nOne change per iteration.",
      },
      { agent: capturingAgent, benchmark },
    );

    // Prompt contains the skill body
    expect(capturedPrompt).toContain("Autoresearch Protocol");
    // Prompt contains the spec body from autoresearch.md
    expect(capturedPrompt).toContain("## Metric");
    expect(capturedPrompt).toContain("direction: minimize");
    // Prompt contains the recent iteration bullet
    expect(capturedPrompt).toContain("set lookup");
    // Prompt instructs the agent on the response format
    expect(capturedPrompt).toContain("HYPOTHESIS:");

    // The new log entry carries the parsed asi tags
    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const iter2 = entries.find((e) => e.iter === 2);
    expect(iter2.asi).toEqual(["#micro-opt", "#follow-up"]);
  });

  test("onTick is called once per iteration with the up-to-date state", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });

    // baseline=100, iter1=150 (worse → discard), iter2=60 (better → keep)
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 150 }, { value: 60 }]);
    const editingAgent = async () => {
      await Bun.write(join(cwd, "touch.txt"), String(Date.now()));
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: editing",
        stderr: "",
        provider: "claude" as const,
        timedOut: false,
      };
    };

    const ticks: WidgetState[] = [];
    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 2 },
      {
        agent: editingAgent,
        benchmark,
        onTick: (state) => {
          ticks.push(state);
        },
      },
    );

    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.iter).toBe(1);
    expect(ticks[0]?.discarded).toBe(1);
    expect(ticks[0]?.kept).toBe(0);
    expect(ticks[1]?.iter).toBe(2);
    expect(ticks[1]?.kept).toBe(1);
    expect(ticks[1]?.best).toBe(60);
    expect(ticks[1]?.currentMetric).toBe(60);
    expect(ticks[1]?.baseline).toBe(100);
  });

  test("AbortSignal ends the loop after the current iteration completes", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const controller = new AbortController();

    const agent = scriptedAgent([
      { stdout: "HYPOTHESIS: one" },
      { stdout: "HYPOTHESIS: two" }, // would only be called if loop continues
    ]);
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 150 }, { value: 200 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, signal: controller.signal },
      {
        agent,
        benchmark,
        appendLog: async (dir, entry) => {
          // Default append + abort after first iteration lands on disk
          const path = join(dir, "autoresearch.jsonl");
          const file = Bun.file(path);
          const prev = (await file.exists()) ? await file.text() : "";
          await Bun.write(path, prev + JSON.stringify(entry) + "\n");
          controller.abort();
        },
      },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0].iter).toBe(1);
  });

  test("agent timed out → timeout; revert, no commit", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });
    const headBefore = await headSha(cwd);

    const agent = scriptedAgent([{ stdout: "(no output)", timedOut: true }]);
    // Baseline must still succeed so the runner reaches iter 1
    const benchmark = scriptedBenchmark([{ value: 100 }, { value: 999 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent, benchmark },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0].verdict).toBe("timeout");
    expect(entries[0].commit).toBeNull();
    expect(await headSha(cwd)).toBe(headBefore);
  });

  // A timed-out agent can't produce a legitimate candidate — its edits are, by
  // definition, mid-stream. Running the benchmark (and checks) against that
  // tree is wasted work at best and dangerous at worst: a half-written file
  // can crash the benchmark, a partial migration can corrupt shared state.
  // Invariant: on timeout we revert and classify without invoking benchmark.
  test("agent timed out → benchmark is not run on the iteration tree", async () => {
    cwd = await setupExperimentRepo({ direction: "minimize" });

    const agent = scriptedAgent([{ stdout: "(no output)", timedOut: true }]);
    // Only the baseline is scripted. If the runner calls benchmark a second
    // time for the timed-out iteration, scriptedBenchmark throws "exhausted"
    // and the test fails.
    const benchmark = scriptedBenchmark([{ value: 100 }]);

    await runLoop(
      { cwd, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 1 },
      { agent, benchmark },
    );

    const entries = (await Bun.file(join(cwd, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0].verdict).toBe("timeout");
  });
});

describe("buildPrompt", () => {
  const makeEntry = (overrides: Partial<LogEntry>): LogEntry => ({
    iter: 1,
    ts: "2026-04-19T00:00:00.000Z",
    provider: "claude",
    hypothesis: "unchanged",
    metric: 10,
    verdict: "keep",
    commit: "deadbee",
    asi: [],
    duration_ms: 100,
    ...overrides,
  });

  test("includes the skill body, spec body, recent section, and iteration task", () => {
    const prompt = buildPrompt({
      skill: "SKILL CONTENT",
      spec: "SPEC CONTENT",
      recent: [makeEntry({ iter: 1, hypothesis: "use a set", metric: 8 })],
      iter: 2,
    });
    expect(prompt).toContain("SKILL CONTENT");
    expect(prompt).toContain("SPEC CONTENT");
    expect(prompt).toContain("## Recent iterations");
    expect(prompt).toContain("iter 1");
    expect(prompt).toContain("use a set");
    expect(prompt).toContain("## Your task");
    expect(prompt).toContain("iteration 2");
  });

  test("shows a 'no prior iterations' placeholder when recent is empty", () => {
    const prompt = buildPrompt({ skill: "s", spec: "sp", recent: [], iter: 1 });
    expect(prompt).toContain("no prior iterations");
  });

  test("renders recent entries with verdict and metric in a scannable bullet", () => {
    const entry = makeEntry({ iter: 3, verdict: "discard", metric: 42.5, hypothesis: "unroll" });
    const prompt = buildPrompt({ skill: "", spec: "", recent: [entry], iter: 4 });
    expect(prompt).toContain("iter 3");
    expect(prompt).toContain("discard");
    expect(prompt).toContain("42.5");
    expect(prompt).toContain("unroll");
  });

  test("renders null metric as 'crash' or similar marker rather than 'null'", () => {
    const entry = makeEntry({ iter: 2, verdict: "crash", metric: null, hypothesis: "broke build" });
    const prompt = buildPrompt({ skill: "", spec: "", recent: [entry], iter: 3 });
    expect(prompt).not.toContain("null");
    expect(prompt).toContain("crash");
  });

  test("summarizes long recent hypotheses without changing stored history", () => {
    const longHypothesis = `${"a".repeat(220)}tail`;
    const entry = makeEntry({ hypothesis: longHypothesis });
    const prompt = buildPrompt({ skill: "", spec: "", recent: [entry], iter: 2 });

    expect(summarizeHypothesis(longHypothesis)).toHaveLength(200);
    expect(prompt).toContain(`${"a".repeat(197)}...`);
    expect(prompt).not.toContain("tail");
  });

  test("instructs the agent to respond with HYPOTHESIS: line", () => {
    const prompt = buildPrompt({ skill: "", spec: "", recent: [], iter: 1 });
    expect(prompt).toContain("HYPOTHESIS:");
  });
});

describe("extractHypothesis", () => {
  test("preserves long one-line hypotheses for durable history", () => {
    const longHypothesis = `preserve ${"detail ".repeat(40)}because this explains the actual change`;

    expect(extractHypothesis(`HYPOTHESIS: ${longHypothesis}\n`)).toBe(longHypothesis);
  });
});

describe("extractAsi", () => {
  test("returns an empty array when no ASI line is present", () => {
    expect(extractAsi("HYPOTHESIS: did a thing")).toEqual([]);
  });

  test("parses a single ASI tag", () => {
    expect(extractAsi("HYPOTHESIS: x\nASI: #glob-tuning")).toEqual(["#glob-tuning"]);
  });

  test("parses multiple space-separated ASI tags", () => {
    expect(extractAsi("ASI: #bun-internals #parallelism #dead-end")).toEqual([
      "#bun-internals",
      "#parallelism",
      "#dead-end",
    ]);
  });

  test("tolerates tags without the '#' prefix by preserving them verbatim", () => {
    // Agents might forget the convention; don't swallow their input
    expect(extractAsi("ASI: parallel cache")).toEqual(["parallel", "cache"]);
  });

  test("ignores extra whitespace around the tag list", () => {
    expect(extractAsi("ASI:   #a   #b  \n")).toEqual(["#a", "#b"]);
  });
});

describe("renderTemplates", () => {
  const fullAnswers: WizardAnswers = {
    objective: "cut tests from 45s to <20s",
    benchmarkCommand: "bun test",
    direction: "minimize",
    unit: "s",
    checksCommand: "bun test --only correctness",
    filesInScope: "test/**/*.test.ts\nbunfig.toml",
    constraints: "must still pass `just check`",
  };

  test("md body contains the objective, metric fields, and user-provided sections", () => {
    const out = renderTemplates(fullAnswers);
    expect(out.md).toContain("cut tests from 45s to <20s");
    expect(out.md).toContain("unit: s");
    expect(out.md).toContain("direction: minimize");
    expect(out.md).toContain("test/**/*.test.ts");
    expect(out.md).toContain("must still pass");
  });

  test("md renders a 'not specified' marker for skipped files-in-scope and constraints", () => {
    const out = renderTemplates({
      ...fullAnswers,
      filesInScope: "",
      constraints: "",
    });
    expect(out.md).toContain("_(not specified)_");
  });

  test("md includes a Checks section only when a checks command is provided", () => {
    const withChecks = renderTemplates(fullAnswers);
    expect(withChecks.md).toContain("## Checks");
    expect(withChecks.md).toContain("./autoresearch.checks.sh");

    const withoutChecks = renderTemplates({ ...fullAnswers, checksCommand: "" });
    expect(withoutChecks.md).not.toContain("## Checks");
  });

  test("sh body contains the user's benchmark command", () => {
    const out = renderTemplates(fullAnswers);
    expect(out.sh).toContain("bun test");
    expect(out.sh).toContain("METRIC");
  });

  test("sh stderr guides the user toward edit + resume when the template is unfinished", () => {
    // The unedited template fails the baseline; its stderr flows verbatim into
    // the user-facing error from `measureBaseline`. Keep the hint actionable
    // (the walkthrough relies on this exact guidance) without a separate
    // diagnostic branch in the runner.
    const out = renderTemplates(fullAnswers);
    expect(out.sh).toContain("TODO");
    expect(out.sh).toContain("shaka autoresearch resume");
  });

  test("checks file is produced only when a checks command is provided", () => {
    expect(renderTemplates(fullAnswers).checks).not.toBeNull();
    expect(renderTemplates(fullAnswers).checks).toContain("bun test --only correctness");

    expect(renderTemplates({ ...fullAnswers, checksCommand: "" }).checks).toBeNull();
  });

  test("sh uses POSIX shebang and is safe to execute (no unescaped user input outside the command block)", () => {
    const out = renderTemplates({
      ...fullAnswers,
      benchmarkCommand: "bun test",
      objective: "a very 'tricky' \"objective\" with $quotes",
    });
    expect(out.sh.startsWith("#!/usr/bin/env sh")).toBe(true);
    // Objective lands in a comment; quotes are allowed there. No exploit path.
    expect(out.sh).toContain("tricky");
  });

  test("normalizes shell-comment fields without changing markdown objective", () => {
    const out = renderTemplates({
      ...fullAnswers,
      objective: "safe objective\nwhoami `touch nope` \\",
      unit: "ms",
    });

    expect(out.md).toContain("safe objective\nwhoami `touch nope` \\");
    expect(out.sh).toContain("# Benchmark for: safe objective whoami touch nope");
    expect(out.sh).not.toContain("# Benchmark for: safe objective\nwhoami");
  });

  test("rejects metric units that are not a single safe token", () => {
    expect(() =>
      renderTemplates({
        ...fullAnswers,
        unit: "ms\nwhoami",
      }),
    ).toThrow(/metric unit/i);
  });
});

describe("slugify", () => {
  test("lowercases and dashes a plain objective", () => {
    expect(slugify("Cut Bun Test")).toBe("cut-bun-test");
  });

  test("collapses punctuation and runs of whitespace", () => {
    expect(slugify("foo!!!   bar???")).toBe("foo-bar");
  });

  test("takes first 6 hyphen-separated words", () => {
    expect(slugify("one two three four five six seven eight")).toBe("one-two-three-four-five-six");
  });

  test("hard-caps at 50 characters", () => {
    const s = slugify("a".repeat(120));
    expect(s.length).toBeLessThanOrEqual(50);
  });

  test("falls back to an experiment-<ts> slug for empty input", () => {
    expect(slugify("!!!")).toMatch(/^experiment-\d{8}-\d{6}$/);
    expect(slugify("")).toMatch(/^experiment-\d{8}-\d{6}$/);
  });

  test("trims leading and trailing dashes", () => {
    expect(slugify("  ---foo bar---  ")).toBe("foo-bar");
  });
});

describe("setupWorkspace", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function makeSourceRepo(): Promise<string> {
    const parent = join(
      tmpdir(),
      `shaka-ar-src-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const repo = join(parent, "myproject");
    await mkdir(repo, { recursive: true });
    createdDirs.push(parent);

    await run(["git", "init", "-q", "-b", "main"], repo);
    await run(["git", "config", "user.email", "test@shaka"], repo);
    await run(["git", "config", "user.name", "Test"], repo);
    await Bun.write(join(repo, ".gitkeep"), "");
    await run(["git", "add", "-A"], repo);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
    return repo;
  }

  test("happy path: creates worktree, branch, auto-gen templates, setup commit", async () => {
    const repo = await makeSourceRepo();

    const result = await setupWorkspace({ repoRoot: repo, objective: "speed up tests" });

    expect(result.slug).toBe("speed-up-tests");
    expect(result.branch).toBe("autoresearch/speed-up-tests");
    expect(result.worktreePath.endsWith("myproject.ar-speed-up-tests")).toBe(true);

    // Templates exist in the worktree
    expect(await Bun.file(join(result.worktreePath, "autoresearch.md")).exists()).toBe(true);
    expect(await Bun.file(join(result.worktreePath, "autoresearch.sh")).exists()).toBe(true);

    // The worktree is on the experiment branch
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: result.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(branchProc.stdout).text()).trim()).toBe(result.branch);

    // HEAD has a setup commit
    const headMsg = Bun.spawn(["git", "log", "-1", "--format=%s"], {
      cwd: result.worktreePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(headMsg.stdout).text()).trim()).toContain("autoresearch");
  });

  test("aborts when the source repo has tracked modifications", async () => {
    const repo = await makeSourceRepo();
    // Modify the tracked file
    await Bun.write(join(repo, ".gitkeep"), "modified");

    await expect(setupWorkspace({ repoRoot: repo, objective: "whatever" })).rejects.toThrow(
      /uncommitted changes/i,
    );
  });

  test("tolerates untracked files in the source repo", async () => {
    const repo = await makeSourceRepo();
    await Bun.write(join(repo, "scratch.txt"), "untracked fine");

    const result = await setupWorkspace({ repoRoot: repo, objective: "ok" });
    expect(await Bun.file(join(result.worktreePath, "autoresearch.md")).exists()).toBe(true);
  });

  test("rejects a collision when the branch already exists", async () => {
    const repo = await makeSourceRepo();
    await setupWorkspace({ repoRoot: repo, objective: "dupe" });

    await expect(setupWorkspace({ repoRoot: repo, objective: "dupe" })).rejects.toThrow(
      /already exists/i,
    );
  });

  test("validates rendered templates before creating a worktree", async () => {
    const repo = await makeSourceRepo();
    const answers: WizardAnswers = {
      objective: "invalid unit",
      benchmarkCommand: "bun test",
      direction: "minimize",
      unit: "ms\nwhoami",
      checksCommand: "",
      filesInScope: "",
      constraints: "",
    };

    await expect(
      setupWorkspace({ repoRoot: repo, objective: answers.objective, answers }),
    ).rejects.toThrow(/metric unit/i);

    expect(await gitOutput(["worktree", "list", "--porcelain"], repo)).not.toContain(
      "autoresearch/invalid-unit",
    );
    expect(await gitOutput(["branch", "--list", "autoresearch/invalid-unit"], repo)).toBe("");
  });
});

describe("runResume (in-worktree)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function makeSourceRepo(): Promise<string> {
    const parent = join(
      tmpdir(),
      `shaka-ar-resume-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const repo = join(parent, "project");
    await mkdir(repo, { recursive: true });
    createdDirs.push(parent);
    await run(["git", "init", "-q", "-b", "main"], repo);
    await run(["git", "config", "user.email", "t@t"], repo);
    await run(["git", "config", "user.name", "t"], repo);
    await Bun.write(join(repo, ".gitkeep"), "");
    await run(["git", "add", "-A"], repo);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
    return repo;
  }

  test("continues from a worktree with prior jsonl state", async () => {
    const repo = await makeSourceRepo();
    const setup = await setupWorkspace({ repoRoot: repo, objective: "continue me" });

    // Replace template md with a parseable spec
    await Bun.write(
      join(setup.worktreePath, "autoresearch.md"),
      "# Autoresearch\n\n## Metric\n- direction: minimize\n",
    );
    await run(["git", "add", "-A"], setup.worktreePath);
    await run(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "spec"],
      setup.worktreePath,
    );

    // Seed a prior keep entry
    const seedEntry = {
      iter: 5,
      ts: "2026-04-18T00:00:00.000Z",
      provider: "claude",
      hypothesis: "prior run",
      metric: 20,
      verdict: "keep",
      commit: "abc1234",
      asi: [],
      duration_ms: 100,
    };
    await Bun.write(join(setup.worktreePath, "autoresearch.jsonl"), `${JSON.stringify(seedEntry)}\n`);

    const editingAgent = async (
      _opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      await Bun.write(join(setup.worktreePath, "patch.txt"), "after resume");
      return {
        exitCode: 0,
        stdout: "HYPOTHESIS: after resume",
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };
    const benchmark = scriptedBenchmark([{ value: 15 }]); // beats prior best of 20

    await runResume(
      { cwd: setup.worktreePath, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 6 },
      { agent: editingAgent, benchmark },
    );

    const entries = (await Bun.file(join(setup.worktreePath, "autoresearch.jsonl")).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries).toHaveLength(2);
    expect(entries[1].iter).toBe(6);
    expect(entries[1].verdict).toBe("keep");
  });

  test("rejects cwd that isn't an autoresearch worktree", async () => {
    const repo = await makeSourceRepo();
    // Source repo is not an experiment worktree — branch is not autoresearch/*
    await expect(
      runResume({ cwd: repo, providers: NO_PROVIDERS }, {}),
    ).rejects.toThrow(/not inside an autoresearch worktree/i);
  });

  test("rejects a worktree missing autoresearch.md", async () => {
    const repo = await makeSourceRepo();
    const setup = await setupWorkspace({ repoRoot: repo, objective: "missing md" });
    // Remove autoresearch.md — simulates a broken setup
    await rm(join(setup.worktreePath, "autoresearch.md"), { force: true });
    await run(["git", "add", "-A"], setup.worktreePath);
    await run(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "remove md"],
      setup.worktreePath,
    );

    await expect(
      runResume({ cwd: setup.worktreePath, providers: NO_PROVIDERS }, {}),
    ).rejects.toThrow(/autoresearch\.md/i);
  });

  test("rejects a worktree where autoresearch.md is untracked (only on disk, not at HEAD)", async () => {
    // Regression: runResume's docstring requires the spec to be TRACKED at HEAD
    // — an untracked file on disk must not count as a valid experiment.
    const repo = await makeSourceRepo();
    const setup = await setupWorkspace({ repoRoot: repo, objective: "untracked md" });
    // Remove the file from HEAD, then drop it back on disk as untracked
    await rm(join(setup.worktreePath, "autoresearch.md"), { force: true });
    await run(["git", "add", "-A"], setup.worktreePath);
    await run(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "remove md"],
      setup.worktreePath,
    );
    await Bun.write(
      join(setup.worktreePath, "autoresearch.md"),
      "# Pretending to be a spec\n\n## Metric\n- direction: minimize\n",
    );

    await expect(
      runResume({ cwd: setup.worktreePath, providers: NO_PROVIDERS }, {}),
    ).rejects.toThrow(/autoresearch\.md/i);
  });

  test("rejects a main checkout masquerading as an autoresearch branch", async () => {
    const repo = await makeSourceRepo();
    await run(["git", "checkout", "-b", "autoresearch/fake"], repo);
    await Bun.write(join(repo, "autoresearch.md"), "# Autoresearch\n\n## Metric\n- direction: minimize\n");
    await run(["git", "add", "-A"], repo);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "fake spec"], repo);

    await expect(runResume({ cwd: repo, providers: NO_PROVIDERS }, {})).rejects.toThrow(
      /linked worktree|autoresearch worktree/i,
    );
  });

  test("rejects a submodule checkout masquerading as an autoresearch worktree", async () => {
    const repo = await makeSourceRepo();
    const subSource = join(repo, "..", "sub-source");
    await mkdir(subSource, { recursive: true });
    await run(["git", "init", "-q", "-b", "main"], subSource);
    await run(["git", "config", "user.email", "t@t"], subSource);
    await run(["git", "config", "user.name", "t"], subSource);
    await Bun.write(join(subSource, ".gitkeep"), "");
    await run(["git", "add", "-A"], subSource);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], subSource);

    await run(
      ["git", "-c", "protocol.file.allow=always", "submodule", "add", "../sub-source", "sub"],
      repo,
    );
    const submodule = join(repo, "sub");
    await run(["git", "config", "user.email", "t@t"], submodule);
    await run(["git", "config", "user.name", "t"], submodule);
    await run(["git", "checkout", "-b", "autoresearch/fake"], submodule);
    await Bun.write(
      join(submodule, "autoresearch.md"),
      "# Submodule decoy\n\n## Metric\n- direction: minimize\n",
    );
    await Bun.write(
      join(submodule, "autoresearch.sh"),
      "#!/bin/sh\necho 'METRIC name=t value=1 unit=ms'\n",
    );
    await run(["git", "add", "-A"], submodule);
    await run(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "decoy"],
      submodule,
    );

    await expect(
      runResume(
        { cwd: submodule, providers: NO_PROVIDERS, stopWhen: (s) => s.iter >= 0 },
        { benchmark: scriptedBenchmark([{ value: 1 }]) },
      ),
    ).rejects.toThrow(/linked worktree|autoresearch worktree/i);
  });
});

describe("experiment worktree discovery", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function makeSourceRepo(): Promise<string> {
    const parent = join(
      tmpdir(),
      `shaka-ar-disc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const repo = join(parent, "project");
    await mkdir(repo, { recursive: true });
    createdDirs.push(parent);
    await run(["git", "init", "-q", "-b", "main"], repo);
    await run(["git", "config", "user.email", "t@t"], repo);
    await run(["git", "config", "user.name", "t"], repo);
    await Bun.write(join(repo, ".gitkeep"), "");
    await run(["git", "add", "-A"], repo);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
    return repo;
  }

  test("findExperimentWorktree enumerates autoresearch/* worktrees only", async () => {
    const repo = await makeSourceRepo();
    await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    await setupWorkspace({ repoRoot: repo, objective: "beta" });

    const experiments = await findExperimentWorktree(repo);
    expect(experiments.map((e) => e.slug).sort()).toEqual(["alpha", "beta"]);
    // Main worktree is not included
    expect(experiments.every((e) => e.slug !== "main")).toBe(true);
  });

  test("resolveExperimentWorktree finds a worktree by slug", async () => {
    const repo = await makeSourceRepo();
    const alpha = await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    await setupWorkspace({ repoRoot: repo, objective: "beta" });

    const resolved = await resolveExperimentWorktree(repo, "alpha");
    const realAlpha = await realpath(alpha.worktreePath);
    // path.resolve normalizes separators on both sides (forward slashes from
    // `git worktree list --porcelain`, OS-native from realpath).
    expect(resolve(resolved.worktreePath)).toBe(resolve(realAlpha));
  });

  test("resolveExperimentWorktree with no slug picks the unique experiment", async () => {
    const repo = await makeSourceRepo();
    const only = await setupWorkspace({ repoRoot: repo, objective: "solo" });

    const resolved = await resolveExperimentWorktree(repo, undefined);
    const realOnly = await realpath(only.worktreePath);
    expect(resolve(resolved.worktreePath)).toBe(resolve(realOnly));
  });

  test("resolveExperimentWorktree errors clearly when slug is ambiguous", async () => {
    const repo = await makeSourceRepo();
    await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    await setupWorkspace({ repoRoot: repo, objective: "beta" });

    await expect(resolveExperimentWorktree(repo, undefined)).rejects.toThrow(
      /multiple autoresearch experiments/i,
    );
  });

  test("resolveExperimentWorktree errors when slug doesn't exist", async () => {
    const repo = await makeSourceRepo();
    await setupWorkspace({ repoRoot: repo, objective: "alpha" });

    await expect(resolveExperimentWorktree(repo, "nope")).rejects.toThrow(/no autoresearch/i);
  });

  test("resolveResumeTarget returns the worktree path when cwd is inside it", async () => {
    const repo = await makeSourceRepo();
    const alpha = await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    await setupWorkspace({ repoRoot: repo, objective: "beta" });

    // Inside the alpha worktree — even with no slug specified, we should get alpha.
    const target = await resolveResumeTarget(alpha.worktreePath, repo, undefined);
    const realAlpha = await realpath(alpha.worktreePath);
    expect(resolve(target)).toBe(resolve(realAlpha));
  });

  test("resolveResumeTarget resolves from a nested cwd inside the worktree", async () => {
    const repo = await makeSourceRepo();
    const alpha = await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    await setupWorkspace({ repoRoot: repo, objective: "beta" });

    const nested = join(alpha.worktreePath, "src", "deep");
    await mkdir(nested, { recursive: true });

    const target = await resolveResumeTarget(nested, repo, undefined);
    const realAlpha = await realpath(alpha.worktreePath);
    expect(resolve(target)).toBe(resolve(realAlpha));
  });

  test("resolveResumeTarget honors an explicit slug over the current worktree", async () => {
    const repo = await makeSourceRepo();
    const alpha = await setupWorkspace({ repoRoot: repo, objective: "alpha" });
    const beta = await setupWorkspace({ repoRoot: repo, objective: "beta" });

    const target = await resolveResumeTarget(alpha.worktreePath, repo, "beta");
    const realBeta = await realpath(beta.worktreePath);
    expect(resolve(target)).toBe(resolve(realBeta));
  });


  test("resolveResumeTarget rejects a main repo on an autoresearch/* branch with no matching experiment", async () => {
    // Regression: the command-layer short-circuit used to trust the branch
    // name "autoresearch/foo" as proof of being in an experiment worktree.
    // A main repo that merely happens to be on that branch must not resume.
    const repo = await makeSourceRepo();
    // Create the masquerading branch in the main repo — no worktree created
    await run(["git", "checkout", "-b", "autoresearch/fake"], repo);
    await Bun.write(
      join(repo, "autoresearch.md"),
      "# Decoy\n\n## Metric\n- direction: minimize\n",
    );
    await run(["git", "add", "-A"], repo);
    await run(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "decoy"],
      repo,
    );

    await expect(resolveResumeTarget(repo, repo, undefined)).rejects.toThrow(
      /no active autoresearch/i,
    );
  });
});

// Skipped on Windows: runBenchmark spawns `./autoresearch.sh` directly (shebang
// script by path), which is a Unix-only execution model. Mirrors the existing
// autoresearch.checks.sh test's platform gate.
describe.skipIf(process.platform === "win32")("runBenchmark", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function makeBenchDir(script: string): Promise<string> {
    const dir = join(
      tmpdir(),
      `shaka-bench-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    const path = join(dir, "autoresearch.sh");
    await Bun.write(path, script);
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o755);
    return dir;
  }

  test("returns parsed measurement from a successful METRIC-emitting script", async () => {
    const dir = await makeBenchDir(
      "#!/bin/sh\necho 'some debug line'\necho 'METRIC name=runtime value=42.5 unit=ms'\n",
    );

    const result = await runBenchmark(dir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("METRIC name=runtime value=42.5 unit=ms");
    expect(result.stderr).toBe("");
    expect(result.measurement).toEqual({ name: "runtime", value: 42.5, unit: "ms" });
  });

  test("returns null measurement when the script exits non-zero (even if METRIC appears on stdout)", async () => {
    const dir = await makeBenchDir(
      "#!/bin/sh\necho 'METRIC name=runtime value=42 unit=ms'\necho 'boom' >&2\nexit 3\n",
    );

    const result = await runBenchmark(dir);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
    expect(result.measurement).toBeNull();
  });
});

describe("assertOnlySetupDirty", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function makeRepo(): Promise<string> {
    const dir = join(
      tmpdir(),
      `shaka-assert-dirty-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    await run(["git", "init", "-q", "-b", "main"], dir);
    await run(["git", "config", "user.email", "t@t"], dir);
    await run(["git", "config", "user.name", "t"], dir);
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\nexit 1\n");
    await run(["git", "add", "-A"], dir);
    await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], dir);
    return dir;
  }

  test("resolves silently on a clean worktree", async () => {
    const dir = await makeRepo();
    await expect(assertOnlySetupDirty(dir)).resolves.toBeUndefined();
  });

  test("resolves silently when only setup artifacts are dirty", async () => {
    const dir = await makeRepo();
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\necho METRIC name=t value=1 unit=ms\n");
    await Bun.write(
      join(dir, "autoresearch.md"),
      "# spec\n\n## Metric\n- direction: minimize\n",
    );
    await Bun.write(join(dir, "autoresearch.checks.sh"), "#!/bin/sh\nexit 0\n");

    await expect(assertOnlySetupDirty(dir)).resolves.toBeUndefined();
  });

  test("throws naming the unrelated path when a non-setup file is dirty", async () => {
    const dir = await makeRepo();
    await Bun.write(join(dir, "unrelated.ts"), "export const x = 1;\n");

    await expect(assertOnlySetupDirty(dir)).rejects.toThrow(/unrelated\.ts/);
  });

  test("throws when unrelated paths coexist with legitimate setup edits", async () => {
    const dir = await makeRepo();
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\necho METRIC name=t value=1 unit=ms\n");
    await Bun.write(join(dir, "rogue.js"), "// rogue\n");

    await expect(assertOnlySetupDirty(dir)).rejects.toThrow(/rogue\.js/);
  });
});
