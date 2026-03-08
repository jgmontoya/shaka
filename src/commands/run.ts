/**
 * CLI handler for `shaka run <workflow> [input...]`.
 * Discovers workflows, validates CWD scoping, and executes the runner.
 */

import { isAbsolute, relative } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import type { Workflow } from "../domain/workflow";
import { discoverWorkflows } from "../providers/workflow-discovery";
import type { RunResult } from "../services/workflow-runner";
import { runWorkflow } from "../services/workflow-runner";

function getShakaHome(): string {
  return resolveShakaHome({
    SHAKA_HOME: process.env.SHAKA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  });
}

/** Check if a path is within any of the allowed CWD paths. */
export function isCwdAllowed(cwd: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowed) => {
    const rel = relative(allowed, cwd);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/** Resolve the named workflow or exit with an error. */
async function resolveWorkflow(shakaHome: string, name: string): Promise<Workflow> {
  const { workflows, errors } = await discoverWorkflows(shakaHome);

  for (const err of errors) {
    console.error(`Warning: ${err.name}: ${err.error}`);
  }

  const workflow = workflows.find((w) => w.name === name);
  if (!workflow) {
    const available = workflows.map((w) => w.name);
    console.error(`Workflow "${name}" not found.`);
    if (available.length > 0) {
      console.error(`Available workflows: ${available.join(", ")}`);
    } else {
      console.error("No workflows found. Create one in customizations/workflows/.");
    }
    process.exit(1);
  }

  return workflow;
}

/** Print run result summary. */
function printSummary({ metadata, artifactDir }: RunResult): void {
  console.log("");
  const iterInfo =
    metadata.totalIterations > 1
      ? ` (${metadata.completedIterations}/${metadata.totalIterations} iterations)`
      : "";
  console.log(`Status: ${metadata.status}${iterInfo}`);
  if (metadata.branch) console.log(`Branch: ${metadata.branch}`);
  console.log(`Artifacts: ${artifactDir}`);

  for (const step of metadata.steps) {
    const icon = step.exitCode === 0 ? "✓" : "✗";
    const iterPrefix = metadata.totalIterations > 1 ? `[iter ${step.iteration}] ` : "";
    console.log(`  ${icon} ${iterPrefix}${step.name} (${step.durationMs}ms)`);
  }
}

export function createRunCommand(): Command {
  return new Command("run")
    .description("Execute a workflow")
    .argument("<workflow>", "Workflow name")
    .argument("[input...]", "Input arguments")
    .option("--loop <count>", "Override the workflow loop count", (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error("--loop must be a positive integer");
      return n;
    })
    .action(async (workflowName: string, inputParts: string[], opts: { loop?: number }) => {
      const shakaHome = getShakaHome();
      const cwd = process.cwd();
      const input = inputParts.join(" ");

      let workflow = await resolveWorkflow(shakaHome, workflowName);

      if (opts.loop != null) {
        workflow = { ...workflow, loop: opts.loop };
      }

      if (workflow.cwd && !isCwdAllowed(cwd, workflow.cwd)) {
        console.error(`Workflow "${workflowName}" is scoped to: ${workflow.cwd.join(", ")}`);
        console.error(`Current directory: ${cwd}`);
        process.exit(1);
      }

      console.log(`Running workflow: ${workflow.name}`);
      if (input) console.log(`Input: ${input}`);
      if (workflow.loop > 1) console.log(`Loop: ${workflow.loop} iterations`);
      console.log("");

      const result = await runWorkflow({
        workflow,
        input,
        cwd,
        shakaHome,
        onStepStart: (name, index, total, loopIteration, loopTotal) => {
          const iterPrefix = loopTotal > 1 ? `[iter ${loopIteration}/${loopTotal}] ` : "";
          console.log(`${iterPrefix}[${index + 1}/${total}] Running step: ${name}...`);
        },
        onStepComplete: (name, exitCode, durationMs) => {
          const icon = exitCode === 0 ? "✓" : "✗";
          console.log(`  ${icon} ${name} completed (${durationMs}ms)`);
        },
      });
      printSummary(result);

      if (result.metadata.status === "failed") {
        process.exit(1);
      }
    });
}
