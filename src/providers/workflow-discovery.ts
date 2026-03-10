/**
 * Workflow discovery for workflow .yaml files.
 * Scans system/workflows/ and customizations/workflows/ for .yaml files,
 * validates them, and returns discovered workflows + errors.
 *
 * Follows the same override pattern as command-discovery: customizations
 * take precedence over system by filename match.
 *
 * Step parsing supports four forms:
 *   - Leaf steps: { name, command|prompt|run }
 *   - Leaf steps with loop: { name, command|prompt|run, loop: N } → normalized to GroupStep
 *   - Inline groups: { name, steps: [...], loop?: N }
 *   - Workflow references: { name, workflow: "other-name" } → resolved in a second pass
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeCwd } from "../domain/paths";
import type { GroupStep, Workflow, WorkflowStep } from "../domain/workflow";

/** Valid workflow name: lowercase alphanumeric with hyphens, no leading/trailing hyphens, max 64 chars. */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 64;
const RESERVED_NAMES = new Set(["shaka"]);

const VALID_STATES = new Set(["git-branch", "none"]);
const LEAF_TYPE_KEYS = ["command", "prompt", "run"] as const;

export interface WorkflowError {
  name: string;
  sourcePath: string;
  error: string;
}

export interface WorkflowDiscoveryResult {
  workflows: Workflow[];
  errors: WorkflowError[];
}

// ---------------------------------------------------------------------------
// Temporary marker for unresolved workflow references (never leaves discovery)
// ---------------------------------------------------------------------------

interface WorkflowRef {
  readonly type: "workflow-ref";
  readonly name: string;
  readonly workflowName: string;
  readonly allowFailure?: boolean;
}

type ParsedStep = WorkflowStep | WorkflowRef;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Discover workflows from system/ and customizations/, with override filtering. */
export async function discoverWorkflows(shakaHome: string): Promise<WorkflowDiscoveryResult> {
  const merged = await mergeWorkflowFiles(shakaHome);
  const workflows: Workflow[] = [];
  const errors: WorkflowError[] = [];

  // Pass 1: parse all files (workflow references remain as WorkflowRef markers)
  const unresolved = new Map<string, Workflow>();

  for (const { filename, dir } of merged) {
    const name = nameFromFilename(filename);
    const result = await parseWorkflowFile(name, join(dir, filename));
    if ("error" in result) {
      errors.push(result);
    } else {
      unresolved.set(name, result);
    }
  }

  // Pass 2: resolve workflow references recursively with cycle detection
  const resolved = new Map<string, Workflow>();

  for (const [name, workflow] of unresolved) {
    if (resolved.has(name)) continue;
    resolveWorkflow(name, workflow, unresolved, resolved, new Set(), errors);
  }

  for (const workflow of resolved.values()) {
    workflows.push(workflow);
  }

  return { workflows, errors };
}

// ---------------------------------------------------------------------------
// Reference resolution (pass 2)
// ---------------------------------------------------------------------------

/** Resolve a workflow and all its transitive references. Populates `resolved` on success, `errors` on failure. */
function resolveWorkflow(
  name: string,
  workflow: Workflow,
  unresolved: Map<string, Workflow>,
  resolved: Map<string, Workflow>,
  visiting: Set<string>,
  errors: WorkflowError[],
): boolean {
  if (resolved.has(name)) return true;

  visiting.add(name);

  const resolvedSteps: WorkflowStep[] = [];
  for (const step of workflow.steps) {
    const ref = step as ParsedStep;
    if (ref.type !== "workflow-ref") {
      resolvedSteps.push(step);
      continue;
    }

    const result = resolveRef(ref, unresolved, resolved, visiting, errors);
    if (typeof result === "string") {
      errors.push({ name, sourcePath: workflow.sourcePath, error: result });
      visiting.delete(name);
      return false;
    }
    resolvedSteps.push(result);
  }

  visiting.delete(name);
  resolved.set(name, { ...workflow, steps: resolvedSteps });
  return true;
}

/** Resolve a single WorkflowRef into a GroupStep, recursively resolving the target first if needed. */
function resolveRef(
  ref: WorkflowRef,
  unresolved: Map<string, Workflow>,
  resolved: Map<string, Workflow>,
  visiting: Set<string>,
  errors: WorkflowError[],
): GroupStep | string {
  if (visiting.has(ref.workflowName)) {
    return `Step "${ref.name}": circular reference to workflow "${ref.workflowName}"`;
  }

  // Resolve the target first if it hasn't been resolved yet
  if (!resolved.has(ref.workflowName)) {
    const target = unresolved.get(ref.workflowName);
    if (!target) {
      return `Step "${ref.name}": workflow "${ref.workflowName}" not found`;
    }
    if (!resolveWorkflow(ref.workflowName, target, unresolved, resolved, visiting, errors)) {
      return `Step "${ref.name}": workflow "${ref.workflowName}" failed to resolve`;
    }
  }

  const target = resolved.get(ref.workflowName);
  if (!target) {
    return `Step "${ref.name}": workflow "${ref.workflowName}" failed to resolve`;
  }
  return {
    type: "group",
    name: ref.name,
    steps: target.steps,
    loop: target.loop,
    allowFailure: ref.allowFailure,
  };
}

// ---------------------------------------------------------------------------
// File merging
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Workflow file parsing
// ---------------------------------------------------------------------------

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

  const rawLoop = frontmatter.loop ?? 1;
  const loopError = validateLoop(rawLoop);
  if (loopError) return { name, sourcePath, error: loopError };
  const loop = rawLoop as number;

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
    steps: stepsResult as WorkflowStep[],
    loop,
    cwd,
    sourcePath,
  };
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

/** Validate common step fields (name, uniqueness). Returns error string or validated name. */
function validateStepIdentity(
  raw: unknown,
  index: number,
  seenNames: Set<string>,
): { step: Record<string, unknown>; name: string } | string {
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

  return { step, name: stepName };
}

/** Parse a workflow reference step: { name, workflow: "other-name" } */
function parseWorkflowRef(
  step: Record<string, unknown>,
  name: string,
  allowFailure: true | undefined,
): WorkflowRef | string {
  const workflowName = step.workflow;
  if (typeof workflowName !== "string" || !workflowName.trim()) {
    return `Step "${name}": "workflow" must be a non-empty string`;
  }
  return { type: "workflow-ref", name, workflowName, allowFailure };
}

/** Parse an inline group step: { name, steps: [...], loop?: N } */
function parseInlineGroup(
  step: Record<string, unknown>,
  name: string,
  allowFailure: true | undefined,
): GroupStep | string {
  const rawSubSteps = step.steps;
  if (!Array.isArray(rawSubSteps) || rawSubSteps.length === 0) {
    return `Step "${name}": "steps" must be a non-empty array`;
  }
  const subStepsResult = validateSteps(rawSubSteps);
  if (typeof subStepsResult === "string") {
    return `Step "${name}" > ${subStepsResult}`;
  }
  if (subStepsResult.some((s) => (s as ParsedStep).type === "workflow-ref")) {
    return `Step "${name}": inline groups cannot contain workflow references`;
  }
  const rawLoop = step.loop ?? 1;
  const loopErr = validateLoop(rawLoop);
  if (loopErr) return `Step "${name}": ${loopErr}`;
  return {
    type: "group",
    name,
    steps: subStepsResult as WorkflowStep[],
    loop: rawLoop as number,
    allowFailure,
  };
}

/** Parse a leaf step (command/prompt/run), optionally wrapping in a GroupStep when loop is set. */
function parseLeafStep(
  step: Record<string, unknown>,
  name: string,
  allowFailure: true | undefined,
): ParsedStep | string {
  const typeKeys = LEAF_TYPE_KEYS.filter((k) => k in step);
  if (typeKeys.length !== 1) {
    const detail = typeKeys.length > 1 ? ` (found: ${typeKeys.join(", ")})` : "";
    return `Step "${name}": must have exactly one of: command, prompt, run${detail}`;
  }

  const typeKey: string = typeKeys[0] as string;
  const typeValue = step[typeKey];
  if (typeof typeValue !== "string" || !typeValue.trim()) {
    return `Step "${name}": "${typeKey}" must be a non-empty string`;
  }

  const leaf = buildLeafStep(typeKey, name, typeValue, allowFailure);

  // Leaf with loop > 1 → normalize to single-step GroupStep
  if ("loop" in step && step.loop != null) {
    const loopErr = validateLoop(step.loop);
    if (loopErr) return `Step "${name}": ${loopErr}`;
    if ((step.loop as number) > 1) {
      return { type: "group", name, steps: [leaf], loop: step.loop as number, allowFailure };
    }
  }

  return leaf;
}

/** Validate a single raw step object. Returns parsed step or error string. */
function validateSingleStep(
  raw: unknown,
  index: number,
  seenNames: Set<string>,
): ParsedStep | string {
  const identity = validateStepIdentity(raw, index, seenNames);
  if (typeof identity === "string") return identity;

  const { step, name } = identity;
  const allowFailure = step["allow-failure"] === true ? true : undefined;

  const leafKeys = LEAF_TYPE_KEYS.filter((k) => k in step);
  const formCount =
    Number("workflow" in step) + Number("steps" in step) + Number(leafKeys.length > 0);
  if (formCount !== 1) {
    return `Step "${name}": must have exactly one of: workflow, steps, command, prompt, run`;
  }

  if ("workflow" in step) return parseWorkflowRef(step, name, allowFailure);
  if ("steps" in step) return parseInlineGroup(step, name, allowFailure);
  return parseLeafStep(step, name, allowFailure);
}

/** Build a typed leaf WorkflowStep from validated fields. */
function buildLeafStep(
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
function validateSteps(rawSteps: unknown[]): ParsedStep[] | string {
  const steps: ParsedStep[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < rawSteps.length; i++) {
    const result = validateSingleStep(rawSteps[i], i, seenNames);
    if (typeof result === "string") return result;
    steps.push(result);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nameFromFilename(filename: string): string {
  return filename.replace(/\.ya?ml$/, "");
}

function validateLoop(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return `Invalid loop "${value}" — must be a positive integer`;
  }
  return null;
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
