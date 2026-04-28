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
  RUNNER_STATE_EXCLUDES,
  SETUP_ARTIFACTS,
  type WizardAnswers,
  assertOnlySetupDirty,
  findExperimentWorktree,
  forceStageSetupArtifacts,
  parseAutoresearchSpec,
  resolveResumeTarget,
  runLoop,
  runResume,
  setupArtifactsDirty,
  setupWorkspace,
  summarizeHypothesis,
  validateSetup,
  writeBaselineMetaFromMeasurement,
} from "../services/autoresearch";
import {
  buildAutoresearchReportModel,
  renderAutoresearchHtml,
} from "../services/autoresearch-report";
import { renderStatus, shouldRenderWidget } from "../services/autoresearch-widget";
import { commitAllExcept, listDirtyPaths, listWorktrees } from "../services/git";
import {
  type DetectedProviders,
  type ProviderName,
  detectInstalledProviders,
} from "../services/provider-detection";
import { runSetupInteractive, runSetupOneshot } from "../services/setup-session";
import { loadSkill } from "../services/skills";
import { readlineAsk, runWizard } from "./autoresearch-wizard";

type OpenFile = (path: string) => Promise<void>;

interface AutoresearchCommandDeps {
  readonly openFile?: OpenFile;
}

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
export async function commitFinalizeIfDirty(
  worktreePath: string,
  opts?: { readonly message?: string },
): Promise<void> {
  // Two signals decide whether there's anything to finalize:
  //   1. Plain `git status` for tracked + untracked-non-ignored changes.
  //   2. `setupArtifactsDirty` (pathspec-scoped + ignored-aware) so a
  //      gitignored setup artifact (e.g. repo ignores `*.sh`) still
  //      triggers the finalize flow. Without (2), a valid autoresearch.
  //      checks.sh that matches .gitignore would be hidden, the function
  //      would early-return, the file would never get chmod/staged/
  //      committed, and the next resume's tamper check would treat it as
  //      agent-dropped and delete it.
  // We deliberately do NOT pass `includeIgnored: true` to listDirtyPaths
  // here — that would surface every gitignored toolchain output (Cargo
  // `target/`, Node `node_modules/`, runtime data dirs) the benchmark
  // legitimately produced and trip assertOnlySetupDirty.
  const dirty = await listDirtyPaths(worktreePath);
  const setupDirty = await setupArtifactsDirty(worktreePath);
  const runnerState = new Set<string>(RUNNER_STATE_EXCLUDES);
  const userDirty = dirty.filter((path) => !runnerState.has(path));
  if (userDirty.length === 0 && !setupDirty) return;

  await assertOnlySetupDirty(worktreePath);

  for (const artifact of SETUP_ARTIFACTS) {
    if (!artifact.endsWith(".sh")) continue;
    const path = join(worktreePath, artifact);
    if (await Bun.file(path).exists()) await chmod(path, 0o755);
  }

  // Force-stage setup artifacts so a source-repo .gitignore pattern can't
  // silently skip them on commitAllExcept's `git add -A`. Same helper
  // setupWorkspace uses at initial commit.
  await forceStageSetupArtifacts(worktreePath);

  const message = opts?.message ?? "autoresearch: finalize benchmark";
  await commitAllExcept(RUNNER_STATE_EXCLUDES, message, worktreePath);
}

/**
 * Open `$EDITOR` on `autoresearch.sh` so the user can finish the benchmark
 * before the loop starts. Returns `true` when the setup was finalized in this
 * call (editor ran and its edits were committed) and the caller may proceed
 * into the loop. Returns `false` when the user still needs to edit manually
 * (no `$EDITOR` set, or not a TTY) — the caller must exit and wait for a
 * subsequent resume command, which finalizes on its own.
 */
async function maybeOpenEditorOnBench(worktreePath: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const editor = process.env.EDITOR;
  if (!editor) {
    const shPath = `${worktreePath}/autoresearch.sh`;
    console.log(
      `\nFinish the benchmark by editing: ${shPath}\nThen run \`shaka optimize resume\` to continue (\`shaka autoresearch resume\` also works).\nTip: set $EDITOR and Shaka will open it for you next time.`,
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
    throw new Error("--provider must be one of: claude, opencode, codex");
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

/**
 * Additional flags for `shaka autoresearch start`. `wizard` opts out of the
 * full-auto default; `dryRun` validates without committing or entering the
 * loop; `oneshot` runs the setup agent non-interactively via `runAgentStep`
 * instead of handing the TTY to the provider CLI. Rejected in combination
 * at arg-parse time: `--oneshot --wizard` and `--dry-run --wizard`.
 * `--oneshot --dry-run` is allowed.
 */
export interface StartFlags extends LoopFlags {
  readonly wizard?: boolean;
  readonly dryRun?: boolean;
  readonly oneshot?: boolean;
}

/**
 * Dependency-injection seams for `runStart`. The deps bag exists specifically
 * to exercise system boundaries (provider detection, loop entry) from tests
 * without launching real provider CLIs. Production callers pass nothing.
 *
 * Kept minimal on purpose — see `feedback_follow_codebase_not_theory`: DI only
 * where testability demands it, not as blanket architecture.
 */
export interface StartDeps {
  readonly detectProviders?: () => DetectedProviders;
  readonly runSetupInteractive?: typeof runSetupInteractive;
  readonly runSetupOneshot?: typeof runSetupOneshot;
  readonly runLoop?: typeof runLoop;
}

/** First available provider in the standard resolution order: claude → opencode → codex. */
function pickProvider(providers: DetectedProviders): ProviderName {
  if (providers.claude) return "claude";
  if (providers.opencode) return "opencode";
  if (providers.codex) return "codex";
  throw new Error("No providers available — guarded upstream");
}

async function enterLoop(
  worktreePath: string,
  providers: DetectedProviders,
  opts: LoopFlags,
  loopFn: typeof runLoop,
): Promise<void> {
  const skillContent = await loadSkill("autoresearch");
  const controller = new AbortController();
  const widget = buildOnTick();
  try {
    await withSigintAbort(
      controller,
      "SIGINT received — finishing current iteration, then stopping.",
      () =>
        loopFn(
          {
            cwd: worktreePath,
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

async function runWizardStart(
  objective: string,
  opts: StartFlags,
  repoRoot: string,
  providers: DetectedProviders,
  loopFn: typeof runLoop,
): Promise<void> {
  const answers = await maybeRunWizard(objective, repoRoot);
  const setup = answers
    ? await setupWorkspace({ repoRoot, objective, templateMode: "wizard", answers })
    : await setupWorkspace({ repoRoot, objective, templateMode: "todo" });
  console.log(`\nWorktree: ${setup.worktreePath}`);
  console.log(`Branch:   ${setup.branch}`);
  if (answers !== undefined) {
    const finalized = await maybeOpenEditorOnBench(setup.worktreePath);
    // Without `$EDITOR`, the user edits by hand and runs `resume` — don't
    // silently enter the loop with the TODO-marker'd benchmark.
    if (!finalized) return;
  }
  await enterLoop(setup.worktreePath, providers, opts, loopFn);
}

function reportValidationFailure(
  worktreePath: string,
  validation: Extract<Awaited<ReturnType<typeof validateSetup>>, { ok: false }>,
  commandName: "autoresearch" | "optimize",
): never {
  console.error(`\nSetup validation failed at phase '${validation.phase}': ${validation.message}`);
  if (validation.stdout) console.error(`\nSTDOUT:\n${validation.stdout}`);
  if (validation.stderr) console.error(`\nSTDERR:\n${validation.stderr}`);
  console.error(`\nWorktree left at: ${worktreePath}`);
  console.error(
    `Re-run \`shaka ${commandName} start\` with a more specific objective, or open the worktree and fix the setup by hand.`,
  );
  process.exit(1);
}

async function printDryRun(worktreePath: string): Promise<void> {
  console.log("\nSetup validated. Dry-run: not committing, not entering loop.");
  console.log(`Worktree: ${worktreePath}`);
  const script = await Bun.file(join(worktreePath, "autoresearch.sh")).text();
  console.log(`\n--- autoresearch.sh ---\n${script}`);
}

async function runFullAutoStart(
  objective: string,
  opts: StartFlags,
  repoRoot: string,
  detected: DetectedProviders,
  interactiveFn: typeof runSetupInteractive,
  oneshotFn: typeof runSetupOneshot,
  loopFn: typeof runLoop,
  commandName: "autoresearch" | "optimize",
): Promise<void> {
  // --oneshot runs the setup agent without a TTY handoff, so the TTY guard is
  // skipped — that's the entire point of the flag (unattended / CI / scripted).
  if (opts.oneshot !== true && process.stdin.isTTY !== true) {
    console.error(
      "Full-auto autoresearch requires a TTY (interactive handoff to the provider CLI).\n" +
        "Pipe, CI, or `ssh -T` detected. Re-run with `--wizard` to use the hand-filled wizard path instead.",
    );
    process.exit(1);
  }
  if (!detected.claude && !detected.opencode && !detected.codex) {
    console.error(
      "No agent provider installed (claude, opencode, or codex).\n" +
        "Run `shaka init` to install one, or re-run with `--wizard` to fill the setup fields by hand.",
    );
    process.exit(1);
  }

  const providers = resolveProviders(detected, opts.provider);
  const provider = pickProvider(providers);

  const setup = await setupWorkspace({ repoRoot, objective, templateMode: "defer" });
  console.log(`\nWorktree: ${setup.worktreePath}`);
  console.log(`Branch:   ${setup.branch}`);

  const setupSkill = await loadSkill("autoresearch-setup");
  const sessionFn = opts.oneshot === true ? oneshotFn : interactiveFn;
  await sessionFn(setup.worktreePath, objective, provider, setupSkill);

  // The provider TUI (or oneshot subprocess) just exited. The following
  // phases run silently — validation can take tens of seconds because it
  // executes the user's benchmark once, and the widget won't draw until
  // after iteration 1 completes. Narrate each phase so the user knows
  // Shaka is working rather than hung.
  console.log("\nSetup session ended. Validating generated artifacts...");
  const validation = await validateSetup(setup.worktreePath);
  if (!validation.ok) reportValidationFailure(setup.worktreePath, validation, commandName);
  console.log(
    `✓ Setup validated (${validation.measurement.name}=${validation.measurement.value}${validation.measurement.unit}).`,
  );

  if (opts.dryRun === true) {
    await printDryRun(setup.worktreePath);
    return;
  }

  console.log("Committing setup...");
  await commitFinalizeIfDirty(setup.worktreePath, {
    message: "autoresearch: finalize agent-generated setup",
  });
  const spec = parseAutoresearchSpec(
    await Bun.file(join(setup.worktreePath, "autoresearch.md")).text(),
  );
  await writeBaselineMetaFromMeasurement(setup.worktreePath, validation.measurement, spec);
  console.log("Entering optimization loop...");
  await enterLoop(setup.worktreePath, providers, opts, loopFn);
}

export async function runStart(
  objective: string,
  opts: StartFlags,
  deps: StartDeps = {},
  commandName: "autoresearch" | "optimize" = "autoresearch",
): Promise<void> {
  const detect = deps.detectProviders ?? detectInstalledProviders;
  const interactiveFn = deps.runSetupInteractive ?? runSetupInteractive;
  const oneshotFn = deps.runSetupOneshot ?? runSetupOneshot;
  const loopFn = deps.runLoop ?? runLoop;

  const repoRoot = await resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error(
      `Not inside a git repository. Run \`shaka ${commandName} start\` from within the repo you want to optimize.`,
    );
    process.exit(1);
  }

  const detected = detect();

  if (opts.wizard === true) {
    const providers = resolveProviders(detected, opts.provider);
    return runWizardStart(objective, opts, repoRoot, providers, loopFn);
  }

  return runFullAutoStart(
    objective,
    opts,
    repoRoot,
    detected,
    interactiveFn,
    oneshotFn,
    loopFn,
    commandName,
  );
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

  // `runResume` has the same `(cfg, deps) => Promise<void>` shape as `runLoop`,
  // so it slots into `enterLoop`'s loop-framing (skill load, abort controller,
  // widget lifecycle, SIGINT handling) without duplicating the scaffolding.
  await enterLoop(targetCwd, providers, opts, runResume);
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

async function defaultOpenFile(path: string): Promise<void> {
  const args =
    process.platform === "darwin"
      ? ["open", path]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", path]
        : ["xdg-open", path];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `${args[0]} exited ${code}`);
  }
}

async function resolveHtmlTarget(
  cwd: string,
  repoRoot: string,
  slug: string | undefined,
  output: string | undefined,
): Promise<{ readonly worktreePath: string; readonly slug: string; readonly output: string }> {
  const worktreePath = await resolveResumeTarget(cwd, repoRoot, slug);
  const experiments = await findExperimentWorktree(repoRoot);
  const experiment = experiments.find((exp) => exp.worktreePath === worktreePath);
  const reportSlug = slug ?? experiment?.slug;
  if (reportSlug === undefined) {
    throw new Error("Could not determine autoresearch experiment slug for report output.");
  }
  if (output !== undefined) return { worktreePath, slug: reportSlug, output };

  const source = (await listWorktrees(repoRoot)).find(
    (wt) => wt.branch !== null && !wt.branch.startsWith("autoresearch/"),
  );
  if (source === undefined) {
    throw new Error(
      "Could not determine source repo root for default report output. Pass --output.",
    );
  }
  return {
    worktreePath,
    slug: reportSlug,
    output: join(source.path, `autoresearch-report-${reportSlug}.html`),
  };
}

async function runHtmlCommand(
  slug: string | undefined,
  opts: { readonly output?: string; readonly open?: boolean },
  deps: AutoresearchCommandDeps,
): Promise<void> {
  const repoRoot = await resolveRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not inside a git repository.");
    process.exit(1);
  }
  const target = await resolveHtmlTarget(process.cwd(), repoRoot, slug, opts.output);
  const model = await buildAutoresearchReportModel(target.worktreePath);
  const html = renderAutoresearchHtml(model);
  await Bun.write(target.output, html);
  console.log(`Wrote ${target.output}`);
  if (opts.open !== false) {
    const opener = deps.openFile ?? defaultOpenFile;
    try {
      await opener(target.output);
    } catch (err) {
      console.warn(
        `Could not open report automatically: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn(`Report written to: ${target.output}`);
    }
  }
}

function createAutoresearchCommandNamed(
  name: "autoresearch" | "optimize",
  deps: AutoresearchCommandDeps = {},
): Command {
  const cmd = new Command(name).description(
    "Hypothesize → benchmark → keep/discard optimization loop",
  );

  cmd
    .command("start <objective>")
    .description("Begin a new optimization experiment")
    .option("--provider <name>", "Force a specific provider (claude|opencode|codex)")
    .option("--max-iterations <n>", "Stop after N iterations", parsePositiveInt("--max-iterations"))
    .option(
      "--stop-after <n>",
      "Stop after N consecutive discards without improvement",
      parsePositiveInt("--stop-after"),
    )
    .option("--wizard", "Opt out of full-auto; use the hand-filled wizard + TODO template")
    .option("--dry-run", "Generate + validate setup, but don't commit and don't enter the loop")
    .option(
      "--oneshot",
      "Run setup agent non-interactively (no TUI handoff); useful for unattended / CI / scripted invocations",
    )
    .action(
      async (
        objective: string,
        opts: {
          provider?: string;
          maxIterations?: number;
          stopAfter?: number;
          wizard?: boolean;
          dryRun?: boolean;
          oneshot?: boolean;
        },
      ) => {
        if (opts.wizard === true && opts.dryRun === true) {
          throw new Error(
            "--wizard and --dry-run cannot be combined: the wizard path has no post-setup loop-entry step to skip.",
          );
        }
        if (opts.oneshot === true && opts.wizard === true) {
          throw new Error(
            "--oneshot and --wizard cannot be combined: --oneshot is a non-interactive variant of full-auto, --wizard opts out of full-auto entirely.",
          );
        }
        await runStart(
          objective,
          {
            provider: validateProviderFlag(opts.provider),
            maxIterations: opts.maxIterations,
            stopAfter: opts.stopAfter,
            wizard: opts.wizard,
            dryRun: opts.dryRun,
            oneshot: opts.oneshot,
          },
          {},
          name,
        );
      },
    );

  cmd
    .command("status")
    .description("Show optimization experiments in the current repo")
    .action(() => runStatusCommand());

  cmd
    .command("html [slug]")
    .description("Generate an HTML report for an optimization experiment")
    .option("--output <path>", "Write report to an explicit file")
    .option("--no-open", "Do not open the generated report")
    .action((slug: string | undefined, opts: { output?: string; open?: boolean }) =>
      runHtmlCommand(slug, opts, deps),
    );

  cmd
    .command("resume [slug]")
    .description("Resume a paused optimization experiment")
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

export function createAutoresearchCommand(deps: AutoresearchCommandDeps = {}): Command {
  return createAutoresearchCommandNamed("autoresearch", deps);
}

export function createOptimizeCommand(deps: AutoresearchCommandDeps = {}): Command {
  return createAutoresearchCommandNamed("optimize", deps);
}
