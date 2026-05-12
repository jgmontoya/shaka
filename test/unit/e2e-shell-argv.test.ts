import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseShellWords } from "../e2e/lib/shell-argv";

const CLI = join(import.meta.dir, "..", "e2e", "lib", "shell-argv.ts");

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("e2e shell argv parser", () => {
  test("preserves single-quoted paths with spaces", () => {
    expect(parseShellWords("bun '/tmp/shaka home/system/hooks/session-start.ts'")).toEqual([
      "bun",
      "/tmp/shaka home/system/hooks/session-start.ts",
    ]);
  });

  test("preserves single quotes encoded with POSIX close-escape-open quoting", () => {
    expect(parseShellWords("bun '/tmp/O'\\''Brien/system/hooks/session-start.ts'")).toEqual([
      "bun",
      "/tmp/O'Brien/system/hooks/session-start.ts",
    ]);
  });

  test("does not evaluate command substitutions while tokenizing", () => {
    expect(parseShellWords("bun '/tmp/hook.ts' '$(printf SHOULD_NOT_RUN)'")).toEqual([
      "bun",
      "/tmp/hook.ts",
      "$(printf SHOULD_NOT_RUN)",
    ]);
  });

  test("rejects unmatched quotes instead of guessing", () => {
    expect(() => parseShellWords("bun '/tmp/hook.ts")).toThrow("unterminated single quote");
  });

  test("CLI extracts an indexed argument for Claude hook commands", async () => {
    const result = await runCli([
      "--index",
      "1",
      "bun '/tmp/shaka home/system/hooks/session-start.ts'",
    ]);

    expect(result).toEqual({
      stdout: "/tmp/shaka home/system/hooks/session-start.ts",
      stderr: "",
      exitCode: 0,
    });
  });

  test("CLI extracts the final argument for Codex wrapper commands", async () => {
    const result = await runCli([
      "--last",
      "bun '/tmp/codex home/shaka-hook-wrapper.ts' SessionStart '/tmp/shaka home/system/hooks/session-start.ts'",
    ]);

    expect(result).toEqual({
      stdout: "/tmp/shaka home/system/hooks/session-start.ts",
      stderr: "",
      exitCode: 0,
    });
  });
});
