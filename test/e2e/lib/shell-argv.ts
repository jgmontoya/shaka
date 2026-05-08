/**
 * Quote-aware, non-evaluating tokenizer for the generated hook command strings
 * Shaka writes into provider config files. It handles the shell word subset
 * produced by `shellQuotePosix()` without running expansions such as `$(...)`,
 * backticks, or `$VAR`.
 */
export function parseShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (isWhitespace(ch)) {
      if (tokenStarted) {
        words.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (ch === "'") {
      const segment = readSingleQuoted(input, i + 1);
      tokenStarted = true;
      current += segment.text;
      i = segment.nextIndex;
      continue;
    }

    if (ch === '"') {
      const segment = readDoubleQuoted(input, i + 1);
      tokenStarted = true;
      current += segment.text;
      i = segment.nextIndex;
      continue;
    }

    if (ch === "\\") {
      const next = readEscaped(input, i);
      tokenStarted = true;
      current += next.text;
      i = next.nextIndex;
      continue;
    }

    tokenStarted = true;
    current += ch;
  }

  if (tokenStarted) words.push(current);
  return words;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function readSingleQuoted(input: string, startIndex: number): { text: string; nextIndex: number } {
  const endIndex = input.indexOf("'", startIndex);
  if (endIndex === -1) throw new Error("unterminated single quote");
  return { text: input.slice(startIndex, endIndex), nextIndex: endIndex };
}

function readDoubleQuoted(input: string, startIndex: number): { text: string; nextIndex: number } {
  let text = "";
  for (let i = startIndex; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') return { text, nextIndex: i };
    if (ch === "\\") {
      const escaped = readDoubleQuotedEscape(input, i);
      text += escaped.text;
      i = escaped.nextIndex;
    } else {
      text += ch;
    }
  }
  throw new Error("unterminated double quote");
}

function readDoubleQuotedEscape(
  input: string,
  backslashIndex: number,
): { text: string; nextIndex: number } {
  const next = input[backslashIndex + 1];
  if (next === undefined) throw new Error("trailing escape in double-quoted string");
  if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
    return { text: next, nextIndex: backslashIndex + 1 };
  }
  return { text: "\\", nextIndex: backslashIndex };
}

function readEscaped(input: string, backslashIndex: number): { text: string; nextIndex: number } {
  const next = input[backslashIndex + 1];
  if (next === undefined) throw new Error("trailing escape");
  return { text: next, nextIndex: backslashIndex + 1 };
}

function usage(): string {
  return "Usage: bun test/e2e/lib/shell-argv.ts (--index N|--last) <command>";
}

type CliSelection = { command: string; index: number | "last" };
type CliParseResult = { ok: true; value: CliSelection } | { ok: false };

function parseCliArgs(args: string[]): CliParseResult {
  if (args[0] === "--index") {
    const index = Number(args[1]);
    const command = args[2];
    if (!Number.isInteger(index) || index < 0 || command === undefined || args.length !== 3) {
      return { ok: false };
    }
    return { ok: true, value: { command, index } };
  }
  if (args[0] === "--last" && args[1] !== undefined && args.length === 2) {
    return { ok: true, value: { command: args[1], index: "last" } };
  }
  return { ok: false };
}

function main(args: string[]): number {
  const parsed = parseCliArgs(args);
  if (!parsed.ok) {
    console.error(usage());
    return 2;
  }
  try {
    const { command, index } = parsed.value;
    const words = parseShellWords(command);
    const value = index === "last" ? words.at(-1) : words[index];
    if (value === undefined) {
      console.error(
        `No argv entry found for ${index === "last" ? "last index" : `index ${index}`}`,
      );
      return 1;
    }
    process.stdout.write(value);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
