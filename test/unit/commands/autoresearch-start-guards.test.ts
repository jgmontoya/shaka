/**
 * Guard-path tests for `shaka autoresearch start`:
 *  - --wizard + --dry-run conflict is rejected at arg-parse time
 *  - non-TTY without --wizard exits 1 with an actionable error naming --wizard
 *  - no-provider-installed without --wizard exits 1 naming --wizard and `shaka init`
 *  - --wizard preserves the existing wizard behavior (regression sentinel)
 *
 * System boundaries (process.exit, process.stdin.isTTY, console.error) are
 * spied/swapped using the save/restore pattern already established in
 * `autoresearch.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoresearchCommand, runStart } from "../../../src/commands/autoresearch";
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
  readonly dir: string;
  readonly repo: string;
  readonly cleanup: () => Promise<void>;
}

async function makeRepoEnv(label: string): Promise<Env> {
  const parent = join(
    tmpdir(),
    `shaka-start-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    dir: parent,
    repo,
    cleanup: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const NONE: DetectedProviders = { claude: false, opencode: false, codex: false };
const CLAUDE_ONLY: DetectedProviders = { claude: true, opencode: false, codex: false };

function spyExitAndErr(): {
  readonly restore: () => void;
  readonly exitCalls: number[];
  readonly errLines: string[];
} {
  const realExit = process.exit;
  const realErr = console.error;
  const exitCalls: number[] = [];
  const errLines: string[] = [];
  process.exit = ((code?: string | number | null | undefined): never => {
    exitCalls.push(typeof code === "number" ? code : 0);
    // Throw so execution short-circuits as it would in production.
    throw new Error(`__stub_exit__:${code ?? 0}`);
  }) as typeof process.exit;
  console.error = (...args: unknown[]): void => {
    errLines.push(args.map(String).join(" "));
  };
  return {
    exitCalls,
    errLines,
    restore: () => {
      process.exit = realExit;
      console.error = realErr;
    },
  };
}

function swapIsTTY(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      // Inherit the original undefined by deleting the override we installed.
      delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  };
}

describe("autoresearch start — flag parsing", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("--wizard --dry-run rejects with an explanatory error", async () => {
    const cmd = createAutoresearchCommand();
    // Commander rejects conflicting options via addConflict or action-time check.
    // Either way, we observe via exitOverride so we can capture the thrown error.
    cmd.exitOverride();
    for (const sub of cmd.commands) sub.exitOverride();

    await expect(
      cmd.parseAsync(["start", "test objective", "--wizard", "--dry-run"], { from: "user" }),
    ).rejects.toThrow(/--dry-run.*--wizard|--wizard.*--dry-run/i);
  });

  test("--oneshot --wizard rejects with an explanatory error", async () => {
    const cmd = createAutoresearchCommand();
    cmd.exitOverride();
    for (const sub of cmd.commands) sub.exitOverride();

    await expect(
      cmd.parseAsync(["start", "test objective", "--oneshot", "--wizard"], { from: "user" }),
    ).rejects.toThrow(/--oneshot.*--wizard|--wizard.*--oneshot/i);
  });
});

describe("autoresearch start — runStart guard paths", () => {
  const envs: Env[] = [];

  afterEach(async () => {
    for (const e of envs.splice(0)) await e.cleanup();
    process.exitCode = 0;
  });

  test("non-TTY without --wizard errors with an actionable message naming --wizard", async () => {
    const env = await makeRepoEnv("nontty");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(false);
    const spies = spyExitAndErr();
    try {
      process.chdir(env.repo);
      await expect(
        runStart(
          "make it faster",
          { wizard: false, dryRun: false },
          { detectProviders: () => CLAUDE_ONLY },
        ),
      ).rejects.toThrow(/__stub_exit__:1/);

      const combined = spies.errLines.join("\n");
      expect(combined).toMatch(/--wizard/);
      expect(combined.toLowerCase()).toMatch(/tty/);
      expect(spies.exitCalls).toContain(1);
    } finally {
      spies.restore();
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("no-provider without --wizard errors naming --wizard and `shaka init`", async () => {
    const env = await makeRepoEnv("noprov");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(true);
    const spies = spyExitAndErr();
    try {
      process.chdir(env.repo);
      await expect(
        runStart(
          "make it faster",
          { wizard: false, dryRun: false },
          { detectProviders: () => NONE },
        ),
      ).rejects.toThrow(/__stub_exit__:1/);

      const combined = spies.errLines.join("\n");
      expect(combined).toMatch(/--wizard/);
      expect(combined).toMatch(/shaka init/);
      expect(spies.exitCalls).toContain(1);
    } finally {
      spies.restore();
      restoreTTY();
      process.chdir(oldCwd);
    }
  });

  test("--wizard preserves existing wizard behavior (regression sentinel)", async () => {
    // Non-TTY + --wizard: runStart reaches the existing wizard-or-todo body.
    // Since stdin is not a TTY, the wizard branch falls back to templateMode:
    // "todo" (historical behavior — not new). We assert (a) the worktree was
    // created with a TODO-marker autoresearch.sh (setup body ran) and (b)
    // runLoop was invoked with the worktree cwd (loop-entry survived).
    const env = await makeRepoEnv("wiz");
    envs.push(env);
    const oldCwd = process.cwd();
    const restoreTTY = swapIsTTY(false);
    const loopCalls: Array<{ cwd: string }> = [];
    try {
      process.chdir(env.repo);
      await runStart(
        "wizard sentinel",
        { wizard: true, dryRun: false },
        {
          detectProviders: () => CLAUDE_ONLY,
          runLoop: async (args) => {
            loopCalls.push({ cwd: args.cwd });
          },
        },
      );

      // setupWorkspace creates a sibling dir named `<basename>.ar-<slug>`.
      const worktree = join(env.dir, "repo.ar-wizard-sentinel");
      const shPath = join(worktree, "autoresearch.sh");
      expect(await Bun.file(shPath).exists()).toBe(true);
      const body = await Bun.file(shPath).text();
      expect(body).toMatch(/TODO/);

      expect(loopCalls.length).toBe(1);
      // macOS /var → /private/var symlink: normalize via realpath.
      expect(await realpath(loopCalls[0]?.cwd ?? "")).toBe(await realpath(worktree));
    } finally {
      restoreTTY();
      process.chdir(oldCwd);
    }
  });
});
