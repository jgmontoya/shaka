/**
 * Workflow runner — the orchestration engine.
 * Executes a linear pipeline of steps with output handoff,
 * optional git state management, and artifact storage.
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentStep } from "../domain/agent-execution";
import type {
  GroupStep,
  RunMetadata,
  StepResult,
  Workflow,
  WorkflowStep,
} from "../domain/workflow";
import {
  addWorktree,
  commitAll,
  hasChanges,
  isClean,
  removeWorktree,
  resetLastCommit,
} from "./git";

export interface RunOptions {
  readonly workflow: Workflow;
  readonly input: string;
  readonly cwd: string;
  readonly shakaHome: string;
  /** Called when a step starts executing. */
  readonly onStepStart?: (
    stepName: string,
    stepIndex: number,
    total: number,
    loopIteration: number,
    loopTotal: number,
  ) => void;
  /** Called when a step finishes executing. */
  readonly onStepComplete?: (stepName: string, exitCode: number, durationMs: number) => void;
}

export interface RunResult {
  readonly metadata: RunMetadata;
  readonly artifactDir: string;
}

/** Generate a run ID from the current timestamp. */
export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

export interface LoopContext {
  readonly iteration: number;
  readonly total: number;
}

const DEFAULT_LOOP: LoopContext = { iteration: 1, total: 1 };

/** Resolve template variables in a string. */
export function resolveTemplates(
  template: string,
  input: string,
  steps: Map<string, StepResult>,
  previousResult: StepResult | null,
  loop: LoopContext = DEFAULT_LOOP,
): string {
  let result = template;

  result = result.replace(/\{input\}/g, () => input);
  result = result.replace(/\{previous\.output\}/g, () => previousResult?.output ?? "");
  result = result.replace(/\{previous\.exitCode\}/g, () =>
    previousResult != null ? String(previousResult.exitCode) : "",
  );

  // Named step references: {steps.<name>.output} and {steps.<name>.exitCode}
  result = result.replace(/\{steps\.([^.}]+)\.output\}/g, (_match, name: string) => {
    return steps.get(name)?.output ?? "";
  });
  result = result.replace(/\{steps\.([^.}]+)\.exitCode\}/g, (_match, name: string) => {
    const step = steps.get(name);
    return step != null ? String(step.exitCode) : "";
  });

  // Loop context
  result = result.replace(/\{loop\.iteration\}/g, () => String(loop.iteration));
  result = result.replace(/\{loop\.total\}/g, () => String(loop.total));

  return result;
}

/** Execute a single leaf workflow step (not a group). */
async function executeLeafStep(
  step: Exclude<WorkflowStep, GroupStep>,
  resolvedValue: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  switch (step.type) {
    case "command":
    case "prompt": {
      const result = await runAgentStep({ prompt: resolvedValue });
      return {
        exitCode: result.exitCode,
        stdout: result.stderr ? `${result.stdout}\n[stderr]\n${result.stderr}` : result.stdout,
      };
    }
    case "run": {
      const shell =
        process.platform === "win32"
          ? (["cmd", "/c", resolvedValue] as const)
          : (["sh", "-c", resolvedValue] as const);
      const proc = Bun.spawn([...shell], { cwd, stdout: "pipe", stderr: "pipe" });
      // Read both streams before awaiting exit to avoid pipe buffer deadlock
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout: stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout };
    }
  }
}

/** Get the resolved value string from a leaf step (the command/prompt/run content). */
function getStepValue(step: Exclude<WorkflowStep, GroupStep>): string {
  switch (step.type) {
    case "command":
      return step.command;
    case "prompt":
      return step.prompt;
    case "run":
      return step.run;
  }
}

interface GitSetupResult {
  readonly error?: string;
  /** The worktree directory where steps should run. */
  readonly worktreePath?: string;
}

/** Format an error for display. */
function fmtErr(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : err}`;
}

/** WIP-commit dirty changes, returning whether a commit was made. */
async function wipCommitIfDirty(cwd: string): Promise<{ committed: boolean; error?: string }> {
  if (await isClean(cwd)) return { committed: false };
  try {
    await commitAll("--wip-- [skip ci]", cwd);
    return { committed: true };
  } catch (err) {
    return { committed: false, error: fmtErr("Failed to save working changes", err) };
  }
}

/** Pre-flight git setup: WIP-commit if dirty, create worktree, restore user's workspace. */
async function setupGitBranch(
  branchName: string,
  worktreePath: string,
  cwd: string,
): Promise<GitSetupResult> {
  const wip = await wipCommitIfDirty(cwd);
  if (wip.error) return { error: wip.error };

  try {
    await addWorktree(worktreePath, branchName, cwd);
  } catch (err) {
    if (wip.committed) await resetLastCommit(cwd).catch(() => {});
    return { error: fmtErr("Failed to create worktree", err) };
  }

  // Restore the user's workspace immediately — undo the WIP commit
  if (wip.committed) {
    try {
      await resetLastCommit(cwd);
    } catch (err) {
      await removeWorktree(worktreePath, cwd).catch(() => {});
      return { error: fmtErr("Failed to restore workspace", err) };
    }
  }

  return { worktreePath };
}

/** Build a failed RunResult and write metadata to disk. */
async function failEarly(
  workflow: string,
  input: string,
  startedAt: string,
  artifactDir: string,
  totalIterations: number,
): Promise<RunResult> {
  const metadata: RunMetadata = {
    workflow,
    input,
    startedAt,
    branch: null,
    steps: [],
    totalIterations,
    completedIterations: 0,
    completedAt: new Date().toISOString(),
    status: "failed",
  };
  await Bun.write(join(artifactDir, "run.json"), JSON.stringify(metadata, null, 2));
  return { metadata, artifactDir };
}

interface StepContext {
  readonly input: string;
  readonly cwd: string;
  /** Current artifact directory — groups temporarily override this for their subdirectory. */
  artifactDir: string;
  readonly workflowName: string;
  readonly useGit: boolean;
  /** Total steps at the current nesting level. Groups temporarily override this. */
  totalSteps: number;
  /** Accumulates across all iterations and groups — written to run.json at the end. */
  stepResults: StepResult[];
  /** Reset per iteration — used only for {steps.<name>} template resolution. Groups isolate this. */
  stepMap: Map<string, StepResult>;
  readonly onStepStart?: (
    stepName: string,
    stepIndex: number,
    total: number,
    loopIteration: number,
    loopTotal: number,
  ) => void;
  readonly onStepComplete?: (stepName: string, exitCode: number, durationMs: number) => void;
  // Mutable: loop advances each iteration; previousResult updates after each step.
  loop: LoopContext;
  previousResult: StepResult | null;
}

/** Resolve the artifact output path for a step, accounting for loop iterations. */
function artifactPath(artifactDir: string, stepName: string, loop: LoopContext): string {
  if (loop.total <= 1) return join(artifactDir, `${stepName}.out`);
  return join(artifactDir, `iter-${loop.iteration}`, `${stepName}.out`);
}

/** Format a git commit message, including iteration context when looping. */
function commitMessage(stepName: string, workflowName: string, loop: LoopContext): string {
  if (loop.total <= 1) return `shaka(${stepName}): ${workflowName}`;
  return `shaka(${stepName})[${loop.iteration}/${loop.total}]: ${workflowName}`;
}

/** Execute one step (leaf or group). Returns "halt" if the pipeline should stop. */
async function runStep(
  step: WorkflowStep,
  ctx: StepContext,
  stepIndex: number,
): Promise<"continue" | "halt"> {
  if (step.type === "group") return runGroup(step, ctx);
  return runLeafStep(step, ctx, stepIndex);
}

/** Execute a leaf step, record its result, and optionally git-commit. */
async function runLeafStep(
  step: Exclude<WorkflowStep, GroupStep>,
  ctx: StepContext,
  stepIndex: number,
): Promise<"continue" | "halt"> {
  const rawValue = getStepValue(step);
  const resolvedValue = resolveTemplates(
    rawValue,
    ctx.input,
    ctx.stepMap,
    ctx.previousResult,
    ctx.loop,
  );

  ctx.onStepStart?.(step.name, stepIndex, ctx.totalSteps, ctx.loop.iteration, ctx.loop.total);

  const startMs = Date.now();
  const { exitCode, stdout } = await executeLeafStep(step, resolvedValue, ctx.cwd);
  const durationMs = Date.now() - startMs;

  ctx.onStepComplete?.(step.name, exitCode, durationMs);

  const result: StepResult = {
    name: step.name,
    type: step.type,
    exitCode,
    output: stdout,
    durationMs,
    iteration: ctx.loop.iteration,
  };

  ctx.stepResults.push(result);
  ctx.stepMap.set(step.name, result);
  ctx.previousResult = result;

  const outPath = artifactPath(ctx.artifactDir, step.name, ctx.loop);
  await Bun.write(outPath, stdout);

  if (ctx.useGit) {
    try {
      if (await hasChanges(ctx.cwd)) {
        await commitAll(commitMessage(step.name, ctx.workflowName, ctx.loop), ctx.cwd);
      }
    } catch (err) {
      console.error(
        `Git commit failed after step "${step.name}": ${err instanceof Error ? err.message : err}`,
      );
      return "halt";
    }
  }

  if (exitCode !== 0 && !step.allowFailure) {
    return "halt";
  }

  return "continue";
}

/** Execute a group step — runs inner steps with isolated stepMap and its own loop context. */
async function runGroup(group: GroupStep, ctx: StepContext): Promise<"continue" | "halt"> {
  const outerLoop = ctx.loop;
  const outerStepMap = ctx.stepMap;
  const outerArtifactDir = ctx.artifactDir;
  const outerTotalSteps = ctx.totalSteps;

  // Groups get their own artifact subdirectory
  const groupArtifactDir = join(ctx.artifactDir, group.name);

  ctx.stepMap = new Map();
  ctx.artifactDir = groupArtifactDir;
  ctx.totalSteps = group.steps.length;

  let halted = false;
  for (let iteration = 1; iteration <= group.loop; iteration++) {
    ctx.loop = { iteration, total: group.loop };

    if (group.loop > 1) {
      await mkdir(join(groupArtifactDir, `iter-${iteration}`), { recursive: true });
    }

    ctx.stepMap.clear();
    for (const [i, step] of group.steps.entries()) {
      if ((await runStep(step, ctx, i)) === "halt") {
        halted = true;
        break;
      }
    }
    if (halted) break;
  }

  // Project the group result into the outer context
  if (ctx.previousResult) {
    outerStepMap.set(group.name, ctx.previousResult);
  }

  // Restore outer context
  ctx.stepMap = outerStepMap;
  ctx.loop = outerLoop;
  ctx.artifactDir = outerArtifactDir;
  ctx.totalSteps = outerTotalSteps;

  if (halted && !group.allowFailure) return "halt";
  return "continue";
}

interface ExecutionResult {
  readonly failed: boolean;
  readonly completedIterations: number;
}

/** Run all steps in a single iteration. Returns true if a step halted. */
async function runIteration(steps: readonly WorkflowStep[], ctx: StepContext): Promise<boolean> {
  if (ctx.loop.total > 1) {
    await mkdir(join(ctx.artifactDir, `iter-${ctx.loop.iteration}`), { recursive: true });
  }
  // Reset the step map so {steps.<name>} resolves only the current iteration.
  // previousResult is intentionally NOT reset — it carries across iterations.
  ctx.stepMap.clear();
  for (const [i, step] of steps.entries()) {
    if ((await runStep(step, ctx, i)) === "halt") return true;
  }
  return false;
}

/** Clean up a worktree, logging errors instead of throwing. */
async function cleanupWorktree(worktreePath: string, cwd: string): Promise<void> {
  try {
    await removeWorktree(worktreePath, cwd);
  } catch (err) {
    console.error(`Failed to remove worktree: ${err instanceof Error ? err.message : err}`);
    console.error(`Manual cleanup: git worktree remove ${worktreePath} --force`);
  }
}

/** Run all steps across all iterations, guaranteeing worktree cleanup on any exit path. */
async function executeSteps(
  steps: readonly WorkflowStep[],
  ctx: StepContext,
  worktreePath: string | undefined,
  cwd: string, // original working dir (not the worktree) — used for git worktree removal
): Promise<ExecutionResult> {
  let completedIterations = 0;
  let failed = false;
  try {
    for (let iteration = 1; iteration <= ctx.loop.total; iteration++) {
      ctx.loop = { ...ctx.loop, iteration };
      failed = await runIteration(steps, ctx);
      if (failed) break;
      completedIterations = iteration;
    }
  } catch (err) {
    failed = true;
    console.error(`Workflow execution failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (worktreePath) await cleanupWorktree(worktreePath, cwd);
  }
  return { failed, completedIterations };
}

/** Execute a workflow. */
export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const { workflow, input, cwd, shakaHome } = options;
  const runId = generateRunId();
  const artifactDir = join(shakaHome, "runs", `${workflow.name}-${runId}`);
  const startedAt = new Date().toISOString();
  const useGit = workflow.state === "git-branch";
  const totalIterations = workflow.loop;
  let branch: string | null = null;
  let worktreePath: string | undefined;

  await mkdir(artifactDir, { recursive: true });

  if (useGit) {
    branch = `shaka/run-${workflow.name}-${runId}`;
    worktreePath = join(tmpdir(), "shaka-worktrees", `run-${workflow.name}-${runId}`);
    const setup = await setupGitBranch(branch, worktreePath, cwd);
    if (setup.error) {
      console.error(setup.error);
      return failEarly(workflow.name, input, startedAt, artifactDir, totalIterations);
    }
  }

  // Steps run in the worktree (isolated branch) when using git, otherwise in the user's cwd.
  const stepCwd = worktreePath ?? cwd;

  const ctx: StepContext = {
    input,
    cwd: stepCwd,
    artifactDir,
    workflowName: workflow.name,
    useGit,
    totalSteps: workflow.steps.length,
    loop: { iteration: 1, total: totalIterations },
    stepResults: [],
    stepMap: new Map(),
    onStepStart: options.onStepStart,
    onStepComplete: options.onStepComplete,
    previousResult: null,
  };

  const { failed, completedIterations } = await executeSteps(
    workflow.steps,
    ctx,
    worktreePath,
    cwd,
  );

  const metadata: RunMetadata = {
    workflow: workflow.name,
    input,
    startedAt,
    branch,
    steps: ctx.stepResults,
    totalIterations,
    completedIterations,
    completedAt: new Date().toISOString(),
    status: failed ? "failed" : "completed",
  };

  await Bun.write(join(artifactDir, "run.json"), JSON.stringify(metadata, null, 2));

  return { metadata, artifactDir };
}
