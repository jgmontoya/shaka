/**
 * Command compilers for provider-native formats.
 *
 * Takes a DiscoveredCommand and produces the file content + path
 * for each provider's command format.
 */

import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { CommandFields, DiscoveredCommand } from "./command-discovery";

export interface CompiledCommand {
  /** Absolute path where this file should be written. */
  path: string;
  /** Full file content (frontmatter + body). */
  content: string;
}

/** Check if a command body contains any argument references (ignoring shell-injection blocks). */
function hasArgReferences(body: string): boolean {
  const stripped = body.replace(/!`[^`]*`/g, "");
  return /\$ARGUMENTS|\$\d+/.test(stripped);
}

/** Append $ARGUMENTS to body if no argument references are present. */
function autoAppendArguments(body: string): string {
  return hasArgReferences(body) ? body : `${body}\n\n$ARGUMENTS`;
}

/**
 * Translate 1-based positional args to 0-based for Claude Code.
 * Skips $N inside shell injection blocks (!`...`) and leaves $0 untouched.
 */
function decrementPositionalArgs(body: string): string {
  return body.replace(/!`[^`]*`|\$(\d+)/g, (match, n) => {
    if (n == null) return match; // shell injection block
    const num = Number(n);
    return num === 0 ? match : `$${num - 1}`;
  });
}

/** Build frontmatter string from key-value pairs, omitting undefined values. */
function buildFrontmatter(fields: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) filtered[key] = value;
  }
  // yaml.stringify adds a trailing newline, so trim it
  return `---\n${stringifyYaml(filtered).trimEnd()}\n---\n`;
}

/** Merge base command fields with provider-specific overrides. */
function applyOverrides(
  command: DiscoveredCommand,
  provider: "claude" | "opencode" | "codex",
): CommandFields {
  const overrides = command.providers?.[provider];
  if (!overrides) return command;
  return { ...command, ...overrides };
}

/** Compile a Shaka command to Claude Code skill format. */
export function compileForClaude(command: DiscoveredCommand, targetDir: string): CompiledCommand {
  const fields = applyOverrides(command, "claude");
  // Body is intentionally not overridable — provider overrides apply to metadata only
  const rawBody = autoAppendArguments(command.body);
  if (/\$0\b/.test(rawBody)) {
    console.error(
      `  ⚠ "${command.name}" uses $0 — Shaka positional args are 1-based ($1, $2, ...)`,
    );
  }
  const body = decrementPositionalArgs(rawBody);

  const frontmatter = buildFrontmatter({
    name: command.name,
    description: fields.description,
    "argument-hint": fields.argumentHint,
    model: fields.model,
    context: fields.subtask ? "fork" : undefined, // Claude Code uses "context: fork" for background subagents
    "user-invocable": fields.userInvocable ?? true,
  });

  return {
    path: join(targetDir, command.name, "SKILL.md"),
    content: frontmatter + body,
  };
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
 * Skips $N inside shell injection blocks (!`...`), same guard as decrementPositionalArgs.
 */
function replaceArgsWithNaturalLanguage(body: string): string {
  return body
    .replace(/!`[^`]*`|\$ARGUMENTS/g, (match) =>
      match.startsWith("!`")
        ? match
        : "Interpret the user's message after the skill name to determine the target.",
    )
    .replace(/!`[^`]*`|\$(\d+)/g, (match, n) => {
      if (n == null) return match; // shell injection block
      const num = Number(n);
      if (num === 0) return match;
      const ord = ORDINALS[num - 1] ?? `#${num}`;
      return `the ${ord} argument from the user's message`;
    });
}

/** Compile a Shaka command to Codex skill format (SKILL.md). */
export function compileForCodex(command: DiscoveredCommand, targetDir: string): CompiledCommand {
  const fields = applyOverrides(command, "codex");
  const rawBody = autoAppendArguments(command.body);
  const body = replaceArgsWithNaturalLanguage(rawBody);

  // Merge argument-hint into description for Codex skill discovery
  const description = fields.argumentHint
    ? `${fields.description}. Invoke with $${command.name} ${fields.argumentHint}`
    : fields.description;

  const frontmatter = buildFrontmatter({
    name: command.name,
    description,
  });

  return {
    path: join(targetDir, command.name, "SKILL.md"),
    content: frontmatter + body,
  };
}

/** Compile a Shaka command to opencode command format. */
export function compileForOpencode(command: DiscoveredCommand, targetDir: string): CompiledCommand {
  const fields = applyOverrides(command, "opencode");
  const body = autoAppendArguments(command.body);

  const frontmatter = buildFrontmatter({
    description: fields.description,
    model: fields.model,
    subtask: fields.subtask,
  });

  return {
    path: join(targetDir, `${command.name}.md`),
    content: frontmatter + body,
  };
}
