/**
 * CLI handler for `shaka loop <task> [options]`.
 *
 * Runs an iterative coding loop — an outer process that spawns an AI agent
 * per round, runs verification between rounds, tracks state in a markdown
 * file, and stops when verification passes or max rounds are reached.
 *
 * This is NOT a prompt that asks the AI to self-iterate. The CLI process
 * owns the loop. The AI agent executes one focused improvement per round.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { runAgentStep } from "../domain/agent-execution";

// ── Types ────────────────────────────────────────────────────────────────────

interface LoopOptions {
  readonly rounds: number;
  readonly verify?: string;
  readonly scope?: string;
  readonly dir?: string;
}

interface RoundResult {
  readonly round: number;
  readonly status: "done" | "blocked" | "failed";
  readonly summary: string;
  readonly filesChanged: string[];
  readonly verifyOutput?: string;
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

function buildRoundPrompt(
  task: string,
  round: number,
  totalRounds: number,
  stateFileRel: string,
  scopeFileRel?: string,
  verifyCmd?: string,
): string {
  const lines: string[] = [
    `You are running inside an automated coding loop (round ${round} of ${totalRounds}).`,
    "",
    "## Task",
    task,
    "",
  ];

  if (scopeFileRel) {
    lines.push(
      "## Scoped Workload",
      `Read the workload file first: ${scopeFileRel}`,
      "Stay strictly inside the workload's scope. If you notice work outside scope,",
      "record it under Rejected Directions in the state file instead of doing it.",
      "",
    );
  }

  lines.push(
    "## Persistent State",
    `Read and update the loop state file: ${stateFileRel}`,
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

  if (verifyCmd) {
    lines.push(`- Run this verification command and ensure it passes: ${verifyCmd}`);
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

function parseRoundOutput(output: string, round: number): RoundResult {
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
  };
}

// ── Verification runner ──────────────────────────────────────────────────────

async function runVerification(
  cmd: string,
  cwd: string,
): Promise<{ passed: boolean; output: string }> {
  const shell =
    process.platform === "win32" ? (["cmd", "/c", cmd] as const) : (["sh", "-c", cmd] as const);

  const proc = Bun.spawn([...shell], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = stderr ? `${stdout}\n${stderr}` : stdout;
  return { passed: exitCode === 0, output: output.slice(0, 2000) };
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
  printRow("Logs", logDir);
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
}

function printRow(label: string, value: string): void {
  const content = `${label}: ${value}`;
  console.log(`║  ${content.padEnd(55)} ║`);
}

function printSummary(
  completed: number,
  blocked: number,
  verifyPassed: boolean,
  hasVerify: boolean,
  logDir: string,
  stateFile: string,
): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Loop Complete                                          ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  printRow("Completed rounds", String(completed));
  printRow("Blocked rounds", String(blocked));
  if (hasVerify) {
    printRow("Verification", verifyPassed ? "PASSED" : "not yet passing");
  }
  printRow("Logs", logDir);
  printRow("State", stateFile);
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
async function executeRound(ctx: LoopContext, round: number): Promise<RoundResult> {
  const roundLogFile = join(ctx.logDir, `round-${String(round).padStart(2, "0")}.log`);

  const prompt = buildRoundPrompt(
    ctx.task,
    round,
    ctx.opts.rounds,
    ctx.stateFileRel,
    ctx.scopeFileRel,
    ctx.opts.verify,
  );

  const result = await runAgentStep({ prompt });

  const logContent = [
    `# Round ${round}/${ctx.opts.rounds}`,
    `Exit code: ${result.exitCode}`,
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
    return { round, status: "failed", summary: "agent process failed", filesChanged: [] };
  }

  return parseRoundOutput(result.stdout, round);
}

/** Run verification and log the result. Returns true if passed. */
async function runAndLogVerification(
  verifyCmd: string,
  cwd: string,
  logDir: string,
  round: number,
): Promise<boolean> {
  console.log(`  Running verify: ${verifyCmd}`);
  const verification = await runVerification(verifyCmd, cwd);
  await Bun.write(
    join(logDir, `verify-${String(round).padStart(2, "0")}.log`),
    verification.output,
  );

  if (verification.passed) {
    console.log("  ✓ Verification passed — task complete!");
    return true;
  }
  console.log("  ✗ Verification failed — continuing loop");
  return false;
}

/** Resolve and validate the scope file. */
async function resolveScopeFile(cwd: string, scope: string): Promise<string> {
  const { relative } = await import("node:path");
  const resolved = relative(cwd, join(cwd, scope));
  const exists = await Bun.file(join(cwd, scope)).exists();
  if (!exists) {
    console.error(`Error: scope file not found: ${scope}`);
    process.exit(1);
  }
  return resolved;
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function executeLoop(task: string, opts: LoopOptions): Promise<void> {
  const cwd = opts.dir ?? process.cwd();
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = join(cwd, ".loop-logs", runId);
  const stateFile = join(cwd, `.loop-state-${runId}.md`);
  const stateFileRel = `.loop-state-${runId}.md`;

  await mkdir(logDir, { recursive: true });
  await Bun.write(stateFile, initialState(task, opts.rounds));

  const scopeFileRel = opts.scope ? await resolveScopeFile(cwd, opts.scope) : undefined;
  const ctx: LoopContext = { task, cwd, logDir, stateFileRel, scopeFileRel, opts };

  printBanner(task, opts, logDir);

  let completed = 0;
  let consecutiveBlocks = 0;
  let verifyPassed = false;

  for (let round = 1; round <= opts.rounds; round++) {
    console.log(`━━━ Round ${round}/${opts.rounds} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const roundResult = await executeRound(ctx, round);

    if (roundResult.status === "failed") break;

    if (roundResult.status === "blocked") {
      consecutiveBlocks++;
      console.log(`  ⚠ Round ${round}: blocked — ${roundResult.summary}`);
      if (consecutiveBlocks >= 2) {
        console.log("\nTwo consecutive blocked rounds. Stopping.");
        break;
      }
    } else {
      completed++;
      consecutiveBlocks = 0;
      console.log(`  ✓ Round ${round}: ${roundResult.summary}`);
    }

    if (opts.verify) {
      verifyPassed = await runAndLogVerification(opts.verify, cwd, logDir, round);
      if (verifyPassed) break;
    }

    console.log("");
  }

  printSummary(completed, consecutiveBlocks, verifyPassed, !!opts.verify, logDir, stateFileRel);

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
    .action(async (taskParts: string[], options: Record<string, string>) => {
      const task = taskParts.join(" ");
      if (!task.trim()) {
        console.error("Error: provide a task description");
        console.error('Example: shaka loop "fix all test failures" --verify "bun test"');
        process.exit(1);
      }

      await executeLoop(task, {
        rounds: Number.parseInt(options.rounds ?? "10", 10),
        verify: options.verify,
        scope: options.scope,
        dir: options.dir,
      });
    });
}
