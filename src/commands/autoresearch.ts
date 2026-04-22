/**
 * CLI handler for `shaka autoresearch` — hypothesize → benchmark → keep/discard.
 *
 * A stateful optimization loop with pause/resume semantics. Deliberately its
 * own command (not a workflow) because workflows are finite pipelines and
 * autoresearch runs until the user stops it. See docs/architecture-decisions.md
 * (command-vs-workflow rationale).
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import {
  type ExperimentWorktree,
  type LoopState,
  SETUP_ARTIFACTS,
  type WizardAnswers,
  findExperimentWorktree,
  resolveResumeTarget,
  runLoop,
  runResume,
  setupWorkspace,
  summarizeHypothesis,
} from "../services/autoresearch";
import { renderStatus, shouldRenderWidget } from "../services/autoresearch-widget";
import { commitAllExcept, listDirtyPaths } from "../services/git";
import {
  type DetectedProviders,
  type ProviderName,
  detectInstalledProviders,
} from "../services/provider-detection";
import { loadSkill } from "../services/skills";
import { readlineAsk, runWizard } from "./autoresearch-wizard";

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

/** True iff `autoresearch.md` is already tracked at HEAD — user brought their own spec. */
async function sourceTracksSpec(repoRoot: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "ls-tree", "--name-only", "HEAD", "autoresearch.md"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim() === "autoresearch.md";
}

/** Maybe collect wizard answers — only when the terminal is interactive and the user needs a spec. */
async function maybeRunWizard(
  objective: string,
  repoRoot: string,
): Promise<WizardAnswers | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  if (await sourceTracksSpec(repoRoot)) return undefined;

  console.log("Let's set up your experiment. Press Enter to accept the [default].\n");
  const { ask, close } = readlineAsk();
  try {
    return await runWizard({ objective, ask });
  } finally {
    close();
  }
}

/**
 * Commit the user's finalize-benchmark edits — scoped to the setup artifacts
 * we own. Refuses to proceed when unrelated files are dirty so the loop's
 * first revert can't silently wipe them; the user decides whether to commit,
 * stash, or discard.
 *
 * Propagates the git error on commit hook failure so the caller can refuse to
 * start the loop.
 */
export async function commitFinalizeIfDirty(worktreePath: string): Promise<void> {
  const dirty = await listDirtyPaths(worktreePath);
  if (dirty.length === 0) return;

  const setupSet = new Set<string>(SETUP_ARTIFACTS);
  const unrelated = dirty.filter((path) => !setupSet.has(path));
  if (unrelated.length > 0) {
    throw new Error(
      `Unrelated changes in worktree after editor session: ${unrelated.join(", ")}. Commit or stash them before continuing, then run \`shaka autoresearch resume\`.`,
    );
  }

  for (const artifact of SETUP_ARTIFACTS) {
    if (!artifact.endsWith(".sh")) continue;
    const path = join(worktreePath, artifact);
    if (await Bun.file(path).exists()) await chmod(path, 0o755);
  }

  await commitAllExcept(["autoresearch.jsonl"], "autoresearch: finalize benchmark", worktreePath);
}

/**
 * Open `$EDITOR` on `autoresearch.sh` so the user can finish the benchmark
 * before the loop starts. Returns `true` when the setup was finalized in this
 * call (editor ran and its edits were committed) and the caller may proceed
 * into the loop. Returns `false` when the user still needs to edit manually
 * (no `$EDITOR` set, or not a TTY) — the caller must exit and wait for a
 * subsequent `shaka autoresearch resume`, which finalizes on its own.
 */
async function maybeOpenEditorOnBench(worktreePath: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const editor = process.env.EDITOR;
  if (!editor) {
    const shPath = `${worktreePath}/autoresearch.sh`;
    console.log(
      `\nFinish the benchmark by editing: ${shPath}\nThen run \`shaka autoresearch resume\` to continue.\nTip: set $EDITOR and Shaka will open it for you next time.`,
    );
    return false;
  }

  const proc = Bun.spawn(["sh", "-c", `exec ${editor} "$1"`, "sh", "autoresearch.sh"], {
    cwd: worktreePath,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Editor exited with code ${exitCode}; benchmark finalization aborted.`);
  }

  await commitFinalizeIfDirty(worktreePath);
  return true;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : null;
}

/**
 * Resolve the providers the loop should see, enforcing that at least one CLI
 * is actually installed. Throws with an actionable message before any
 * filesystem work so users never see "iteration failed" noise when the real
 * problem is an empty provider set.
 */
export function resolveProviders(
  detected: DetectedProviders,
  forced: ProviderName | undefined,
): DetectedProviders {
  if (forced !== undefined) {
    if (!detected[forced]) {
      throw new Error(
        `--provider ${forced} requested, but the ${forced} CLI is not installed. Install it or run \`shaka init\` to set it up.`,
      );
    }
    return {
      claude: forced === "claude",
      opencode: forced === "opencode",
      codex: forced === "codex",
    };
  }
  if (!detected.claude && !detected.opencode && !detected.codex) {
    throw new Error(
      "No agent providers available. Install claude, opencode, or codex, then run `shaka init`.",
    );
  }
  return detected;
}

function parsePositiveInt(flag: string): (v: string) => number {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
    return n;
  };
}

function validateProviderFlag(value: string | undefined): ProviderName | undefined {
  if (value === undefined) return undefined;
  if (value !== "claude" && value !== "opencode" && value !== "codex") {
    console.error("--provider must be one of: claude, opencode, codex");
    process.exit(1);
  }
  return value;
}

function buildStopWhen(opts: {
  maxIterations?: number;
  stopAfter?: number;
}): ((state: LoopState) => boolean) | undefined {
  if (opts.maxIterations == null && opts.stopAfter == null) return undefined;
  return (state) => {
    if (opts.maxIterations != null && state.iter >= opts.maxIterations) return true;
    if (opts.stopAfter != null && state.consecutiveDiscards >= opts.stopAfter) return true;
    return false;
  };
}

/** Install a SIGINT handler for the duration of `fn` that signals the controller. */
export async function withSigintAbort(
  controller: AbortController,
  message: string,
  fn: () => Promise<void>,
): Promise<void> {
  let sawFirstSigint = false;
  const handler = (): void => {
    if (sawFirstSigint) {
      console.log("\nSecond SIGINT — forcing exit.");
      process.exit(130);
      return;
    }
    sawFirstSigint = true;
    console.log(`\n${message}`);
    process.exitCode = 130;
    controller.abort();
  };
  process.on("SIGINT", handler);
  try {
    await fn();
  } finally {
    process.off("SIGINT", handler);
  }
}

/**
 * Build an `onTick` handler that redraws a one-line widget in place when the
 * terminal supports ANSI; falls back to plain log lines otherwise.
 */
function buildOnTick(): {
  onTick: NonNullable<Parameters<typeof runLoop>[1]>["onTick"];
  finish: () => void;
} {
  const ansi = shouldRenderWidget({
    isTTY: process.stdout.isTTY === true,
    term: process.env.TERM,
  });
  if (ansi) {
    return {
      onTick: (state) => {
        process.stdout.write(`\r\x1b[2K${renderStatus(state)}`);
      },
      finish: () => {
        process.stdout.write("\n");
      },
    };
  }
  return {
    onTick: (state) => {
      console.log(renderStatus(state));
    },
    finish: () => undefined,
  };
}

interface LoopFlags {
  readonly provider?: ProviderName;
  readonly maxIterations?: number;
  readonly stopAfter?: number;
}

async function runStart(objective: string, opts: LoopFlags): Promise<void> {
  const repoRoot = await resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(
      "Not inside a git repository. Run `shaka autoresearch start` from within the repo you want to optimize.",
    );
    process.exit(1);
  }

  const providers = resolveProviders(detectInstalledProviders(), opts.provider);

  const answers = await maybeRunWizard(objective, repoRoot);
  const setup = await setupWorkspace({ repoRoot, objective, answers });
  console.log(`\nWorktree: ${setup.worktreePath}`);
  console.log(`Branch:   ${setup.branch}`);

  if (answers !== undefined) {
    const finalized = await maybeOpenEditorOnBench(setup.worktreePath);
    // When `$EDITOR` isn't set the user is told to edit `autoresearch.sh`
    // manually and run `resume` — don't then silently enter the loop here
    // and run the TODO-marker'd benchmark for no reason.
    if (!finalized) return;
  }

  const skillContent = await loadSkill("Autoresearch");
  const controller = new AbortController();
  const widget = buildOnTick();
  try {
    await withSigintAbort(
      controller,
      "SIGINT received — finishing current iteration, then stopping.",
      () =>
        runLoop(
          {
            cwd: setup.worktreePath,
            providers,
            stopWhen: buildStopWhen(opts),
            signal: controller.signal,
            skillContent,
          },
          { onTick: widget.onTick },
        ),
    );
  } finally {
    widget.finish();
  }
}

async function runResumeCommand(slug: string | undefined, opts: LoopFlags): Promise<void> {
  const repoRoot = await resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not inside a git repository.");
    process.exit(1);
  }

  const providers = resolveProviders(detectInstalledProviders(), opts.provider);
  const targetCwd = await resolveResumeTarget(process.cwd(), repoRoot, slug);

  console.log(`Resuming: ${targetCwd}`);

  // Commit any user edits to the setup artifacts (autoresearch.sh, .md,
  // .checks.sh) before handing off to the loop. This handles the no-$EDITOR
  // workflow: user edits `autoresearch.sh` manually, then runs `resume`.
  // If unrelated files are dirty, this throws with an actionable message
  // before the loop gets a chance to silently commit or revert them.
  await commitFinalizeIfDirty(targetCwd);

  const skillContent = await loadSkill("Autoresearch");
  const controller = new AbortController();
  const widget = buildOnTick();
  try {
    await withSigintAbort(
      controller,
      "SIGINT received — finishing current iteration, then stopping.",
      () =>
        runResume(
          {
            cwd: targetCwd,
            providers,
            stopWhen: buildStopWhen(opts),
            signal: controller.signal,
            skillContent,
          },
          { onTick: widget.onTick },
        ),
    );
  } finally {
    widget.finish();
  }
}

function describeState(exp: ExperimentWorktree): string {
  if (exp.prunable !== null) return exp.prunable === "" ? "prunable" : `prunable (${exp.prunable})`;
  if (exp.locked !== null) return exp.locked === "" ? "locked" : `locked (${exp.locked})`;
  return "active";
}

async function lastJsonlEntries(worktreePath: string, limit: number): Promise<string[]> {
  const file = Bun.file(join(worktreePath, "autoresearch.jsonl"));
  if (!(await file.exists())) return [];
  const lines = (await file.text())
    .split("\n")
    .filter((l) => l.length > 0)
    .slice(-limit);
  return lines.flatMap((line) => {
    try {
      const e = JSON.parse(line);
      const metric = e.metric ?? "?";
      const commit = e.commit ?? "-";
      return [
        `iter ${e.iter} [${e.verdict}] metric=${metric} commit=${commit} — ${summarizeHypothesis(e.hypothesis ?? "")}`,
      ];
    } catch {
      return [];
    }
  });
}

async function runStatusCommand(): Promise<void> {
  const repoRoot = await resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not inside a git repository.");
    process.exit(1);
  }

  const experiments = await findExperimentWorktree(repoRoot);
  if (experiments.length === 0) {
    console.log("No autoresearch experiments in this repo.");
    return;
  }

  for (const exp of experiments) {
    console.log(`\n${exp.slug}  [${describeState(exp)}]`);
    console.log(`  path:   ${exp.worktreePath}`);
    console.log(`  branch: ${exp.branch}`);
    console.log(`  HEAD:   ${exp.head.slice(0, 7)}`);
    const recent = await lastJsonlEntries(exp.worktreePath, 3);
    if (recent.length === 0) {
      console.log("  (no iterations yet)");
    } else {
      for (const line of recent) console.log(`  ${line}`);
    }
  }
}

export function createAutoresearchCommand(): Command {
  const cmd = new Command("autoresearch").description(
    "Hypothesize → benchmark → keep/discard optimization loop",
  );

  cmd
    .command("start <objective>")
    .description("Begin a new autoresearch experiment")
    .option("--provider <name>", "Force a specific provider (claude|opencode|codex)")
    .option("--max-iterations <n>", "Stop after N iterations", parsePositiveInt("--max-iterations"))
    .option(
      "--stop-after <n>",
      "Stop after N consecutive discards without improvement",
      parsePositiveInt("--stop-after"),
    )
    .action(
      async (
        objective: string,
        opts: { provider?: string; maxIterations?: number; stopAfter?: number },
      ) => {
        await runStart(objective, {
          provider: validateProviderFlag(opts.provider),
          maxIterations: opts.maxIterations,
          stopAfter: opts.stopAfter,
        });
      },
    );

  cmd
    .command("status")
    .description("Show autoresearch experiments in the current repo")
    .action(() => runStatusCommand());

  cmd
    .command("resume [slug]")
    .description("Resume a paused autoresearch experiment")
    .option("--provider <name>", "Force a specific provider (claude|opencode|codex)")
    .option("--max-iterations <n>", "Stop after N iterations", parsePositiveInt("--max-iterations"))
    .option(
      "--stop-after <n>",
      "Stop after N consecutive discards without improvement",
      parsePositiveInt("--stop-after"),
    )
    .action(
      async (
        slug: string | undefined,
        opts: { provider?: string; maxIterations?: number; stopAfter?: number },
      ) => {
        await runResumeCommand(slug, {
          provider: validateProviderFlag(opts.provider),
          maxIterations: opts.maxIterations,
          stopAfter: opts.stopAfter,
        });
      },
    );

  return cmd;
}
