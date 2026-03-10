/**
 * Workflow domain types.
 * Defines the structure of workflows parsed from .yaml/.yml files
 * and their execution results.
 */

// ---------------------------------------------------------------------------
// Workflow definition (parsed from .yaml/.yml file)
// ---------------------------------------------------------------------------

export interface Workflow {
  readonly name: string;
  readonly description: string;
  readonly state: "git-branch" | "none";
  readonly steps: readonly WorkflowStep[];
  readonly loop: number;
  readonly cwd?: readonly string[];
  readonly sourcePath: string;
}

export interface CommandStep {
  readonly type: "command";
  readonly name: string;
  readonly command: string;
  readonly allowFailure?: boolean;
}

export interface PromptStep {
  readonly type: "prompt";
  readonly name: string;
  readonly prompt: string;
  readonly allowFailure?: boolean;
}

export interface RunStep {
  readonly type: "run";
  readonly name: string;
  readonly run: string;
  readonly allowFailure?: boolean;
}

export interface GroupStep {
  readonly type: "group";
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly loop: number;
  readonly allowFailure?: boolean;
}

export type WorkflowStep = CommandStep | PromptStep | RunStep | GroupStep;

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export interface StepResult {
  readonly name: string;
  readonly type: WorkflowStep["type"];
  readonly exitCode: number;
  readonly output: string;
  readonly durationMs: number;
  readonly iteration: number;
}

export interface RunMetadata {
  readonly workflow: string;
  readonly input: string;
  readonly startedAt: string;
  readonly branch: string | null;
  readonly steps: StepResult[];
  readonly totalIterations: number;
  readonly completedIterations: number;
  readonly completedAt: string;
  readonly status: "completed" | "failed";
}
