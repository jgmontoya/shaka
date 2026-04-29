import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutoresearchCommand,
  createOptimizeCommand,
  withSigintAbort,
} from "../../../src/commands/autoresearch";

async function run(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed (exit ${code}): ${stderr}`);
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`);
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

async function makeRepoWithAutoresearchWorktree(prefix: string): Promise<{
  readonly parent: string;
  readonly repo: string;
  readonly worktree: string;
}> {
  const parent = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const repo = join(parent, "repo");
  const worktree = join(parent, "repo.ar-speed");

  await mkdir(repo, { recursive: true });
  await run(["git", "init", "-q", "-b", "main"], repo);
  await run(["git", "config", "user.email", "t@t"], repo);
  await run(["git", "config", "user.name", "t"], repo);
  await Bun.write(join(repo, ".gitkeep"), "");
  await run(["git", "add", "-A"], repo);
  await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
  await run(["git", "worktree", "add", "-q", worktree, "-b", "autoresearch/speed"], repo);

  return { parent, repo, worktree };
}

describe("autoresearch command surface", () => {
  test("top-level command is named 'autoresearch' with a description", () => {
    const cmd = createAutoresearchCommand();
    expect(cmd.name()).toBe("autoresearch");
    expect(cmd.description()).toBeTruthy();
  });

  test("exposes start | status | resume | cleanup subcommands", () => {
    const cmd = createAutoresearchCommand();
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["cleanup", "html", "resume", "start", "status"]);
  });

  test("optimize command is an alias-shaped command tree", () => {
    const cmd = createOptimizeCommand();
    expect(cmd.name()).toBe("optimize");
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["cleanup", "html", "resume", "start", "status"]);
  });

  test("optimize command descriptions do not mention autoresearch", () => {
    const cmd = createOptimizeCommand();

    expect(cmd.commands.find((c) => c.name() === "start")?.description()).not.toContain(
      "autoresearch",
    );
    expect(cmd.commands.find((c) => c.name() === "status")?.description()).not.toContain(
      "autoresearch",
    );
    expect(cmd.commands.find((c) => c.name() === "html")?.description()).not.toContain(
      "autoresearch",
    );
    expect(cmd.commands.find((c) => c.name() === "resume")?.description()).not.toContain(
      "autoresearch",
    );
    expect(cmd.commands.find((c) => c.name() === "cleanup")?.description()).not.toContain(
      "autoresearch",
    );
  });
});

describe("autoresearch html", () => {
  test.skipIf(process.platform === "win32")(
    "writes a report without opening when --no-open is passed",
    async () => {
      const parent = join(
        tmpdir(),
        `shaka-html-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const repo = join(parent, "repo");
      const worktree = join(parent, "repo.ar-speed");
      const out = join(parent, "report.html");
      const oldCwd = process.cwd();
      let opened = false;
      try {
        await mkdir(repo, { recursive: true });
        await run(["git", "init", "-q", "-b", "main"], repo);
        await run(["git", "config", "user.email", "t@t"], repo);
        await run(["git", "config", "user.name", "t"], repo);
        await Bun.write(join(repo, ".gitkeep"), "");
        await run(["git", "add", "-A"], repo);
        await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
        await run(["git", "worktree", "add", "-q", worktree, "-b", "autoresearch/speed"], repo);
        await Bun.write(
          join(worktree, "autoresearch.md"),
          "# Autoresearch: Speed\n\n## Objective\n\nSpeed up tests.\n\n## Metric\n- command: `./autoresearch.sh`\n- direction: minimize\n- unit: ms\n",
        );
        await Bun.write(
          join(worktree, "autoresearch.meta.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            baseline: {
              ts: "2026-04-27T00:00:00.000Z",
              metric: 100,
              unit: "ms",
              direction: "minimize",
              command: "./autoresearch.sh",
              commit: "abc1234",
            },
          })}\n`,
        );
        await Bun.write(
          join(worktree, "autoresearch.jsonl"),
          `${JSON.stringify({
            iter: 1,
            ts: "2026-04-27T00:01:00.000Z",
            provider: "claude",
            hypothesis: "cache it",
            metric: 80,
            unit: "ms",
            verdict: "keep",
            commit: "def5678",
            asi: ["#cache"],
            duration_ms: 100,
          })}\n`,
        );
        await run(["git", "add", "-A"], worktree);
        await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "setup"], worktree);

        process.chdir(repo);
        await createAutoresearchCommand({
          openFile: async () => {
            opened = true;
          },
        }).parseAsync(["html", "speed", "--output", out, "--no-open"], { from: "user" });

        expect(opened).toBe(false);
        const html = await Bun.file(out).text();
        expect(html).toContain("Speed up tests.");
        expect(html).toContain("<svg");
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});

describe("autoresearch status", () => {
  test.skipIf(process.platform === "win32")(
    "reports worktrees locked without a reason as locked",
    async () => {
      const parent = join(
        tmpdir(),
        `shaka-status-lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const repo = join(parent, "repo");
      const worktree = join(parent, "repo.ar-locked");
      const oldCwd = process.cwd();
      const oldLog = console.log;
      const logs: string[] = [];
      try {
        await mkdir(repo, { recursive: true });
        await run(["git", "init", "-q", "-b", "main"], repo);
        await run(["git", "config", "user.email", "t@t"], repo);
        await run(["git", "config", "user.name", "t"], repo);
        await Bun.write(join(repo, ".gitkeep"), "");
        await run(["git", "add", "-A"], repo);
        await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);
        await run(["git", "worktree", "add", "-q", worktree, "-b", "autoresearch/locked"], repo);
        await run(["git", "worktree", "lock", worktree], repo);

        console.log = (...args: unknown[]): void => {
          logs.push(args.map(String).join(" "));
        };
        process.chdir(repo);

        await createAutoresearchCommand().parseAsync(["status"], { from: "user" });

        expect(logs.join("\n")).toContain("locked  [locked]");
        expect(logs.join("\n")).not.toContain("locked  [active]");
      } finally {
        console.log = oldLog;
        process.chdir(oldCwd);
        await run(["git", "worktree", "unlock", worktree], repo).catch(() => {});
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});

describe("autoresearch cleanup", () => {
  test.skipIf(process.platform === "win32")(
    "can remove an experiment worktree while keeping its branch",
    async () => {
      const { parent, repo, worktree } = await makeRepoWithAutoresearchWorktree("shaka-cleanup");
      const oldCwd = process.cwd();
      try {
        process.chdir(repo);
        await createAutoresearchCommand().parseAsync(
          ["cleanup", "speed", "--worktree", "--keep-branch", "--yes"],
          { from: "user" },
        );

        expect(await pathExists(worktree)).toBe(false);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toContain(
          "autoresearch/speed",
        );
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "can remove an experiment worktree and its branch",
    async () => {
      const { parent, repo, worktree } =
        await makeRepoWithAutoresearchWorktree("shaka-cleanup-branch");
      const oldCwd = process.cwd();
      try {
        process.chdir(repo);
        await createAutoresearchCommand().parseAsync(
          ["cleanup", "speed", "--worktree", "--branch", "--yes"],
          { from: "user" },
        );

        expect(await pathExists(worktree)).toBe(false);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toBe("");
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses to delete an unmerged branch before removing the worktree",
    async () => {
      const { parent, repo, worktree } =
        await makeRepoWithAutoresearchWorktree("shaka-cleanup-unmerged");
      const oldCwd = process.cwd();
      try {
        await Bun.write(join(worktree, "change.txt"), "unmerged\n");
        await run(["git", "add", "-A"], worktree);
        await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "change"], worktree);

        process.chdir(repo);
        await expect(
          createAutoresearchCommand().parseAsync(
            ["cleanup", "speed", "--worktree", "--branch", "--yes"],
            { from: "user" },
          ),
        ).rejects.toThrow(/unmerged branch/i);

        expect(await pathExists(worktree)).toBe(true);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toContain(
          "autoresearch/speed",
        );
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "can force-remove an experiment worktree and unmerged branch",
    async () => {
      const { parent, repo, worktree } = await makeRepoWithAutoresearchWorktree(
        "shaka-cleanup-unmerged-force",
      );
      const oldCwd = process.cwd();
      try {
        await Bun.write(join(worktree, "change.txt"), "discard branch\n");
        await run(["git", "add", "-A"], worktree);
        await run(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "change"], worktree);

        process.chdir(repo);
        await createAutoresearchCommand().parseAsync(
          ["cleanup", "speed", "--worktree", "--branch", "--force", "--yes"],
          { from: "user" },
        );

        expect(await pathExists(worktree)).toBe(false);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toBe("");
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses to remove a worktree with user changes unless forced",
    async () => {
      const { parent, repo, worktree } =
        await makeRepoWithAutoresearchWorktree("shaka-cleanup-dirty");
      const oldCwd = process.cwd();
      try {
        await Bun.write(join(worktree, "notes.txt"), "keep me\n");

        process.chdir(repo);
        await expect(
          createAutoresearchCommand().parseAsync(
            ["cleanup", "speed", "--worktree", "--keep-branch", "--yes"],
            { from: "user" },
          ),
        ).rejects.toThrow(/dirty autoresearch worktree/i);

        expect(await pathExists(worktree)).toBe(true);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toContain(
          "autoresearch/speed",
        );
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "can force-remove a dirty experiment worktree while keeping the branch",
    async () => {
      const { parent, repo, worktree } =
        await makeRepoWithAutoresearchWorktree("shaka-cleanup-force");
      const oldCwd = process.cwd();
      try {
        await Bun.write(join(worktree, "notes.txt"), "discard me\n");

        process.chdir(repo);
        await createAutoresearchCommand().parseAsync(
          ["cleanup", "speed", "--worktree", "--keep-branch", "--force", "--yes"],
          { from: "user" },
        );

        expect(await pathExists(worktree)).toBe(false);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toContain(
          "autoresearch/speed",
        );
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "dry-run leaves the worktree and branch intact",
    async () => {
      const { parent, repo, worktree } =
        await makeRepoWithAutoresearchWorktree("shaka-cleanup-dry-run");
      const oldCwd = process.cwd();
      try {
        process.chdir(repo);
        await createAutoresearchCommand().parseAsync(
          ["cleanup", "speed", "--worktree", "--branch", "--dry-run", "--yes"],
          { from: "user" },
        );

        expect(await pathExists(worktree)).toBe(true);
        expect(await gitOutput(["branch", "--list", "autoresearch/speed"], repo)).toContain(
          "autoresearch/speed",
        );
      } finally {
        process.chdir(oldCwd);
        await run(["git", "worktree", "remove", worktree, "--force"], repo).catch(() => {});
        await run(["git", "branch", "-D", "autoresearch/speed"], repo).catch(() => {});
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});

describe("withSigintAbort", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("sets process.exitCode to 130 when SIGINT fires", async () => {
    process.exitCode = 0;
    const controller = new AbortController();

    await withSigintAbort(controller, "interrupted", async () => {
      process.emit("SIGINT");
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    expect(controller.signal.aborted).toBe(true);
    expect(process.exitCode).toBe(130);
  });

  test("forces exit on a second SIGINT", async () => {
    process.exitCode = 0;
    const controller = new AbortController();
    const realExit = process.exit;
    const exitCall: { code?: string | number | null | undefined } = {};
    process.exit = ((code?: string | number | null | undefined): never => {
      exitCall.code = code;
      return undefined as never;
    }) as typeof process.exit;

    try {
      await withSigintAbort(controller, "interrupted", async () => {
        process.emit("SIGINT");
        process.emit("SIGINT");
      });
    } finally {
      process.exit = realExit;
    }

    expect(controller.signal.aborted).toBe(true);
    expect(exitCall.code).toBe(130);
  });

  test("leaves process.exitCode untouched when no SIGINT fires", async () => {
    process.exitCode = 0;
    const controller = new AbortController();

    await withSigintAbort(controller, "unused", async () => {
      // graceful completion — no signal
    });

    expect(controller.signal.aborted).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});
