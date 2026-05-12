import { test, expect } from "bun:test";
import type { ProviderName } from "../../../src/providers/types";
import {
  type SetupOneshotDeps,
  buildClaudeArgs,
  buildCodexArgs,
  buildOpencodeArgs,
  buildPiArgs,
  runSetupInteractive,
  runSetupOneshot,
} from "../../../src/services/setup-session";

type FakeRunAgent = NonNullable<SetupOneshotDeps["runAgent"]>;

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
    { provider: "opencode", expected: buildOpencodeArgs("obj") },
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
  }) as unknown as FakeRunAgent;

  const result = await runSetupOneshot("/tmp/wt", "make it fast", "claude", "SKILL BODY CONTENT", {
    runAgent: fakeRunAgent,
  });

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

test("runSetupOneshot forces the selected provider via DetectedProviders override", async () => {
  // Regression guard: without the override, runAgentStep falls back to
  // detectInstalledProviders() and can silently pick a different backend.
  // Using a non-claude provider makes an unforced routing bug observable —
  // the captured DetectedProviders should have exactly one true flag.
  const captured: {
    detected?: { claude: boolean; opencode: boolean; codex: boolean; pi: boolean };
  }[] = [];
  const fakeRunAgent = (async (
    _opts: { prompt: string; cwd?: string; timeout?: number },
    detected?: { claude: boolean; opencode: boolean; codex: boolean; pi: boolean },
  ) => {
    captured.push({ detected });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      provider: "codex" as const,
      timedOut: false,
    };
  }) as unknown as FakeRunAgent;

  await runSetupOneshot("/tmp/wt", "obj", "codex", "skill", { runAgent: fakeRunAgent });

  expect(captured[0]?.detected).toEqual({ claude: false, opencode: false, codex: true, pi: false });
});
