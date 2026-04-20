import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  commitAll,
  createBranch,
  currentBranch,
  hasChanges,
  isClean,
  isCleanExcept,
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

  describe("listWorktrees", () => {
    test("enumerates main worktree on a fresh repo", async () => {
      const worktrees = await listWorktrees(testDir);
      const realTestDir = await realpath(testDir);
      expect(worktrees).toHaveLength(1);
      expect(worktrees[0]?.path).toBe(realTestDir);
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
