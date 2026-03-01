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
  console.log(`Status: ${metadata.status}`);
  if (metadata.branch) console.log(`Branch: ${metadata.branch}`);
  console.log(`Artifacts: ${artifactDir}`);

  for (const step of metadata.steps) {
    const icon = step.exitCode === 0 ? "✓" : "✗";
    console.log(`  ${icon} ${step.name} (${step.durationMs}ms)`);
  }
}

export function createRunCommand(): Command {
  return new Command("run")
    .description("Execute a workflow")
    .argument("<workflow>", "Workflow name")
    .argument("[input...]", "Input arguments")
    .action(async (workflowName: string, inputParts: string[]) => {
      const shakaHome = getShakaHome();
      const cwd = process.cwd();
      const input = inputParts.join(" ");

      const workflow = await resolveWorkflow(shakaHome, workflowName);

      if (workflow.cwd && !isCwdAllowed(cwd, workflow.cwd)) {
        console.error(`Workflow "${workflowName}" is scoped to: ${workflow.cwd.join(", ")}`);
        console.error(`Current directory: ${cwd}`);
        process.exit(1);
      }

      console.log(`Running workflow: ${workflow.name}`);
      if (input) console.log(`Input: ${input}`);
      console.log("");

      const result = await runWorkflow({
        workflow,
        input,
        cwd,
        shakaHome,
        onStepStart: (name, index, total) => {
          console.log(`[${index + 1}/${total}] Running step: ${name}...`);
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
