import { test, expect } from "bun:test";
import type { ProviderName } from "../../../src/providers/types";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildOpencodeArgs,
  runSetupInteractive,
} from "../../../src/services/setup-session";

test("buildClaudeArgs returns claude argv with positional objective and --append-system-prompt", () => {
  expect(buildClaudeArgs("make it fast", "SKILL BODY")).toEqual([
    "claude",
    "make it fast",
    "--append-system-prompt",
    "SKILL BODY",
  ]);
});

test("buildOpencodeArgs returns opencode argv with --prompt and --agent shaka/autoresearch-setup", () => {
  expect(buildOpencodeArgs("make it fast")).toEqual([
    "opencode",
    "--prompt",
    "make it fast",
    "--agent",
    "shaka/autoresearch-setup",
  ]);
});

test("buildCodexArgs prepends skill body to the objective as a single positional prompt", () => {
  expect(buildCodexArgs("make it fast", "SKILL BODY")).toEqual([
    "codex",
    "SKILL BODY\n\n## Objective\n\nmake it fast",
  ]);
});

function fakeSpawn(exitCode: number) {
  const calls: { args: string[]; opts: { cwd?: string; stdio?: unknown } }[] = [];
  const spawn = ((args: string[], opts: { cwd?: string; stdio?: unknown }) => {
    calls.push({ args, opts });
    return { exited: Promise.resolve(exitCode) } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  return { spawn, calls };
}

test("runSetupInteractive dispatches to the correct argv per provider", async () => {
  const cases: { provider: ProviderName; expected: string[] }[] = [
    { provider: "claude", expected: buildClaudeArgs("obj", "skill") },
    { provider: "opencode", expected: buildOpencodeArgs("obj") },
    { provider: "codex", expected: buildCodexArgs("obj", "skill") },
  ];
  for (const { provider, expected } of cases) {
    const { spawn, calls } = fakeSpawn(0);
    await runSetupInteractive("/tmp/wt", "obj", provider, "skill", { spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expected);
    expect(calls[0]?.opts.cwd).toBe("/tmp/wt");
    expect(calls[0]?.opts.stdio).toEqual(["inherit", "inherit", "inherit"]);
  }
});

test("runSetupInteractive returns exit code, provider, and null resume fields", async () => {
  const { spawn } = fakeSpawn(42);
  const result = await runSetupInteractive("/tmp/wt", "obj", "claude", "skill", { spawn });
  expect(result).toEqual({
    exitCode: 42,
    provider: "claude",
    resumeHint: null,
    sessionId: null,
  });
});
