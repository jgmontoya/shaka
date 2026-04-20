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

/** Normalize free-form direction input. Any value other than "maximize" collapses to minimize. */
function parseDirection(raw: string): Direction {
  return raw.trim().toLowerCase() === "maximize" ? "maximize" : "minimize";
}

export async function runWizard(input: WizardInput): Promise<WizardAnswers> {
  const { ask, objective } = input;

  const benchmarkCommand = await askRequired(
    ask,
    "Benchmark command (runs your experiment and prints METRIC on stdout): ",
  );
  const direction = parseDirection(await ask("Direction [minimize]: ", "minimize"));
  const unit = (await ask("Metric unit [ms]: ", "ms")).trim() || "ms";
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
 * value is appended as `[default]` suffix in the visible prompt only — the
 * caller is still responsible for passing it through so blank answers can be
 * substituted.
 */
export function readlineAsk(): { ask: Ask; close: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (question, defaultValue) => {
    const answer = await rl.question(question);
    return answer === "" && defaultValue !== undefined ? defaultValue : answer;
  };
  return { ask, close: () => rl.close() };
}
