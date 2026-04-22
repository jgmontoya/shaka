import { test, expect } from "bun:test";
import type { ProviderName } from "../../../src/providers/types";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildOpencodeArgs,
  runSetupInteractive,
  runSetupOneshot,
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

test("runSetupOneshot composes prompt with skill body, objective, and the no-user directive", async () => {
  const captured: { prompt?: string; cwd?: string; timeout?: number }[] = [];
  const fakeRunAgent = (async (opts: {
    prompt: string;
    cwd?: string;
    timeout?: number;
  }) => {
    captured.push({ prompt: opts.prompt, cwd: opts.cwd, timeout: opts.timeout });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      provider: "claude" as const,
      timedOut: false,
    };
  }) as unknown as Parameters<typeof runSetupOneshot>[4] extends infer D
    ? D extends { readonly runAgent?: infer F }
      ? F
      : never
    : never;

  const result = await runSetupOneshot(
    "/tmp/wt",
    "make it fast",
    "claude",
    "SKILL BODY CONTENT",
    { runAgent: fakeRunAgent },
  );

  expect(captured).toHaveLength(1);
  const prompt = captured[0]?.prompt ?? "";
  expect(prompt).toContain("SKILL BODY CONTENT");
  expect(prompt).toContain("make it fast");
  expect(prompt).toContain("do NOT have a user to ask");
  expect(captured[0]?.cwd).toBe("/tmp/wt");

  expect(result).toEqual({
    exitCode: 0,
    provider: "claude",
    resumeHint: null,
    sessionId: null,
  });
});
