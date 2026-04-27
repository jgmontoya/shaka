import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFinalizeIfDirty } from "../../../src/commands/autoresearch";

async function sh(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err}`);
}

async function runStdout(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err}`);
  return out.trim();
}

describe("commitFinalizeIfDirty", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    for (const d of createdDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function makeRepo(): Promise<string> {
    const dir = join(
      tmpdir(),
      `shaka-finalize-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
    await sh(["git", "init", "-q", "-b", "main"], dir);
    await sh(["git", "config", "user.email", "t@t"], dir);
    await sh(["git", "config", "user.name", "t"], dir);
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\nexit 1\n");
    await sh(["git", "add", "-A"], dir);
    await sh(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], dir);
    return dir;
  }

  test("no-op on a clean worktree", async () => {
    const dir = await makeRepo();
    await commitFinalizeIfDirty(dir); // must not throw
  });

  test("commits the dirty benchmark as a finalize commit", async () => {
    const dir = await makeRepo();
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\necho METRIC name=t value=1 unit=ms\n");

    await commitFinalizeIfDirty(dir);

    const logProc = Bun.spawn(["git", "log", "-1", "--format=%s"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [subject] = await Promise.all([new Response(logProc.stdout).text(), logProc.exited]);
    expect(subject.trim()).toContain("finalize benchmark");
  });

  test("uses custom commit message when opts.message is passed", async () => {
    const dir = await makeRepo();
    await Bun.write(join(dir, "autoresearch.sh"), "#!/bin/sh\necho METRIC name=t value=1 unit=ms\n");

    await commitFinalizeIfDirty(dir, { message: "autoresearch: finalize agent-generated setup" });

    const logProc = Bun.spawn(["git", "log", "-1", "--format=%s"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [subject] = await Promise.all([new Response(logProc.stdout).text(), logProc.exited]);
    expect(subject.trim()).toBe("autoresearch: finalize agent-generated setup");
  });

  // Skipped on Windows: relies on git executing a `#!/bin/sh` pre-commit hook
  // via shebang dispatch, which Windows git doesn't do natively. Symmetric
  // with the exec-bit / shebang-script skip at line 99.
  test.skipIf(process.platform === "win32")(
    "throws (preserves user edits on disk) when a pre-commit hook rejects the commit",
    async () => {
      const dir = await makeRepo();
      // Install a pre-commit hook that always fails
      const hookPath = join(dir, ".git", "hooks", "pre-commit");
      await Bun.write(hookPath, "#!/bin/sh\nexit 1\n");
      await chmod(hookPath, 0o755);

      // User edits the benchmark
      await Bun.write(
        join(dir, "autoresearch.sh"),
        "#!/bin/sh\necho METRIC name=t value=1 unit=ms\n",
      );

      await expect(commitFinalizeIfDirty(dir)).rejects.toThrow();

      // The edits must still be on disk — the caller will surface the error and
      // stop, rather than proceeding into a loop whose first revert would wipe
      // the user's manual work.
      const contents = await Bun.file(join(dir, "autoresearch.sh")).text();
      expect(contents).toContain("METRIC name=t value=1 unit=ms");
    },
  );

  // Skipped on Windows: this test asserts the Unix executable bit (git mode
  // 100755) and spawns `./autoresearch.checks.sh` directly — both are Unix-
  // only concerns. Windows can't set the exec bit from a plain Bun.write and
  // can't execute a shebang script by path. The autoresearch feature itself
  // is Unix-shaped at runtime, so skipping here mirrors feature reality.
  test.skipIf(process.platform === "win32")(
    "commits a newly created untracked setup artifact as part of finalize",
    async () => {
    // The wizard may have skipped `autoresearch.checks.sh`; the user could
    // still add one via $EDITOR. That untracked file should ride into the
    // finalize commit, executable so the loop's checks gate can spawn it.
    const dir = await makeRepo();
    await Bun.write(join(dir, "autoresearch.checks.sh"), "#!/bin/sh\nexit 0\n");

    await commitFinalizeIfDirty(dir);

    const lsProc = Bun.spawn(["git", "ls-tree", "HEAD", "autoresearch.checks.sh"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [lsOut] = await Promise.all([new Response(lsProc.stdout).text(), lsProc.exited]);
    const [mode, , , name] = lsOut.trim().split(/\s+/);
    expect(name).toBe("autoresearch.checks.sh");
    expect(mode).toBe("100755");

    const runProc = Bun.spawn(["./autoresearch.checks.sh"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, , exit] = await Promise.all([
      new Response(runProc.stdout).text(),
      new Response(runProc.stderr).text(),
      runProc.exited,
    ]);
    expect(exit).toBe(0);
  });

  test("no-ops when the only dirt is gitignored toolchain output, not setup artifacts", async () => {
    // Reproduces the user-reported false-positive: a Cargo project's
    // benchmark writes `target/` during the setup oneshot, the source repo
    // gitignores it, and the prior `includeIgnored: true` query surfaced
    // every gitignored path in the tree as "dirty" — tripping
    // assertOnlySetupDirty even though no setup artifact actually changed.
    const dir = await makeRepo();
    await Bun.write(join(dir, ".gitignore"), "target/\n");
    await sh(["git", "add", ".gitignore"], dir);
    await sh(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "add gitignore"], dir);
    await mkdir(join(dir, "target"), { recursive: true });
    await Bun.write(join(dir, "target", "build.log"), "compile output\n");

    const headBefore = await runStdout(["git", "rev-parse", "HEAD"], dir);
    await commitFinalizeIfDirty(dir); // must not throw
    const headAfter = await runStdout(["git", "rev-parse", "HEAD"], dir);
    expect(headAfter).toBe(headBefore); // genuine early-return, no commit made
  });

  test.skipIf(process.platform === "win32")(
    "still finalizes a setup artifact whose name matches the source repo's .gitignore",
    async () => {
      // Asymmetric guarantee: we relaxed `assertOnlySetupDirty` for ignored
      // *non-setup* paths, but a gitignored *setup artifact* (e.g. repo
      // ignores `*.sh`) must still ride the finalize commit — otherwise
      // every iteration sees it untracked and the loop breaks.
      const dir = await makeRepo();
      await Bun.write(join(dir, ".gitignore"), "*.sh\n");
      await sh(["git", "add", ".gitignore"], dir);
      await sh(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "ignore sh"], dir);
      await Bun.write(join(dir, "autoresearch.checks.sh"), "#!/bin/sh\nexit 0\n");

      await commitFinalizeIfDirty(dir);

      const lsProc = Bun.spawn(["git", "ls-tree", "HEAD", "autoresearch.checks.sh"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [lsOut] = await Promise.all([new Response(lsProc.stdout).text(), lsProc.exited]);
      expect(lsOut).toContain("autoresearch.checks.sh");
    },
  );

  test("throws when the worktree has unrelated dirty files, preserving them on disk", async () => {
    // The function's contract is "finalize benchmark setup" — it should not
    // silently capture arbitrary unrelated changes, nor should it silently
    // leave them to be wiped by the first revert. Error out and let the user
    // choose: commit, stash, or discard.
    const dir = await makeRepo();
    await Bun.write(join(dir, "unrelated.ts"), "export const x = 1;\n");

    await expect(commitFinalizeIfDirty(dir)).rejects.toThrow(/unrelated/i);

    // The unrelated file is still on disk — no silent wipe path.
    expect(await Bun.file(join(dir, "unrelated.ts")).exists()).toBe(true);
  });
});
