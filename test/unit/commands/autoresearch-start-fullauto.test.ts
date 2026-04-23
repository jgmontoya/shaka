/**
 * Full-auto default-path tests for `shaka autoresearch start`:
 *  - happy path commits setup and enters the loop
 *  - validation failure exits without entering the loop
 *  - --dry-run skips commit and loop on validation pass
 *
 * Uses DI (`runSetupInteractive`, `runLoop`) to stand in for the real
 * provider-CLI handoff; validation runs for real against the artifacts the
 * fake setup writes. That's the observable outcome we assert.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart } from "../../../src/commands/autoresearch";
import type { DetectedProviders } from "../../../src/services/provider-detection";

async function sh(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (exit ${code}): ${stderr}`);
}

interface Env {
  readonly parent: string;
  readonly repo: string;
  readonly cleanup: () => Promise<void>;
}

async function makeRepoEnv(label: string): Promise<Env> {
  const parent = join(
    tmpdir(),
    `shaka-fullauto-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const repo = join(parent, "repo");
  await mkdir(repo, { recursive: true });
  await sh(["git", "init", "-q", "-b", "main"], repo);
  await sh(["git", "config", "user.email", "t@t"], repo);
  await sh(["git", "config", "user.name", "t"], repo);
  await Bun.write(join(repo, ".gitkeep"), "");
  await sh(["git", "add", "-A"], repo);
  await sh(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
  return {
    parent,
    repo,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const CLAUDE_ONLY: DetectedProviders = { claude: true, opencode: false, codex: false };

function swapIsTTY(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  };
}

function writeValidSetup(worktreePath: string): () => Promise<void> {
  return async () => {
    await Bun.write(
      join(worktreePath, "autoresearch.md"),
      [
        "# Test objective",
        "",
        "## Metric",
        "- command: ./autoresearch.sh",
        "- direction: minimize",
        "- unit: s",
        "",
      ].join("\n"),
    );
    const shPath = join(worktreePath, "autoresearch.sh");
    await Bun.write(
      shPath,
      "#!/bin/sh\necho \"METRIC name=stub value=1.0 unit=s\"\n",
    );
    await chmod(shPath, 0o755);
  };
}

function writeInvalidSetup(worktreePath: string): () => Promise<void> {
  // autoresearch.sh emits no METRIC line — fails validation at `benchmark` phase.
  return async () => {
    await Bun.write(
      join(worktreePath, "autoresearch.md"),
      [
        "# Broken objective",
        "",
        "## Metric",
        "- command: ./autoresearch.sh",
        "- direction: minimize",
        "- unit: s",
        "",
      ].join("\n"),
    );
    const shPath = join(worktreePath, "autoresearch.sh");
    await Bun.write(shPath, "#!/bin/sh\necho \"nothing useful here\"\n");
    await chmod(shPath, 0o755);
  };
}

async function gitLogCount(cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", "rev-list", "--count", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return Number(out.trim());
}

async function lastCommitSubject(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "log", "-1", "--format=%s"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out.trim();
}

// Skipped on Windows: validation runs ./autoresearch.sh directly via the
// shebang line, which requires Unix exec semantics. Mirrors the feature's
// runtime shape.
describe.skipIf(process.platform === "win32")("autoresearch start — full-auto default path", () => {
  const envs: Env[] = [];

  afterEach(async () => {
    for (const e of envs.splice(0)) await e.cleanup();
    process.exitCode = 0;
  });

  test("full-auto happy path commits setup and enters the loop", async () => {
    const env = await makeRepoEnv("happy");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(true);
    const loopCalls: Array<{ cwd: string }> = [];
    try {
      process.chdir(env.repo);
      await runStart(
        "happy objective",
        { wizard: false, dryRun: false },
        {
          detectProviders: () => CLAUDE_ONLY,
          runSetupInteractive: async (worktreePath, _objective, provider, _skill) => {
            await writeValidSetup(worktreePath)();
            return { exitCode: 0, provider, resumeHint: null, sessionId: null };
          },
          runLoop: async (args) => {
            loopCalls.push({ cwd: args.cwd });
          },
        },
      );

      const worktree = join(env.parent, "repo.ar-happy-objective");
      expect(await Bun.file(join(worktree, "autoresearch.md")).exists()).toBe(true);
      expect(await Bun.file(join(worktree, "autoresearch.sh")).exists()).toBe(true);

      // Setup got committed.
      const subject = await lastCommitSubject(worktree);
      expect(subject).toBe("autoresearch: finalize agent-generated setup");

      // Loop was invoked with the worktree cwd.
      expect(loopCalls.length).toBe(1);
      expect(await realpath(loopCalls[0]?.cwd ?? "")).toBe(await realpath(worktree));
    } finally {
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("full-auto validation failure exits without entering the loop", async () => {
    const env = await makeRepoEnv("invalid");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(true);
    const loopCalls: Array<{ cwd: string }> = [];

    const realExit = process.exit;
    const realErr = console.error;
    const exitCalls: number[] = [];
    const errLines: string[] = [];
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCalls.push(typeof code === "number" ? code : 0);
      throw new Error(`__stub_exit__:${code ?? 0}`);
    }) as typeof process.exit;
    console.error = (...args: unknown[]): void => {
      errLines.push(args.map(String).join(" "));
    };

    try {
      process.chdir(env.repo);
      await expect(
        runStart(
          "invalid objective",
          { wizard: false, dryRun: false },
          {
            detectProviders: () => CLAUDE_ONLY,
            runSetupInteractive: async (worktreePath, _objective, provider, _skill) => {
              await writeInvalidSetup(worktreePath)();
              return { exitCode: 0, provider, resumeHint: null, sessionId: null };
            },
            runLoop: async (args) => {
              loopCalls.push({ cwd: args.cwd });
            },
          },
        ),
      ).rejects.toThrow(/__stub_exit__:1/);

      // Loop never ran.
      expect(loopCalls.length).toBe(0);

      const combined = errLines.join("\n");
      // Error names the failing phase.
      expect(combined.toLowerCase()).toMatch(/benchmark|metric/);
      expect(exitCalls).toContain(1);
    } finally {
      process.exit = realExit;
      console.error = realErr;
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("--oneshot bypasses the non-TTY guard and commits + enters loop on valid setup", async () => {
    const env = await makeRepoEnv("oneshot");
    envs.push(env);
    const oldCwd = process.cwd();
    // isTTY=false — the point of --oneshot is to work in non-TTY contexts.
    const restoreTTY = swapIsTTY(false);
    const loopCalls: Array<{ cwd: string }> = [];
    const oneshotCalls: Array<{ worktreePath: string; objective: string }> = [];
    const interactiveCalls: number[] = [];
    try {
      process.chdir(env.repo);
      await runStart(
        "oneshot objective",
        { wizard: false, dryRun: false, oneshot: true },
        {
          detectProviders: () => CLAUDE_ONLY,
          runSetupInteractive: async (_worktreePath, _objective, provider, _skill) => {
            interactiveCalls.push(1);
            return { exitCode: 0, provider, resumeHint: null, sessionId: null };
          },
          runSetupOneshot: async (worktreePath, objective, provider, _skill) => {
            oneshotCalls.push({ worktreePath, objective });
            await writeValidSetup(worktreePath)();
            return { exitCode: 0, provider, resumeHint: null, sessionId: null };
          },
          runLoop: async (args) => {
            loopCalls.push({ cwd: args.cwd });
          },
        },
      );

      // Oneshot ran; interactive didn't.
      expect(oneshotCalls.length).toBe(1);
      expect(interactiveCalls.length).toBe(0);
      expect(oneshotCalls[0]?.objective).toBe("oneshot objective");

      const worktree = join(env.parent, "repo.ar-oneshot-objective");
      expect(await Bun.file(join(worktree, "autoresearch.md")).exists()).toBe(true);
      expect(await Bun.file(join(worktree, "autoresearch.sh")).exists()).toBe(true);

      // Setup got committed with the agent-generated message.
      const subject = await lastCommitSubject(worktree);
      expect(subject).toBe("autoresearch: finalize agent-generated setup");

      // Loop was invoked with the worktree cwd.
      expect(loopCalls.length).toBe(1);
      expect(await realpath(loopCalls[0]?.cwd ?? "")).toBe(await realpath(worktree));
    } finally {
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("--oneshot without any provider installed errors as in default", async () => {
    const env = await makeRepoEnv("oneshot-noprov");
    envs.push(env);
    const oldCwd = process.cwd();
    // isTTY=false — irrelevant for this path (oneshot bypasses the TTY guard),
    // but we set it explicitly to confirm the no-provider guard still fires.
    const restoreTTY = swapIsTTY(false);

    const realExit = process.exit;
    const realErr = console.error;
    const exitCalls: number[] = [];
    const errLines: string[] = [];
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCalls.push(typeof code === "number" ? code : 0);
      throw new Error(`__stub_exit__:${code ?? 0}`);
    }) as typeof process.exit;
    console.error = (...args: unknown[]): void => {
      errLines.push(args.map(String).join(" "));
    };

    try {
      process.chdir(env.repo);
      await expect(
        runStart(
          "oneshot objective",
          { wizard: false, dryRun: false, oneshot: true },
          {
            detectProviders: () => ({ claude: false, opencode: false, codex: false }),
          },
        ),
      ).rejects.toThrow(/__stub_exit__:1/);

      const combined = errLines.join("\n");
      // Same message as the default path: names --wizard and `shaka init`.
      expect(combined).toMatch(/--wizard/);
      expect(combined).toMatch(/shaka init/);
      expect(exitCalls).toContain(1);
    } finally {
      process.exit = realExit;
      console.error = realErr;
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("--dry-run skips commit and loop on validation pass", async () => {
    const env = await makeRepoEnv("dry");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(true);
    const loopCalls: Array<{ cwd: string }> = [];
    const logLines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      logLines.push(args.map(String).join(" "));
    };
    try {
      process.chdir(env.repo);
      const worktree = join(env.parent, "repo.ar-dry-objective");

      await runStart(
        "dry objective",
        { wizard: false, dryRun: true },
        {
          detectProviders: () => CLAUDE_ONLY,
          runSetupInteractive: async (worktreePath, _objective, provider, _skill) => {
            await writeValidSetup(worktreePath)();
            return { exitCode: 0, provider, resumeHint: null, sessionId: null };
          },
          runLoop: async (args) => {
            loopCalls.push({ cwd: args.cwd });
          },
        },
      );

      // No commit created: HEAD count identical to the pre-worktree root
      // commit only. `git worktree add` doesn't add commits on its own, so
      // a clean dry-run flow leaves exactly 1 commit in the worktree history.
      expect(await gitLogCount(worktree)).toBe(1);

      // Loop never ran.
      expect(loopCalls.length).toBe(0);

      // stdout mentions the worktree path so the user can find it.
      const combined = logLines.join("\n");
      expect(combined).toContain(worktree);
    } finally {
      console.log = realLog;
      restoreTTY();
      process.chdir(oldCwd);
    }
  });
});
