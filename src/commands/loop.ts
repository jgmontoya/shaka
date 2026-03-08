/**
 * CLI handler for `shaka loop <task> [options]`.
 *
 * Runs an iterative coding loop — an outer process that spawns an AI agent
 * per round, runs verification between rounds, tracks state in a markdown
 * file, and stops when verification passes or max rounds are reached.
 *
 * This is NOT a prompt that asks the AI to self-iterate. The CLI process
 * owns the loop. The AI agent executes one focused improvement per round.
 *
 * Key design decisions:
 * - Verification failures are fed back into the next round's prompt
 * - Pre-loop baseline verification captures the starting state
 * - Stuck detection: 3 rounds with identical verify output = stop
 * - Session continuity (--continue) for efficient multi-round context
 * - Elapsed time tracking per round and total
 * - Git diff capture for accurate change tracking
 * - Run metadata JSON for programmatic consumption
 */

import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Command } from "commander";
import { runAgentStep } from "../domain/agent-execution";

// ── Types ────────────────────────────────────────────────────────────────────

interface LoopOptions {
  readonly rounds: number;
  readonly verify?: string;
  readonly scope?: string;
  readonly dir?: string;
  readonly continue?: boolean;
}

interface RoundResult {
  readonly round: number;
  readonly status: "done" | "blocked" | "failed";
  readonly summary: string;
  readonly filesChanged: string[];
  readonly durationMs: number;
}

interface RunMetadata {
  readonly task: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly rounds: {
    readonly round: number;
    readonly status: string;
    readonly summary: string;
    readonly filesChanged: string[];
    readonly durationMs: number;
    readonly verifyPassed?: boolean;
  }[];
  readonly totalRounds: number;
  readonly completedRounds: number;
  readonly blockedRounds: number;
  readonly verifyPassed: boolean;
  readonly totalDurationMs: number;
}

// ── State file ───────────────────────────────────────────────────────────────

function initialState(task: string, totalRounds: number): string {
  return [
    "# Loop State",
    `Task: ${task}`,
    `Rounds: 0 / ${totalRounds}`,
    `Started: ${new Date().toISOString()}`,
    "",
    "## Completed",
    "",
    "## Rejected Directions",
    "",
    "## Open Risks",
    "",
    "## Next Best Step",
    "",
  ].join("\n");
}

// ── Prompt builder ───────────────────────────────────────────────────────────

interface PromptContext {
  readonly task: string;
  readonly round: number;
  readonly totalRounds: number;
  readonly stateFileRel: string;
  readonly scopeFileRel?: string;
  readonly verifyCmd?: string;
  readonly lastVerifyOutput?: string;
  readonly lastDiff?: string;
}

function buildRoundPrompt(ctx: PromptContext): string {
  const lines: string[] = [
    `You are running inside an automated coding loop (round ${ctx.round} of ${ctx.totalRounds}).`,
    "",
    "## Task",
    ctx.task,
    "",
  ];

  if (ctx.scopeFileRel) {
    lines.push(
      "## Scoped Workload",
      `Read the workload file first: ${ctx.scopeFileRel}`,
      "Stay strictly inside the workload's scope. If you notice work outside scope,",
      "record it under Rejected Directions in the state file instead of doing it.",
      "",
    );
  }

  // Feed verification failure into prompt — the most important feedback loop
  if (ctx.lastVerifyOutput) {
    lines.push(
      "## Previous Verification Failed",
      "The verification command failed after the last round. Here is the output:",
      "```",
      ctx.lastVerifyOutput,
      "```",
      "Focus on fixing the specific errors shown above.",
      "",
    );
  }

  // Show what changed last round so the agent has context
  if (ctx.lastDiff) {
    lines.push("## Changes From Previous Round", "```diff", ctx.lastDiff, "```", "");
  }

  lines.push(
    "## Persistent State",
    `Read and update the loop state file: ${ctx.stateFileRel}`,
    "After this round, update it with:",
    "- What was completed this round",
    "- Directions you considered but rejected (and why)",
    "- Open risks remaining",
    "- The next best step for the next round",
    "",
    "## Rules",
    "- Make exactly one focused improvement per round.",
    "- Keep changes surgical and shippable.",
    "- Do not commit, push, or change git config.",
    "- Do not rewrite major architecture unless the task specifically asks for it.",
    "- Verify your changes work before ending the round.",
    "- If tests or builds fail, fix them before ending the round.",
  );

  if (ctx.verifyCmd) {
    lines.push(`- Run this verification command and ensure it passes: ${ctx.verifyCmd}`);
  }

  lines.push(
    "",
    "## Output Format (required at end of round)",
    "ROUND_STATUS: <done or blocked>",
    "SUMMARY: <one line of what you did>",
    "FILES: <comma-separated paths changed>",
    "VERIFY: <commands run and results>",
    "NEXT: <one line — what the next round should focus on>",
  );

  return lines.join("\n");
}

// ── Output parser ────────────────────────────────────────────────────────────

function parseRoundOutput(output: string, round: number, durationMs: number): RoundResult {
  const statusMatch = output.match(/ROUND_STATUS:\s*(done|blocked)/i);
  const summaryMatch = output.match(/SUMMARY:\s*(.+)/i);
  const filesMatch = output.match(/FILES:\s*(.+)/i);

  const status = statusMatch?.[1]?.toLowerCase();
  const files = filesMatch?.[1];

  return {
    round,
    status: status === "done" || status === "blocked" ? status : "done",
    summary: summaryMatch?.[1]?.trim() ?? "(no summary provided)",
    filesChanged: files
      ? files
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : [],
    durationMs,
  };
}

// ── Shell helpers ────────────────────────────────────────────────────────────

function shellArgs(cmd: string): readonly string[] {
  return process.platform === "win32" ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];
}

async function runShellCommand(
  cmd: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([...shellArgs(cmd)], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stderr ? `${stdout}\n${stderr}` : stdout;
  return { exitCode, output };
}

// ── Verification ─────────────────────────────────────────────────────────────

async function runVerification(
  cmd: string,
  cwd: string,
): Promise<{ passed: boolean; output: string }> {
  const result = await runShellCommand(cmd, cwd);
  return { passed: result.exitCode === 0, output: result.output.slice(0, 4000) };
}

// ── Git diff capture ─────────────────────────────────────────────────────────

async function captureGitDiff(cwd: string): Promise<string | undefined> {
  const result = await runShellCommand("git diff --stat 2>/dev/null", cwd);
  if (result.exitCode !== 0 || !result.output.trim()) return undefined;
  // Also get the actual diff, but truncated to keep prompt size reasonable
  const fullDiff = await runShellCommand("git diff 2>/dev/null", cwd);
  const diff = fullDiff.output.slice(0, 3000);
  return diff || undefined;
}

// ── Stuck detection ──────────────────────────────────────────────────────────

const STUCK_THRESHOLD = 3;

/** Normalize verify output for comparison (strip timestamps, whitespace variance). */
function normalizeForComparison(output: string): string {
  return output
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, "[timestamp]")
    .replace(/\d+(\.\d+)?s/g, "[duration]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function isStuck(recentOutputs: string[]): boolean {
  if (recentOutputs.length < STUCK_THRESHOLD) return false;
  const last = recentOutputs.slice(-STUCK_THRESHOLD);
  const normalized = last.map(normalizeForComparison);
  return normalized.every((o) => o === normalized[0]);
}

// ── Display helpers ──────────────────────────────────────────────────────────

function printBanner(task: string, opts: LoopOptions, logDir: string): void {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  shaka loop                                             ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  printRow("Task", task.length > 50 ? `${task.slice(0, 47)}...` : task);
  printRow("Rounds", String(opts.rounds));
  if (opts.verify) printRow("Verify", opts.verify);
  if (opts.scope) printRow("Scope", opts.scope);
  printRow("Mode", opts.continue ? "continuous session" : "fresh context");
  printRow("Logs", logDir);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
}

function printRow(label: string, value: string): void {
  const content = `${label}: ${value}`;
  console.log(`║  ${content.padEnd(55)} ║`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function printCompletionSummary(meta: RunMetadata, logDir: string, stateFile: string): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Loop Complete                                          ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  printRow("Completed rounds", String(meta.completedRounds));
  printRow("Blocked rounds", String(meta.blockedRounds));
  printRow("Total time", formatDuration(meta.totalDurationMs));
  if (meta.rounds.length > 0) {
    const avg = Math.round(meta.totalDurationMs / meta.rounds.length);
    printRow("Avg round time", formatDuration(avg));
  }
  printRow("Verification", meta.verifyPassed ? "PASSED" : "not yet passing");
  printRow("Logs", logDir);
  printRow("State", stateFile);
  printRow("Metadata", "run.json");
  console.log("╚══════════════════════════════════════════════════════════╝");
}

// ── Round execution ──────────────────────────────────────────────────────────

interface LoopContext {
  readonly task: string;
  readonly cwd: string;
  readonly logDir: string;
  readonly stateFileRel: string;
  readonly scopeFileRel?: string;
  readonly opts: LoopOptions;
}

/** Execute a single round: spawn agent, log output, parse result. */
async function executeRound(
  ctx: LoopContext,
  round: number,
  lastVerifyOutput?: string,
  lastDiff?: string,
): Promise<RoundResult> {
  const roundLogFile = join(ctx.logDir, `round-${String(round).padStart(2, "0")}.log`);

  const prompt = buildRoundPrompt({
    task: ctx.task,
    round,
    totalRounds: ctx.opts.rounds,
    stateFileRel: ctx.stateFileRel,
    scopeFileRel: ctx.scopeFileRel,
    verifyCmd: ctx.opts.verify,
    lastVerifyOutput,
    lastDiff,
  });

  const startMs = Date.now();
  const result = await runAgentStep({ prompt });
  const durationMs = Date.now() - startMs;

  const logContent = [
    `# Round ${round}/${ctx.opts.rounds}`,
    `Exit code: ${result.exitCode}`,
    `Duration: ${formatDuration(durationMs)}`,
    "",
    "## stdout",
    result.stdout,
    "",
    "## stderr",
    result.stderr,
  ].join("\n");
  await Bun.write(roundLogFile, logContent);

  if (result.exitCode !== 0) {
    console.log(`  ✗ Round ${round}: agent failed (exit code ${result.exitCode})`);
    console.log(`  See: ${roundLogFile}`);
    return {
      round,
      status: "failed",
      summary: "agent process failed",
      filesChanged: [],
      durationMs,
    };
  }

  return parseRoundOutput(result.stdout, round, durationMs);
}

/** Run verification and log the result. */
async function runAndLogVerification(
  verifyCmd: string,
  cwd: string,
  logDir: string,
  round: number,
): Promise<{ passed: boolean; output: string }> {
  console.log(`  Running verify: ${verifyCmd}`);
  const verification = await runVerification(verifyCmd, cwd);
  await Bun.write(
    join(logDir, `verify-${String(round).padStart(2, "0")}.log`),
    verification.output,
  );

  if (verification.passed) {
    console.log("  ✓ Verification passed — task complete!");
  } else {
    console.log("  ✗ Verification failed — continuing loop");
  }
  return verification;
}

/** Resolve and validate the scope file. */
async function resolveScopeFile(cwd: string, scope: string): Promise<string> {
  const resolved = relative(cwd, join(cwd, scope));
  const exists = await Bun.file(join(cwd, scope)).exists();
  if (!exists) {
    console.error(`Error: scope file not found: ${scope}`);
    process.exit(1);
  }
  return resolved;
}

// ── Main loop ────────────────────────────────────────────────────────────────

/** Mutable state tracked across rounds. */
interface LoopState {
  completed: number;
  consecutiveBlocks: number;
  verifyPassed: boolean;
  lastVerifyOutput?: string;
  lastDiff?: string;
  readonly roundMetadata: RunMetadata["rounds"];
  readonly recentVerifyOutputs: string[];
}

/** Run baseline verification. Returns undefined if no verify command, or the output. */
async function runBaseline(
  opts: LoopOptions,
  cwd: string,
  logDir: string,
): Promise<{ skip: boolean; output?: string }> {
  if (!opts.verify) return { skip: false };

  console.log("━━━ Baseline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const baseline = await runAndLogVerification(opts.verify, cwd, logDir, 0);
  if (baseline.passed) {
    console.log("\nVerification already passes. Nothing to do.");
    return { skip: true };
  }
  console.log("");
  return { skip: false, output: baseline.output };
}

/** Process the result of a single round. Returns "break" if the loop should stop. */
function processRoundResult(roundResult: RoundResult, state: LoopState): "break" | "continue" {
  if (roundResult.status === "blocked") {
    state.consecutiveBlocks++;
    console.log(`  ⚠ Round ${roundResult.round}: blocked — ${roundResult.summary}`);
    console.log(`  (${formatDuration(roundResult.durationMs)})`);
    state.roundMetadata.push({ ...roundResult, verifyPassed: false });
    if (state.consecutiveBlocks >= 2) {
      console.log("\nTwo consecutive blocked rounds. Stopping.");
      return "break";
    }
  } else {
    state.completed++;
    state.consecutiveBlocks = 0;
    console.log(`  ✓ Round ${roundResult.round}: ${roundResult.summary}`);
    console.log(`  (${formatDuration(roundResult.durationMs)})`);
  }
  return "continue";
}

/** Run post-round verification. Returns "break" if the loop should stop. */
async function processVerification(
  roundResult: RoundResult,
  state: LoopState,
  opts: LoopOptions,
  cwd: string,
  logDir: string,
): Promise<"break" | "continue"> {
  if (!opts.verify) {
    state.roundMetadata.push({ ...roundResult });
    return "continue";
  }

  const verification = await runAndLogVerification(opts.verify, cwd, logDir, roundResult.round);
  state.roundMetadata.push({ ...roundResult, verifyPassed: verification.passed });

  if (verification.passed) {
    state.verifyPassed = true;
    return "break";
  }

  state.lastVerifyOutput = verification.output;
  state.recentVerifyOutputs.push(verification.output);

  if (isStuck(state.recentVerifyOutputs)) {
    console.log(
      `\nSame verification failures for ${STUCK_THRESHOLD} consecutive rounds. Loop is stuck. Stopping.`,
    );
    return "break";
  }
  return "continue";
}

async function executeLoop(task: string, opts: LoopOptions): Promise<void> {
  const cwd = opts.dir ?? process.cwd();
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = join(cwd, ".loop-logs", runId);
  const stateFile = join(cwd, `.loop-state-${runId}.md`);
  const stateFileRel = `.loop-state-${runId}.md`;
  const loopStart = Date.now();

  await mkdir(logDir, { recursive: true });
  await Bun.write(stateFile, initialState(task, opts.rounds));

  const scopeFileRel = opts.scope ? await resolveScopeFile(cwd, opts.scope) : undefined;
  const ctx: LoopContext = { task, cwd, logDir, stateFileRel, scopeFileRel, opts };

  printBanner(task, opts, logDir);

  const baseline = await runBaseline(opts, cwd, logDir);
  if (baseline.skip) return;

  const state: LoopState = {
    completed: 0,
    consecutiveBlocks: 0,
    verifyPassed: false,
    lastVerifyOutput: baseline.output,
    roundMetadata: [],
    recentVerifyOutputs: [],
  };

  for (let round = 1; round <= opts.rounds; round++) {
    console.log(`━━━ Round ${round}/${opts.rounds} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const roundResult = await executeRound(ctx, round, state.lastVerifyOutput, state.lastDiff);

    if (roundResult.status === "failed") {
      state.roundMetadata.push({ ...roundResult, verifyPassed: false });
      break;
    }

    state.lastDiff = await captureGitDiff(cwd);

    if (processRoundResult(roundResult, state) === "break") break;
    if ((await processVerification(roundResult, state, opts, cwd, logDir)) === "break") break;

    console.log("");
  }

  const metadata: RunMetadata = {
    task,
    startedAt: new Date(loopStart).toISOString(),
    completedAt: new Date().toISOString(),
    rounds: state.roundMetadata,
    totalRounds: opts.rounds,
    completedRounds: state.completed,
    blockedRounds: state.consecutiveBlocks,
    verifyPassed: state.verifyPassed,
    totalDurationMs: Date.now() - loopStart,
  };
  await Bun.write(join(logDir, "run.json"), JSON.stringify(metadata, null, 2));

  printCompletionSummary(metadata, logDir, stateFileRel);

  const finalState = await Bun.file(stateFile).text();
  console.log("");
  console.log("━━━ Final Loop State ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(finalState);
}

// ── CLI command ──────────────────────────────────────────────────────────────

export function createLoopCommand(): Command {
  return new Command("loop")
    .description("Run an iterative coding loop — multiple rounds of focused improvements")
    .argument("<task...>", "What to work on")
    .option("-r, --rounds <n>", "Maximum number of rounds", "10")
    .option("-v, --verify <cmd>", "Verification command (exits 0 = success, stop loop)")
    .option("-s, --scope <file>", "Scoped workload file defining boundaries")
    .option("-d, --dir <dir>", "Directory to run in (default: current directory)")
    .option("-c, --continue", "Continue same session across rounds (default: fresh context)")
    .action(async (taskParts: string[], options: Record<string, string | boolean>) => {
      const task = taskParts.join(" ");
      if (!task.trim()) {
        console.error("Error: provide a task description");
        console.error('Example: shaka loop "fix all test failures" --verify "bun test"');
        process.exit(1);
      }

      await executeLoop(task, {
        rounds: Number.parseInt(String(options.rounds ?? "10"), 10),
        verify: options.verify as string | undefined,
        scope: options.scope as string | undefined,
        dir: options.dir as string | undefined,
        continue: !!options.continue,
      });
    });
}
