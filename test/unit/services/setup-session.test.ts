import { expect, test } from "bun:test";
import type { ProcessInvocation, ProcessResult } from "../../../src/platform/process-runner";
import { DEFAULT_SETUP_TIMEOUT_MS } from "../../../src/providers/setup-defaults";
import type { ProviderName } from "../../../src/providers/types";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildOpencodeArgs,
  buildPiArgs,
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

test("buildOpencodeArgs returns opencode argv with worktree path and setup agent name", () => {
  expect(buildOpencodeArgs("make it fast", "/tmp/wt")).toEqual([
    "opencode",
    "/tmp/wt",
    "--prompt",
    "make it fast",
    "--agent",
    "autoresearch-setup",
  ]);
});

test("buildCodexArgs prepends skill body to the objective as a single positional prompt", () => {
  expect(buildCodexArgs("make it fast", "SKILL BODY")).toEqual([
    "codex",
    "SKILL BODY\n\n## Objective\n\nmake it fast",
  ]);
});

test("buildPiArgs pins anthropic provider/model and appends the setup skill via --append-system-prompt", () => {
  // Pi defaults to google (Exp 42). Setup must pin Anthropic, append the
  // setup skill on top of Pi's default coding-assistant prompt, and pass the
  // objective as the positional initial-prompt slot. The `--` separator
  // before the objective shields prompts that start with `-` (e.g. YAML
  // frontmatter, Markdown lists) from yargs flag-misparse — see
  // memory/feedback_argv_prompts_need_double_dash.md.
  expect(buildPiArgs("make it fast", "SKILL BODY")).toEqual([
    "pi",
    "--provider",
    "anthropic",
    "--model",
    "anthropic/claude-sonnet-4-5",
    "--append-system-prompt",
    "SKILL BODY",
    "--",
    "make it fast",
  ]);
});

test("buildPiArgs places `--` before objectives that start with `-` so they aren't parsed as flags", () => {
  // Concrete regression — without `--`, an objective like `--foo` would
  // be interpreted as an unknown Pi flag and the runner would error.
  const args = buildPiArgs("--foo bar", "skill");
  const sep = args.indexOf("--");
  const obj = args.indexOf("--foo bar");
  expect(sep).toBeGreaterThan(0);
  expect(obj).toBeGreaterThan(sep);
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
    { provider: "opencode", expected: buildOpencodeArgs("obj", "/tmp/wt") },
    { provider: "codex", expected: buildCodexArgs("obj", "skill") },
    { provider: "pi", expected: buildPiArgs("obj", "skill") },
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
  const captured: ProcessInvocation[] = [];
  const runProcess = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    captured.push(invocation);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };

  const result = await runSetupOneshot("/tmp/wt", "make it fast", "claude", "SKILL BODY CONTENT", {
    runProcess,
  });

  expect(captured).toHaveLength(1);
  const prompt = captured[0]?.stdin ?? "";
  expect(prompt).toContain("SKILL BODY CONTENT");
  expect(prompt).toContain("make it fast");
  expect(prompt).toContain("do NOT have a user to ask");
  expect(captured[0]?.command).toBe("claude");
  expect(captured[0]?.args).toEqual(["-p"]);
  expect(captured[0]?.cwd).toBe("/tmp/wt");
  expect(captured[0]?.timeout).toBe(DEFAULT_SETUP_TIMEOUT_MS);

  expect(result).toEqual({
    exitCode: 0,
    provider: "claude",
    resumeHint: null,
    sessionId: null,
  });
});

test("runSetupOneshot dispatches directly to the selected provider setup capability", async () => {
  const captured: ProcessInvocation[] = [];
  const runProcess = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    captured.push(invocation);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };

  const result = await runSetupOneshot("/tmp/wt", "obj", "codex", "skill", { runProcess });

  expect(captured).toHaveLength(1);
  expect(captured[0]?.command).toBe("codex");
  expect(captured[0]?.args?.slice(0, 2)).toEqual(["exec", "--full-auto"]);
  expect(result.provider).toBe("codex");
});

test("runSetupOneshot routes opencode setup through its setup agent and explicit worktree dir", async () => {
  const captured: ProcessInvocation[] = [];
  const runProcess = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
    captured.push(invocation);
    return { exitCode: 0, stdout: "created setup files", stderr: "", timedOut: false };
  };
  const result = await runSetupOneshot("/tmp/wt", "make it fast", "opencode", "SKILL BODY", {
    runProcess,
  });

  expect(captured).toHaveLength(1);
  expect(captured[0]?.command).toBe("opencode");
  const args = captured[0]?.args ?? [];
  expect(args.slice(0, 6)).toEqual([
    "run",
    "--dir",
    "/tmp/wt",
    "--agent",
    "autoresearch-setup",
    "--",
  ]);
  expect(args).toHaveLength(7);
  expect(args[6]).toContain("SKILL BODY");
  expect(args[6]).toContain("make it fast");
  expect(captured[0]?.cwd).toBe("/tmp/wt");
  expect(captured[0]?.timeout).toBe(DEFAULT_SETUP_TIMEOUT_MS);
  expect(result).toEqual({
    exitCode: 0,
    provider: "opencode",
    resumeHint: null,
    sessionId: null,
    stdout: "created setup files",
  });
});
