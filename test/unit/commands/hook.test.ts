import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHookCommand, dispatchHook } from "../../../src/commands/hook";
import { makeRunShaka } from "../../helpers/run-shaka";

const TEST_HOME = join(tmpdir(), `shaka-hook-cli-${process.pid}`);
const HOOK_COMMAND_MODULE = pathToFileURL(
  join(import.meta.dir, "../../../src/commands/hook.ts"),
).href;
const runShaka = makeRunShaka(TEST_HOME);

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(join(TEST_HOME, "system", "hooks"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("shaka hook", () => {
  test("accepts every canonical Pi event when no hook matches", () => {
    const cases = [
      ["session.start", { session_id: "session-1", provider: "pi" }],
      ["prompt.submit", { session_id: "session-1", provider: "pi", prompt: "" }],
      [
        "tool.before",
        {
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: { command: "pwd" },
        },
      ],
      [
        "tool.after",
        {
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: { command: "pwd" },
          tool_response: "ok",
          is_error: false,
        },
      ],
      [
        "session.end",
        {
          session_id: "session-1",
          provider: "pi",
          transcript_path: null,
        },
      ],
    ] as const;

    for (const [event, payload] of cases) {
      const result = runShaka(["hook", event], JSON.stringify(payload));
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    }
  });

  test("dispatches every canonical Pi event to a matching hook", async () => {
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "all-events.ts"),
      [
        "export const TRIGGER = [",
        '  "session.start",',
        '  "prompt.submit",',
        '  "tool.before",',
        '  "tool.after",',
        '  "session.end",',
        "] as const;",
        "if (import.meta.main) {",
        "  await Bun.stdin.text();",
        '  process.stdout.write("dispatched");',
        "}",
        "",
      ].join("\n"),
    );
    const cases = [
      ["session.start", { session_id: "session-1", provider: "pi" }],
      ["prompt.submit", { session_id: "session-1", provider: "pi", prompt: "hello" }],
      [
        "tool.before",
        {
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
        },
      ],
      [
        "tool.after",
        {
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
          tool_response: null,
        },
      ],
      [
        "session.end",
        {
          session_id: "session-1",
          provider: "pi",
          transcript_path: "/tmp/transcript.jsonl",
        },
      ],
    ] as const;

    for (const [event, payload] of cases) {
      const result = runShaka(["hook", event], JSON.stringify(payload));
      expect(result).toEqual({ status: 0, stdout: "dispatched", stderr: "" });
    }
  });

  test("rejects unknown events and malformed Pi payloads with exit 2", () => {
    const cases = [
      ["unknown.event", "{}"],
      ["session.start", ""],
      ["session.start", "{not json"],
      ["session.start", "[]"],
      ["session.start", JSON.stringify({ session_id: "", provider: "pi" })],
      ["session.start", JSON.stringify({ session_id: "session-1", provider: "claude" })],
      ["prompt.submit", JSON.stringify({ session_id: "session-1", provider: "pi", prompt: 42 })],
      [
        "tool.before",
        JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_input: { command: "pwd" },
        }),
      ],
      [
        "tool.before",
        JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: null,
        }),
      ],
      [
        "tool.before",
        JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: [],
        }),
      ],
      [
        "tool.after",
        JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
        }),
      ],
      [
        "tool.after",
        JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
          tool_response: "ok",
          is_error: "false",
        }),
      ],
      ["session.end", JSON.stringify({ session_id: "session-1", provider: "pi" })],
    ] as const;

    for (const [event, stdin] of cases) {
      const result = runShaka(["hook", event], stdin);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith(`shaka hook ${event}:`);
      expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
    }
  });

  test("fails closed when hook discovery cannot load a hook", async () => {
    await Bun.write(join(TEST_HOME, "system", "hooks", "broken.ts"), "export const TRIGGER = [;");

    const result = runShaka(
      ["hook", "session.start"],
      JSON.stringify({ session_id: "session-1", provider: "pi" }),
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Hook file failed to load");
    expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
  });

  test("applies customization overrides and exact tool matchers", async () => {
    const customHooks = join(TEST_HOME, "customizations", "hooks");
    await mkdir(customHooks, { recursive: true });
    const hookSource = (output: string, matcher?: readonly string[]) =>
      [
        'export const TRIGGER = ["tool.before"] as const;',
        ...(matcher ? [`export const MATCHER = ${JSON.stringify(matcher)} as const;`] : []),
        "if (import.meta.main) {",
        "  await Bun.stdin.text();",
        `  process.stdout.write(${JSON.stringify(output)});`,
        "}",
        "",
      ].join("\n");

    await Bun.write(join(TEST_HOME, "system", "hooks", "all-tools.ts"), hookSource("all tools"));
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "empty-matcher.ts"),
      hookSource("empty matcher", []),
    );
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "read-only.ts"),
      hookSource("read only", ["Read"]),
    );
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "security.ts"),
      hookSource("system security", ["Bash"]),
    );
    await Bun.write(join(customHooks, "security.ts"), hookSource("custom security", ["Bash"]));

    const result = runShaka(
      ["hook", "tool.before"],
      JSON.stringify({
        session_id: "session-1",
        provider: "pi",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      }),
    );

    expect(result).toEqual({
      status: 0,
      stdout: "all tools\n\nempty matcher\n\ncustom security",
      stderr: "",
    });
  });

  test("preserves raw stdin, cwd, environment, and an empty hook argv", async () => {
    const workDir = join(TEST_HOME, "work");
    await mkdir(workDir, { recursive: true });
    const expectedWorkDir = await realpath(workDir);
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "context.ts"),
      [
        'export const TRIGGER = ["session.start"] as const;',
        "if (import.meta.main) {",
        "  const rawInput = await Bun.stdin.text();",
        "  process.stdout.write(JSON.stringify({",
        "    rawInput,",
        "    argv: process.argv.slice(2),",
        "    cwd: process.cwd(),",
        "    shakaHome: process.env.SHAKA_HOME,",
        "    marker: process.env.PI_HOOK_TEST_MARKER,",
        "  }));",
        "}",
        "",
      ].join("\n"),
    );
    const rawInput = ' \n{"session_id":"session-1","provider":"pi"}\n';

    const result = await dispatchHook({
      event: "session.start",
      rawInput,
      cwd: workDir,
      env: {
        ...process.env,
        SHAKA_HOME: TEST_HOME,
        PI_HOOK_TEST_MARKER: "preserved",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const { cwd: observedWorkDir, ...context } = JSON.parse(result.stdout) as {
      rawInput: string;
      argv: string[];
      cwd: string;
      shakaHome: string | undefined;
      marker: string | undefined;
    };
    expect(await realpath(observedWorkDir)).toBe(expectedWorkDir);
    expect(context).toEqual({
      rawInput,
      argv: [],
      shakaHome: TEST_HOME,
      marker: "preserved",
    });
  });

  test("runs matching hooks by filename and then absolute path", async () => {
    const result = await dispatchHook(
      {
        event: "session.start",
        rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
        cwd: "/work",
        env: { SHAKA_HOME: TEST_HOME },
      },
      {
        discoverHooks: async () => [
          {
            filename: "z-last.ts",
            event: "session.start",
            path: "/hooks/z-last.ts",
          },
          {
            filename: "a-first.ts",
            event: "session.start",
            path: "/hooks/z-second.ts",
          },
          {
            filename: "a-first.ts",
            event: "session.start",
            path: "/hooks/a-first.ts",
          },
        ],
        now: () => 0,
        runProcess: async (path) => ({
          state: "completed",
          exitCode: 0,
          stdout: path,
          stderr: "",
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "/hooks/a-first.ts\n\n/hooks/z-second.ts\n\n/hooks/z-last.ts",
      stderr: "",
    });
  });

  test("buffers ordered output and continues after advisory hook exits", async () => {
    const results = new Map([
      [
        "/hooks/a.ts",
        {
          state: "completed" as const,
          exitCode: 1,
          stdout: " first \n",
          stderr: "warning a\n",
        },
      ],
      [
        "/hooks/b.ts",
        {
          state: "completed" as const,
          exitCode: 7,
          stdout: " \n",
          stderr: "warning b\n",
        },
      ],
      [
        "/hooks/c.ts",
        {
          state: "completed" as const,
          exitCode: 0,
          stdout: "third\n\n",
          stderr: "warning c",
        },
      ],
    ]);
    const result = await dispatchHook(
      {
        event: "session.start",
        rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
        cwd: "/work",
        env: { SHAKA_HOME: TEST_HOME },
      },
      {
        discoverHooks: async () =>
          ["a", "b", "c"].map((name) => ({
            filename: `${name}.ts`,
            event: "session.start" as const,
            path: `/hooks/${name}.ts`,
          })),
        now: () => 0,
        runProcess: async (path) => {
          const result = results.get(path);
          if (!result) throw new Error(`missing result for ${path}`);
          return result;
        },
      },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "first\n\nthird",
      stderr: "warning a\nwarning b\nwarning c",
    });
  });

  test("stops after the first hook that exits 2", async () => {
    const result = await dispatchHook(
      {
        event: "tool.before",
        rawInput: JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
        }),
        cwd: "/work",
        env: { SHAKA_HOME: TEST_HOME },
      },
      {
        discoverHooks: async () =>
          ["a-before", "b-block", "c-after"].map((name) => ({
            filename: `${name}.ts`,
            event: "tool.before" as const,
            path: `/hooks/${name}.ts`,
          })),
        now: () => 0,
        runProcess: async (path) => ({
          state: "completed",
          exitCode: path.includes("b-block") ? 2 : 0,
          stdout: path,
          stderr: path.includes("b-block") ? "blocked" : "",
        }),
      },
    );

    expect(result).toEqual({
      exitCode: 2,
      stdout: "/hooks/a-before.ts\n\n/hooks/b-block.ts",
      stderr: "blocked",
    });
  });

  test("fails closed for spawn, timeout, and signal runner states", async () => {
    const states = ["spawn-error", "timed-out", "signaled"] as const;

    for (const state of states) {
      const result = await dispatchHook(
        {
          event: "tool.before",
          rawInput: JSON.stringify({
            session_id: "session-1",
            provider: "pi",
            tool_name: "Bash",
            tool_input: "pwd",
          }),
          cwd: "/work",
          env: { SHAKA_HOME: TEST_HOME },
        },
        {
          discoverHooks: async () => [
            {
              filename: "security.ts",
              event: "tool.before",
              path: "/hooks/security.ts",
            },
          ],
          now: () => 0,
          runProcess: async () => ({
            state,
            stderr: `${state} failure`,
          }),
        },
      );

      expect(result).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `shaka hook tool.before: ${state} failure`,
      });
    }
  });

  test("does not start a hook after discovery consumes the command deadline", async () => {
    let clockRead = 0;
    const result = await dispatchHook(
      {
        event: "session.start",
        rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
        cwd: "/work",
        env: { SHAKA_HOME: TEST_HOME },
      },
      {
        discoverHooks: async () => [
          {
            filename: "context.ts",
            event: "session.start",
            path: "/hooks/context.ts",
          },
        ],
        now: () => (clockRead++ === 0 ? 0 : 25_000),
        runProcess: async () => {
          throw new Error("hook should not start");
        },
      },
    );

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "shaka hook session.start: command deadline expired during hook discovery",
    });
  });

  test("shares one deadline across sequential hooks", async () => {
    let now = 0;
    const receivedBudgets: number[] = [];
    const result = await dispatchHook(
      {
        event: "session.start",
        rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
        cwd: "/work",
        env: { SHAKA_HOME: TEST_HOME },
      },
      {
        discoverHooks: async () =>
          ["a", "b"].map((name) => ({
            filename: `${name}.ts`,
            event: "session.start" as const,
            path: `/hooks/${name}.ts`,
          })),
        now: () => now,
        runProcess: async (_path, _rawInput, options) => {
          receivedBudgets.push(options.timeoutMs);
          now += 10_000;
          return {
            state: "completed",
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(receivedBudgets).toEqual([25_000, 15_000]);
  });

  test("fails closed when stdin remains open past the command deadline", async () => {
    const runnerPath = join(TEST_HOME, "hook-command-runner.ts");
    await Bun.write(
      runnerPath,
      [
        `import { createHookCommand } from ${JSON.stringify(HOOK_COMMAND_MODULE)};`,
        'await createHookCommand({ timeoutMs: 100 }).parseAsync(["session.start"], { from: "user" });',
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", runnerPath], {
      cwd: process.cwd(),
      env: { ...process.env, SHAKA_HOME: TEST_HOME },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ session_id: "session-1", provider: "pi" }));
    await child.stdin.flush();
    const completion = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    try {
      const result = await settleWithin(
        completion,
        2_000,
        "hook command did not enforce its stdin deadline",
      );

      const [exitCode, stdout, stderr] = result;
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toBe("shaka hook session.start: command deadline expired while reading stdin");
    } finally {
      try {
        child.stdin.end();
      } catch {
        // The command may have closed its stdin pipe after timing out.
      }
      if (child.exitCode === null) child.kill();
      await child.exited;
      await Promise.allSettled([completion]);
    }
  });

  test("exits promptly when stdin reaches EOF", async () => {
    const runnerPath = join(TEST_HOME, "hook-command-runner.ts");
    await Bun.write(
      runnerPath,
      [
        `import { createHookCommand } from ${JSON.stringify(HOOK_COMMAND_MODULE)};`,
        'await createHookCommand({ timeoutMs: 2_000 }).parseAsync(["session.start"], { from: "user" });',
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", runnerPath], {
      cwd: process.cwd(),
      env: { ...process.env, SHAKA_HOME: TEST_HOME },
      stdin: new Blob([JSON.stringify({ session_id: "session-1", provider: "pi" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const completion = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    try {
      const result = await settleWithin(
        completion,
        2_000,
        "hook command retained its stdin deadline after EOF",
      );

      expect(result).toEqual([0, "", ""]);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await Promise.allSettled([completion]);
    }
  });

  test("shares one deadline across stdin acquisition and hook execution", async () => {
    await Bun.write(
      join(TEST_HOME, "system", "hooks", "slow.ts"),
      [
        'export const TRIGGER = ["session.start"] as const;',
        "if (import.meta.main) {",
        "  await Bun.stdin.text();",
        "  await Bun.sleep(10_000);",
        "}",
        "",
      ].join("\n"),
    );
    const runnerPath = join(TEST_HOME, "hook-command-runner.ts");
    await Bun.write(
      runnerPath,
      [
        `import { createHookCommand } from ${JSON.stringify(HOOK_COMMAND_MODULE)};`,
        "let clockRead = 0;",
        "const now = () => (clockRead++ === 0 ? 0 : 1_800);",
        'await createHookCommand({ timeoutMs: 2_000, now }).parseAsync(["session.start"], { from: "user" });',
        "",
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", runnerPath], {
      cwd: process.cwd(),
      env: { ...process.env, SHAKA_HOME: TEST_HOME },
      stdin: new Blob([JSON.stringify({ session_id: "session-1", provider: "pi" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const completion = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    try {
      const result = await settleWithin(
        completion,
        2_000,
        "hook command granted dispatch a fresh deadline",
      );

      const [exitCode, stdout, stderr] = result;
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      const timeout = stderr.match(/^shaka hook session\.start: Hook timed out after ([\d.]+)ms$/);
      expect(timeout).not.toBeNull();
      expect(Number(timeout?.[1])).toBeGreaterThan(0);
      expect(Number(timeout?.[1])).toBeLessThanOrEqual(200);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      await Promise.allSettled([completion]);
    }
  });

  test("rejects invalid internal command deadlines", () => {
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => createHookCommand({ timeoutMs })).toThrow(
        "hook command timeoutMs must be a positive finite number",
      );
    }
  });

  test("fails closed when a hook exceeds the stdout capture limit", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-stdout-limit-"));
    try {
      const hooksDir = join(testHome, "system", "hooks");
      await mkdir(hooksDir, { recursive: true });
      await Bun.write(
        join(hooksDir, "noisy.ts"),
        [
          'export const TRIGGER = ["session.start"] as const;',
          "if (import.meta.main) {",
          '  process.stdout.write("x".repeat(1_048_577));',
          "}",
          "",
        ].join("\n"),
      );

      const result = await dispatchHook({
        event: "session.start",
        rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
        cwd: process.cwd(),
        env: { ...process.env, SHAKA_HOME: testHome },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("stdout exceeded");
    } finally {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  test("fails closed when a blocking hook exceeds the stderr capture limit", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-stderr-limit-"));
    try {
      const hooksDir = join(testHome, "system", "hooks");
      await mkdir(hooksDir, { recursive: true });
      await Bun.write(
        join(hooksDir, "noisy-block.ts"),
        [
          'export const TRIGGER = ["tool.before"] as const;',
          "if (import.meta.main) {",
          '  await Bun.write(Bun.stderr, "x".repeat(1_048_577));',
          "  process.exitCode = 2;",
          "}",
          "",
        ].join("\n"),
      );

      const result = await dispatchHook({
        event: "tool.before",
        rawInput: JSON.stringify({
          session_id: "session-1",
          provider: "pi",
          tool_name: "Bash",
          tool_input: "pwd",
        }),
        cwd: process.cwd(),
        env: { ...process.env, SHAKA_HOME: testHome },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("stderr exceeded");
      expect(result.stderr.length).toBeLessThan(1024);
    } finally {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  test("fails closed when combined output from sequential hooks exceeds the capture limit", async () => {
    const hooks = ["a", "b"].map((name) => ({
      filename: `${name}.ts`,
      event: "session.start" as const,
      path: `/hooks/${name}.ts`,
    }));
    const largeOutput = "x".repeat(600 * 1024);

    for (const stream of ["stdout", "stderr"] as const) {
      const result = await dispatchHook(
        {
          event: "session.start",
          rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
          cwd: "/work",
          env: { SHAKA_HOME: TEST_HOME },
        },
        {
          discoverHooks: async () => hooks,
          now: () => 0,
          runProcess: async () => ({
            state: "completed",
            exitCode: 0,
            stdout: stream === "stdout" ? largeOutput : "",
            stderr: stream === "stderr" ? largeOutput : "",
          }),
        },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${stream} exceeded`);
      expect(result.stderr.length).toBeLessThan(1024);
    }
  });

  test.skipIf(process.platform === "win32")(
    "kills an active hook when it exceeds the output capture limit",
    async () => {
      const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-output-kill-"));
      const hooksDir = join(testHome, "system", "hooks");
      const pidPath = join(testHome, "hook.pid");
      let pid: number | undefined;
      try {
        await mkdir(hooksDir, { recursive: true });
        await Bun.write(
          join(hooksDir, "noisy-and-slow.ts"),
          [
            'export const TRIGGER = ["session.start"] as const;',
            "if (import.meta.main) {",
            `  await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));`,
            '  process.stdout.write("x".repeat(1_048_577));',
            "  await Bun.sleep(10_000);",
            "}",
            "",
          ].join("\n"),
        );

        const result = await dispatchHook(
          {
            event: "session.start",
            rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
            cwd: process.cwd(),
            env: { ...process.env, SHAKA_HOME: testHome },
          },
          { timeoutMs: 1_000 },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("stdout exceeded");
        pid = Number(await Bun.file(pidPath).text());
        expect(() => process.kill(pid as number, 0)).toThrow();
      } finally {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The expected path already killed the hook.
          }
        }
        await rm(testHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "kills an active hook when the command deadline expires",
    async () => {
      const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-timeout-"));
      const hooksDir = join(testHome, "system", "hooks");
      const pidPath = join(testHome, "hook.pid");
      try {
        await mkdir(hooksDir, { recursive: true });
        await Bun.write(
          join(hooksDir, "slow.ts"),
          [
            'export const TRIGGER = ["session.start"] as const;',
            "if (import.meta.main) {",
            `  await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));`,
            "  await Bun.sleep(10_000);",
            "}",
            "",
          ].join("\n"),
        );

        const result = await dispatchHook(
          {
            event: "session.start",
            rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
            cwd: process.cwd(),
            env: { ...process.env, SHAKA_HOME: testHome },
          },
          { timeoutMs: 150 },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("timed out");
        const pid = Number(await Bun.file(pidPath).text());
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await rm(testHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "settles when a hook descendant retains the output pipes",
    async () => {
      const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-retained-pipe-"));
      const hooksDir = join(testHome, "system", "hooks");
      const descendantPidPath = join(testHome, "descendant.pid");
      let descendantPid: number | undefined;
      try {
        await mkdir(hooksDir, { recursive: true });
        await Bun.write(
          join(hooksDir, "retained-pipe.ts"),
          [
            'export const TRIGGER = ["session.start"] as const;',
            "if (import.meta.main) {",
            "  const child = Bun.spawn([",
            '    "bun",',
            '    "-e",',
            `    ${JSON.stringify(
              `await Bun.write(${JSON.stringify(descendantPidPath)}, String(process.pid)); await Bun.sleep(10_000);`,
            )},`,
            "  ], {",
            '    stdin: "ignore",',
            '    stdout: "inherit",',
            '    stderr: "inherit",',
            "  });",
            "  child.unref();",
            "}",
            "",
          ].join("\n"),
        );

        const result = await dispatchHook(
          {
            event: "session.start",
            rawInput: JSON.stringify({ session_id: "session-1", provider: "pi" }),
            cwd: process.cwd(),
            env: { ...process.env, SHAKA_HOME: testHome },
          },
          { timeoutMs: 200 },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("timed out");
        descendantPid = Number(await Bun.file(descendantPidPath).text());
        expect(() => process.kill(descendantPid as number, 0)).not.toThrow();
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The descendant may have exited between the assertion and cleanup.
          }
        }
        await rm(testHome, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "fails closed when a hook terminates from a signal",
    async () => {
      const testHome = await mkdtemp(join(tmpdir(), "shaka-hook-signal-"));
      const hooksDir = join(testHome, "system", "hooks");
      try {
        await mkdir(hooksDir, { recursive: true });
        await Bun.write(
          join(hooksDir, "signaled.ts"),
          [
            'export const TRIGGER = ["tool.before"] as const;',
            "if (import.meta.main) {",
            '  process.kill(process.pid, "SIGTERM");',
            "}",
            "",
          ].join("\n"),
        );

        const result = await dispatchHook({
          event: "tool.before",
          rawInput: JSON.stringify({
            session_id: "session-1",
            provider: "pi",
            tool_name: "Bash",
            tool_input: "pwd",
          }),
          cwd: process.cwd(),
          env: { ...process.env, SHAKA_HOME: testHome },
        });

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("SIGTERM");
      } finally {
        await rm(testHome, { recursive: true, force: true });
      }
    },
  );
});
