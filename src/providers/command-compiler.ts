/**
 * Provider-neutral command rendering helpers.
 *
 * Provider modules own their native command formats. This file keeps the
 * shared mechanics: frontmatter rendering, provider metadata overrides, and
 * argument-reference transformations used by more than one provider.
 */

import { stringify as stringifyYaml } from "yaml";
import type { CommandFields, DiscoveredCommand } from "./command-discovery";
import type { ProviderName } from "./types";

export interface CompiledCommand {
  /** Absolute path where this file should be written. */
  path: string;
  /** Full file content (frontmatter + body). */
  content: string;
}

function hasArgReferences(body: string): boolean {
  const stripped = body.replace(/!`[^`]*`/g, "");
  return /\$ARGUMENTS|\$\d+/.test(stripped);
}

export function autoAppendArguments(body: string): string {
  return hasArgReferences(body) ? body : `${body}\n\n$ARGUMENTS`;
}

/**
 * Translate 1-based positional args to 0-based for Claude Code.
 * Skips $N inside shell injection blocks (!`...`) and leaves $0 untouched.
 */
export function decrementPositionalArgs(body: string): string {
  return body.replace(/!`[^`]*`|\$(\d+)/g, (match, n) => {
    if (n === undefined) return match;
    const num = Number(n);
    return num === 0 ? match : `$${num - 1}`;
  });
}

export function buildFrontmatter(fields: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) filtered[key] = value;
  }
  return `---\n${stringifyYaml(filtered).trimEnd()}\n---\n`;
}

export function applyOverrides(command: DiscoveredCommand, provider: ProviderName): CommandFields {
  const overrides = command.providers?.[provider];
  if (!overrides) return command;
  return { ...command, ...overrides };
}

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
];

/**
 * Replace $ARGUMENTS and positional $N with natural-language descriptions.
 * Skips $N inside shell injection blocks (!`...`), same guard as
 * decrementPositionalArgs.
 */
export function replaceArgsWithNaturalLanguage(body: string): string {
  return body
    .replace(/!`[^`]*`|\$ARGUMENTS/g, (match) =>
      match.startsWith("!`")
        ? match
        : "Interpret the user's message after the skill name to determine the target.",
    )
    .replace(/!`[^`]*`|\$(\d+)/g, (match, n) => {
      if (n === undefined) return match;
      const num = Number(n);
      if (num === 0) return match;
      const ord = ORDINALS[num - 1] ?? `#${num}`;
      return `the ${ord} argument from the user's message`;
    });
}
