/**
 * Workflow discovery for workflow .yaml files.
 * Scans system/workflows/ and customizations/workflows/ for .yaml files,
 * validates them, and returns discovered workflows + errors.
 *
 * Follows the same override pattern as command-discovery: customizations
 * take precedence over system by filename match.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeCwd } from "../domain/paths";
import type { Workflow, WorkflowStep } from "../domain/workflow";

/** Valid workflow name: lowercase alphanumeric with hyphens, no leading/trailing hyphens, max 64 chars. */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = new Set(["shaka"]);

const VALID_STATES = new Set(["git-branch", "none"]);
const STEP_TYPE_KEYS = ["command", "prompt", "run"] as const;

export interface WorkflowError {
  name: string;
  sourcePath: string;
  error: string;
}

export interface WorkflowDiscoveryResult {
  workflows: Workflow[];
  errors: WorkflowError[];
}

/** Discover workflows from system/ and customizations/, with override filtering. */
export async function discoverWorkflows(shakaHome: string): Promise<WorkflowDiscoveryResult> {
  const merged = await mergeWorkflowFiles(shakaHome);
  const workflows: Workflow[] = [];
  const errors: WorkflowError[] = [];

  for (const { filename, dir } of merged) {
    const name = nameFromFilename(filename);
    const result = await parseWorkflowFile(name, join(dir, filename));
    if ("error" in result) {
      errors.push(result);
    } else {
      workflows.push(result);
    }
  }

  return { workflows, errors };
}

/** Merge system and customization workflow files, with customization override. */
async function mergeWorkflowFiles(
  shakaHome: string,
): Promise<Array<{ filename: string; dir: string }>> {
  const systemDir = join(shakaHome, "system", "workflows");
  const customDir = join(shakaHome, "customizations", "workflows");

  const systemFiles = await listWorkflowFiles(systemDir);
  const customFiles = await listWorkflowFiles(customDir);

  const byName = new Map<string, { filename: string; dir: string }>();

  for (const f of systemFiles) {
    byName.set(nameFromFilename(f), { filename: f, dir: systemDir });
  }
  for (const f of customFiles) {
    byName.set(nameFromFilename(f), { filename: f, dir: customDir });
  }

  return [...byName.values()];
}

/** Parse and validate a single workflow file. */
async function parseWorkflowFile(
  name: string,
  sourcePath: string,
): Promise<Workflow | WorkflowError> {
  const nameError = validateName(name);
  if (nameError) return { name, sourcePath, error: nameError };

  let raw: string;
  try {
    raw = await Bun.file(sourcePath).text();
  } catch {
    return { name, sourcePath, error: "Failed to read workflow file" };
  }

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { name, sourcePath, error: "Invalid YAML — expected a mapping" };
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    return { name, sourcePath, error: "Invalid YAML syntax" };
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || !description.trim()) {
    return { name, sourcePath, error: "Missing required field: description" };
  }

  const state = frontmatter.state ?? "git-branch";
  if (typeof state !== "string" || !VALID_STATES.has(state)) {
    return {
      name,
      sourcePath,
      error: `Invalid state "${state}" — must be "git-branch" or "none"`,
    };
  }

  const rawSteps = frontmatter.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { name, sourcePath, error: "Missing required field: steps (must be a non-empty array)" };
  }

  const stepsResult = validateSteps(rawSteps);
  if (typeof stepsResult === "string") {
    return { name, sourcePath, error: stepsResult };
  }

  const cwd = normalizeCwd(frontmatter.cwd);

  return {
    name,
    description: description.trim(),
    state: state as "git-branch" | "none",
    steps: stepsResult,
    cwd,
    sourcePath,
  };
}

/** Validate a single raw step object. Returns parsed step or error string. */
function validateSingleStep(
  raw: unknown,
  index: number,
  seenNames: Set<string>,
): WorkflowStep | string {
  if (!raw || typeof raw !== "object") {
    return `Step ${index + 1}: must be an object`;
  }

  const step = raw as Record<string, unknown>;
  const stepName = step.name;
  if (typeof stepName !== "string" || !stepName.trim()) {
    return `Step ${index + 1}: missing required field "name"`;
  }
  if (!NAME_PATTERN.test(stepName)) {
    return `Step ${index + 1}: invalid name "${stepName}" — must be lowercase alphanumeric with hyphens (no leading/trailing hyphens)`;
  }

  if (seenNames.has(stepName)) {
    return `Step ${index + 1}: duplicate step name "${stepName}"`;
  }
  seenNames.add(stepName);

  const typeKeys = STEP_TYPE_KEYS.filter((k) => k in step);
  if (typeKeys.length !== 1) {
    const detail = typeKeys.length > 1 ? ` (found: ${typeKeys.join(", ")})` : "";
    return `Step "${stepName}": must have exactly one of: command, prompt, run${detail}`;
  }

  const typeKey: string = typeKeys[0] as string;
  const typeValue = step[typeKey];
  if (typeof typeValue !== "string" || !typeValue.trim()) {
    return `Step "${stepName}": "${typeKey}" must be a non-empty string`;
  }

  const allowFailure = step["allow-failure"] === true ? true : undefined;

  return buildStep(typeKey, stepName, typeValue, allowFailure);
}

/** Build a typed WorkflowStep from validated fields. */
function buildStep(
  typeKey: string,
  name: string,
  value: string,
  allowFailure: true | undefined,
): WorkflowStep {
  switch (typeKey) {
    case "command":
      return { type: "command", name, command: value, allowFailure };
    case "prompt":
      return { type: "prompt", name, prompt: value, allowFailure };
    default:
      return { type: "run", name, run: value, allowFailure };
  }
}

/** Validate and parse the steps array. Returns parsed steps or an error string. */
function validateSteps(rawSteps: unknown[]): WorkflowStep[] | string {
  const steps: WorkflowStep[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < rawSteps.length; i++) {
    const result = validateSingleStep(rawSteps[i], i, seenNames);
    if (typeof result === "string") return result;
    steps.push(result);
  }

  return steps;
}

function nameFromFilename(filename: string): string {
  return filename.replace(/\.ya?ml$/, "");
}

function validateName(name: string): string | null {
  if (RESERVED_NAMES.has(name)) {
    return `Reserved workflow name "${name}"`;
  }
  if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    return `Invalid workflow name "${name}" — must match [a-z0-9], no leading/trailing hyphens, max 64 chars`;
  }
  return null;
}

async function listWorkflowFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".yaml") || e.endsWith(".yml")).sort();
  } catch {
    return [];
  }
}
