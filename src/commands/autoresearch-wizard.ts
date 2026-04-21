/**
 * Interactive setup wizard for `shaka autoresearch start`.
 *
 * Pure over an injected `ask` boundary so tests drive it deterministically
 * without spawning a subprocess or touching `node:readline`. Production wires
 * `ask` to a readline reader; tests inject scripted responses.
 */

import * as readline from "node:readline/promises";
import type { Direction, WizardAnswers } from "../services/autoresearch";

export type Ask = (question: string, defaultValue?: string) => Promise<string>;

export interface WizardInput {
  readonly objective: string;
  readonly ask: Ask;
}

/** Ask `question` until the answer is non-empty (after trim). */
async function askRequired(ask: Ask, question: string): Promise<string> {
  for (;;) {
    const raw = (await ask(question)).trim();
    if (raw.length > 0) return raw;
  }
}

/** Normalize direction input. Invalid values return null so callers can reprompt. */
function parseDirection(raw: string): Direction | null {
  const value = raw.trim().toLowerCase();
  if (value === "maximize") return "maximize";
  if (value === "minimize") return "minimize";
  return null;
}

async function askDirection(ask: Ask): Promise<Direction> {
  let prompt = "Direction [minimize]: ";
  for (;;) {
    const parsed = parseDirection(await ask(prompt, "minimize"));
    if (parsed !== null) return parsed;
    prompt = "Direction must be 'minimize' or 'maximize'. Direction [minimize]: ";
  }
}

function parseUnit(raw: string): string | null {
  const unit = raw.trim() || "ms";
  return /^[A-Za-z0-9_.%/+:-]+$/.test(unit) ? unit : null;
}

async function askUnit(ask: Ask): Promise<string> {
  let prompt = "Metric unit [ms]: ";
  for (;;) {
    const parsed = parseUnit(await ask(prompt, "ms"));
    if (parsed !== null) return parsed;
    prompt = "Metric unit must be a single token. Metric unit [ms]: ";
  }
}

export async function runWizard(input: WizardInput): Promise<WizardAnswers> {
  const { ask, objective } = input;

  const benchmarkCommand = await askRequired(
    ask,
    "Benchmark command (runs your experiment and prints METRIC on stdout): ",
  );
  const direction = await askDirection(ask);
  const unit = await askUnit(ask);
  const checksCommand = (await ask("Correctness check command (empty to skip): ")).trim();
  const filesInScope = (await ask("Files in scope (comma-separated, empty to skip): ")).trim();
  const constraints = (await ask("Constraints (empty to skip): ")).trim();

  return {
    objective,
    benchmarkCommand,
    direction,
    unit,
    checksCommand,
    filesInScope,
    constraints,
  };
}

/**
 * Build a production `Ask` backed by `node:readline/promises`. The default
 * value is returned for blank answers only; callers are responsible for
 * including any visible default text in the prompt.
 */
export function readlineAsk(): { ask: Ask; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, defaultValue) => {
    const answer = await rl.question(question);
    return answer === "" && defaultValue !== undefined ? defaultValue : answer;
  };
  return { ask, close: () => rl.close() };
}
