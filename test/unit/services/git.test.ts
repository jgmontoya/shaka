import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  addWorktree,
  commitAll,
  commitAllExcept,
  createBranch,
  currentBranch,
  hasChanges,
  isClean,
  isCleanExcept,
  listDirtyPaths,
  listWorktrees,
  removeWorktree,
  resetLastCommit,
  revertWorkingTree,
  switchBranch,
} from "../../../src/services/git";

describe("git service", () => {
  const testDir = join(tmpdir(), `shaka-test-git-${process.pid}`);

  async function initRepo(): Promise<void> {
    await Bun.spawn(["git", "init", testDir], { stdout: "pipe", stderr: "pipe" }).exited;
    // Configure user for commits
    await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    // Create initial commit so branch exists
    await Bun.write(join(testDir, ".gitkeep"), "");
    await Bun.spawn(["git", "add", "-A"], { cwd: testDir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "-c", "commit.gpgSign=false", "commit", "-m", "init"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  }

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await initRepo();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("isClean returns true for clean repo", async () => {
    expect(await isClean(testDir)).toBe(true);
  });

  test("isClean returns false with uncommitted changes", async () => {
    await Bun.write(join(testDir, "dirty.txt"), "dirty");
    expect(await isClean(testDir)).toBe(false);
  });

  test("hasChanges returns false for clean repo", async () => {
    expect(await hasChanges(testDir)).toBe(false);
  });

  test("hasChanges returns true with new file", async () => {
    await Bun.write(join(testDir, "new.txt"), "new");
    expect(await hasChanges(testDir)).toBe(true);
  });

  test("createBranch creates and switches to new branch", async () => {
    await createBranch("test-branch", testDir);
    const branch = await currentBranch(testDir);
    expect(branch).toBe("test-branch");
  });

  test("commitAll stages and commits all changes", async () => {
    await Bun.write(join(testDir, "file.txt"), "content");
    expect(await hasChanges(testDir)).toBe(true);

    await commitAll("test commit", testDir);
    expect(await isClean(testDir)).toBe(true);
  });

  test("commitAllExcept unstages excluded paths that were already staged", async () => {
    await Bun.write(join(testDir, "keep.txt"), "base\n");
    await commitAll("seed keep", testDir);

    await Bun.write(join(testDir, "log.jsonl"), '{"iter":1}\n');
    await Bun.spawn(["git", "add", "log.jsonl"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.write(join(testDir, "keep.txt"), "changed\n");

    await commitAllExcept(["log.jsonl"], "commit keep only", testDir);

    const headLogProc = Bun.spawn(["git", "ls-tree", "HEAD", "log.jsonl"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [headLog] = await Promise.all([
      new Response(headLogProc.stdout).text(),
      headLogProc.exited,
    ]);
    expect(headLog.trim()).toBe("");
    expect(await Bun.file(join(testDir, "log.jsonl")).exists()).toBe(true);
  });

  test("currentBranch returns branch name", async () => {
    const branch = await currentBranch(testDir);
    // Could be "main" or "master" depending on git config
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe("string");
  });

  test("switchBranch switches to an existing branch", async () => {
    const defaultBranch = await currentBranch(testDir);
    expect(defaultBranch).toBeTruthy();

    await createBranch("feature", testDir);
    expect(await currentBranch(testDir)).toBe("feature");

    await switchBranch(defaultBranch!, testDir);
    expect(await currentBranch(testDir)).toBe(defaultBranch);
  });

  test("resetLastCommit undoes the last commit and restores changes", async () => {
    await Bun.write(join(testDir, "wip.txt"), "work in progress");
    await commitAll("temp commit", testDir);
    expect(await isClean(testDir)).toBe(true);

    await resetLastCommit(testDir);
    expect(await isClean(testDir)).toBe(false);
    const content = await Bun.file(join(testDir, "wip.txt")).text();
    expect(content).toBe("work in progress");
  });

  test("revertWorkingTree discards tracked edits and untracked files", async () => {
    await Bun.write(join(testDir, "tracked.txt"), "original");
    await commitAll("add tracked", testDir);

    // Edit tracked, add untracked
    await Bun.write(join(testDir, "tracked.txt"), "modified");
    await Bun.write(join(testDir, "junk.txt"), "untracked junk");

    await revertWorkingTree([], testDir);

    expect(await Bun.file(join(testDir, "tracked.txt")).text()).toBe("original");
    expect(await Bun.file(join(testDir, "junk.txt")).exists()).toBe(false);
    expect(await isClean(testDir)).toBe(true);
  });

  test("revertWorkingTree preserves files named in excludePaths", async () => {
    await Bun.write(join(testDir, "keep-me.log"), "important");
    await Bun.write(join(testDir, "drop-me.tmp"), "junk");

    await revertWorkingTree(["keep-me.log"], testDir);

    expect(await Bun.file(join(testDir, "keep-me.log")).exists()).toBe(true);
    expect(await Bun.file(join(testDir, "drop-me.tmp")).exists()).toBe(false);
  });

  // `git checkout -- .` restores the working tree FROM THE INDEX. When a
  // commit fails after `git add -A` (pre-commit hook rejection, GPG error,
  // etc.), the index retains staged changes — so the "revert" silently
  // preserves them. A follow-up isCleanExcept check then trips with a
  // misleading "worktree is dirty" error, masking the real commit failure.
  // revertWorkingTree must unstage before restoring.
  test("revertWorkingTree unstages pending index state (e.g. after a failed commit)", async () => {
    await Bun.write(join(testDir, "tracked.txt"), "v1");
    await commitAll("seed", testDir);

    // Simulate the failed-commit aftermath: staged but not committed.
    await Bun.write(join(testDir, "tracked.txt"), "v2");
    await Bun.spawn(["git", "add", "-A"], { cwd: testDir, stdout: "pipe", stderr: "pipe" })
      .exited;

    await revertWorkingTree([], testDir);

    expect(await Bun.file(join(testDir, "tracked.txt")).text()).toBe("v1");
    expect(await isClean(testDir)).toBe(true);
  });

  // The function's API promises "preserve files named in excludePaths" —
  // tracked as well as untracked. Without pathspec exclusions on the
  // underlying `git checkout`, an excluded tracked file with local edits
  // still gets reset to HEAD. Lock the full API contract in.
  test("revertWorkingTree preserves edits to excluded TRACKED files", async () => {
    await Bun.write(join(testDir, "protected.log"), "v1");
    await commitAll("add protected", testDir);

    // Local edit after the commit — this is what should survive the revert.
    await Bun.write(join(testDir, "protected.log"), "v2-local");
    // Plus an unrelated tracked edit that SHOULD be reverted.
    await Bun.write(join(testDir, ".gitkeep"), "touched");

    await revertWorkingTree(["protected.log"], testDir);

    expect(await Bun.file(join(testDir, "protected.log")).text()).toBe("v2-local");
    expect(await Bun.file(join(testDir, ".gitkeep")).text()).toBe("");
  });

  test("isCleanExcept returns true when only excluded paths are dirty", async () => {
    await Bun.write(join(testDir, "log.jsonl"), '{"iter":1}\n');

    expect(await isClean(testDir)).toBe(false);
    expect(await isCleanExcept(["log.jsonl"], testDir)).toBe(true);
  });

  test("isCleanExcept returns false when non-excluded paths are dirty", async () => {
    await Bun.write(join(testDir, "log.jsonl"), '{"iter":1}\n');
    await Bun.write(join(testDir, "extra.txt"), "oops");

    expect(await isCleanExcept(["log.jsonl"], testDir)).toBe(false);
  });

  test("isCleanExcept returns true on a clean repo regardless of excludes", async () => {
    expect(await isCleanExcept(["log.jsonl"], testDir)).toBe(true);
  });

  // git status --porcelain renders unstaged tracked modifications with a
  // leading space before `M` — ` M log.jsonl`. The old implementation went
  // through the trimming git() wrapper, which stripped that leading space
  // from the first line, so slice(3) returned a path missing its first
  // character. Excluded tracked files then appeared "dirty". Lock the
  // fixed behavior here.
  test("isCleanExcept treats an unstaged modification to an excluded tracked file as clean", async () => {
    await Bun.write(join(testDir, "log.jsonl"), "initial\n");
    await Bun.spawn(["git", "add", "-A"], { cwd: testDir, stdout: "pipe", stderr: "pipe" })
      .exited;
    await Bun.spawn(["git", "-c", "commit.gpgSign=false", "commit", "-m", "track log"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    // Now modify the tracked file without staging — this is the case that
    // triggered the trim-shift bug.
    await Bun.write(join(testDir, "log.jsonl"), "modified\n");

    expect(await isClean(testDir)).toBe(false);
    expect(await isCleanExcept(["log.jsonl"], testDir)).toBe(true);
  });

  describe("listDirtyPaths", () => {
    // `git status --porcelain -z` encodes renames as two NUL-separated tokens:
    // `R  <new>\0<old>\0`. Only the first carries the `XY ` status prefix. A
    // naive parser that slices 3 chars off every token chops the first 3
    // characters from the old-path token — so the caller sees mangled
    // filenames (e.g. `autoresearch.sh.bak` → `resarch.sh.bak`). This test
    // locks the both-paths-intact invariant.
    test("returns both new and old paths intact for a staged rename", async () => {
      await Bun.write(join(testDir, "original.txt"), "content");
      await Bun.spawn(["git", "add", "-A"], { cwd: testDir, stdout: "pipe", stderr: "pipe" })
        .exited;
      await Bun.spawn(["git", "-c", "commit.gpgSign=false", "commit", "-m", "seed"], {
        cwd: testDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;
      await Bun.spawn(["git", "mv", "original.txt", "renamed.txt"], {
        cwd: testDir,
        stdout: "pipe",
        stderr: "pipe",
      }).exited;

      const paths = await listDirtyPaths(testDir);

      expect(paths).toContain("renamed.txt");
      expect(paths).toContain("original.txt");
    });
  });

  describe("listWorktrees", () => {
    test("enumerates main worktree on a fresh repo", async () => {
      const worktrees = await listWorktrees(testDir);
      const realTestDir = await realpath(testDir);
      expect(worktrees).toHaveLength(1);
      // path.resolve normalizes separators on both sides — git worktree list
      // --porcelain returns forward slashes on every platform, while realpath
      // returns OS-native separators (backslashes on Windows).
      const worktreePath = worktrees[0]?.path;
      expect(worktreePath).toBeTruthy();
      const realWorktreePath = await realpath(worktreePath!);
      expect(resolve(realWorktreePath)).toBe(resolve(realTestDir));
      expect(worktrees[0]?.head).toMatch(/^[0-9a-f]{40}$/);
      expect(worktrees[0]?.branch).toMatch(/^refs\/heads\//);
      expect(worktrees[0]?.locked).toBeNull();
      expect(worktrees[0]?.prunable).toBeNull();
    });

    test("enumerates additional worktrees with their branches", async () => {
      const wt1 = join(tmpdir(), `shaka-test-wt1-${process.pid}-${Date.now()}`);
      const wt2 = join(tmpdir(), `shaka-test-wt2-${process.pid}-${Date.now()}`);
      try {
        await addWorktree(wt1, "autoresearch/one", testDir);
        await addWorktree(wt2, "autoresearch/two", testDir);

        const worktrees = await listWorktrees(testDir);
        expect(worktrees).toHaveLength(3);

        const ar = worktrees.filter((w) => w.branch?.startsWith("refs/heads/autoresearch/"));
        expect(ar).toHaveLength(2);
        const branches = ar.map((w) => w.branch).sort();
        expect(branches).toEqual([
          "refs/heads/autoresearch/one",
          "refs/heads/autoresearch/two",
        ]);
      } finally {
        await removeWorktree(wt1, testDir).catch(() => {});
        await removeWorktree(wt2, testDir).catch(() => {});
        await rm(wt1, { recursive: true, force: true });
        await rm(wt2, { recursive: true, force: true });
      }
    });
  });
});
