/**
 * Workflow runner — the orchestration engine.
 * Executes a linear pipeline of steps with output handoff,
 * optional git state management, and artifact storage.
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentStep } from "../domain/agent-execution";
import type { RunMetadata, StepResult, Workflow, WorkflowStep } from "../domain/workflow";
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
  readonly onStepStart?: (stepName: string, stepIndex: number, total: number) => void;
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

/** Resolve template variables in a string. */
export function resolveTemplates(
  template: string,
  input: string,
  steps: Map<string, StepResult>,
  previousResult: StepResult | null,
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

  return result;
}

/** Execute a single workflow step. */
async function executeStep(
  step: WorkflowStep,
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

/** Get the resolved value string from a step (the command/prompt/run content). */
function getStepValue(step: WorkflowStep): string {
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
): Promise<RunResult> {
  const metadata: RunMetadata = {
    workflow,
    input,
    startedAt,
    branch: null,
    steps: [],
    completedAt: new Date().toISOString(),
    status: "failed",
  };
  await Bun.write(join(artifactDir, "run.json"), JSON.stringify(metadata, null, 2));
  return { metadata, artifactDir };
}

interface StepContext {
  readonly input: string;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly workflowName: string;
  readonly useGit: boolean;
  readonly totalSteps: number;
  readonly stepResults: StepResult[];
  readonly stepMap: Map<string, StepResult>;
  readonly onStepStart?: (stepName: string, stepIndex: number, total: number) => void;
  readonly onStepComplete?: (stepName: string, exitCode: number, durationMs: number) => void;
  previousResult: StepResult | null;
}

/** Execute one step, record its result, and optionally git-commit. Returns "halt" if the pipeline should stop. */
async function runStep(step: WorkflowStep, ctx: StepContext): Promise<"continue" | "halt"> {
  const rawValue = getStepValue(step);
  const resolvedValue = resolveTemplates(rawValue, ctx.input, ctx.stepMap, ctx.previousResult);
  const stepIndex = ctx.stepResults.length;

  ctx.onStepStart?.(step.name, stepIndex, ctx.totalSteps);

  const startMs = Date.now();
  const { exitCode, stdout } = await executeStep(step, resolvedValue, ctx.cwd);
  const durationMs = Date.now() - startMs;

  ctx.onStepComplete?.(step.name, exitCode, durationMs);

  const result: StepResult = {
    name: step.name,
    type: step.type,
    exitCode,
    output: stdout,
    durationMs,
  };

  ctx.stepResults.push(result);
  ctx.stepMap.set(step.name, result);
  ctx.previousResult = result;

  await Bun.write(join(ctx.artifactDir, `${step.name}.out`), stdout);

  if (ctx.useGit) {
    try {
      if (await hasChanges(ctx.cwd)) {
        await commitAll(`shaka(${step.name}): ${ctx.workflowName}`, ctx.cwd);
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

/** Run all steps, guaranteeing worktree cleanup on any exit path. */
async function executeSteps(
  steps: readonly WorkflowStep[],
  ctx: StepContext,
  worktreePath: string | undefined,
  cwd: string,
): Promise<boolean> {
  let failed = false;
  try {
    for (const step of steps) {
      if ((await runStep(step, ctx)) === "halt") {
        failed = true;
        break;
      }
    }
  } catch (err) {
    failed = true;
    console.error(`Workflow execution failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    if (worktreePath) {
      try {
        await removeWorktree(worktreePath, cwd);
      } catch (err) {
        console.error(`Failed to remove worktree: ${err instanceof Error ? err.message : err}`);
        console.error(`Manual cleanup: git worktree remove ${worktreePath} --force`);
      }
    }
  }
  return failed;
}

/** Execute a workflow. */
export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const { workflow, input, cwd, shakaHome } = options;
  const runId = generateRunId();
  const artifactDir = join(shakaHome, "runs", `${workflow.name}-${runId}`);
  const startedAt = new Date().toISOString();
  const useGit = workflow.state === "git-branch";
  let branch: string | null = null;
  let worktreePath: string | undefined;

  await mkdir(artifactDir, { recursive: true });

  if (useGit) {
    branch = `shaka/run-${workflow.name}-${runId}`;
    worktreePath = join(tmpdir(), "shaka-worktrees", `run-${workflow.name}-${runId}`);
    const setup = await setupGitBranch(branch, worktreePath, cwd);
    if (setup.error) {
      console.error(setup.error);
      return failEarly(workflow.name, input, startedAt, artifactDir);
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
    stepResults: [],
    stepMap: new Map(),
    onStepStart: options.onStepStart,
    onStepComplete: options.onStepComplete,
    previousResult: null,
  };

  const failed = await executeSteps(workflow.steps, ctx, worktreePath, cwd);

  const metadata: RunMetadata = {
    workflow: workflow.name,
    input,
    startedAt,
    branch,
    steps: ctx.stepResults,
    completedAt: new Date().toISOString(),
    status: failed ? "failed" : "completed",
  };

  await Bun.write(join(artifactDir, "run.json"), JSON.stringify(metadata, null, 2));

  return { metadata, artifactDir };
}
