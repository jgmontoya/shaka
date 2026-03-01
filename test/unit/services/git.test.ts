import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitAll,
  createBranch,
  currentBranch,
  hasChanges,
  isClean,
  resetLastCommit,
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
});
