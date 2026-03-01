/**
 * Git operations for workflow runner.
 * Branch creation, change detection, and auto-commit helpers.
 *
 * Uses Bun.spawn following the same pattern as version.ts.
 */

/** Run a git command and return trimmed stdout, or throw on failure. */
async function git(args: string[], cwd: string): Promise<string> {
  // -c commit.gpgSign=false ensures non-interactive execution when user has GPG signing configured
  const proc = Bun.spawn(["git", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  // Read streams before awaiting exit to avoid pipe buffer deadlock
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

/** Check if the working tree is clean (no uncommitted changes). */
export async function isClean(cwd: string): Promise<boolean> {
  const output = await git(["status", "--porcelain"], cwd);
  return output === "";
}

/** Create and switch to a new branch. */
export async function createBranch(name: string, cwd: string): Promise<void> {
  await git(["checkout", "-b", name], cwd);
}

/** Check if there are any staged or unstaged changes. */
export async function hasChanges(cwd: string): Promise<boolean> {
  const output = await git(["status", "--porcelain"], cwd);
  return output !== "";
}

/** Stage all changes and commit with the given message. */
export async function commitAll(message: string, cwd: string): Promise<void> {
  await git(["add", "-A"], cwd);
  await git(["commit", "-m", message], cwd);
}

/** Get the current branch name, or null if detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

/** Switch to an existing branch. */
export async function switchBranch(name: string, cwd: string): Promise<void> {
  await git(["checkout", name], cwd);
}

/** Reset the last commit, moving its changes back to the working directory (mixed reset). */
export async function resetLastCommit(cwd: string): Promise<void> {
  await git(["reset", "HEAD~1"], cwd);
}

/** Create a worktree at the given path on a new branch. */
export async function addWorktree(path: string, branchName: string, cwd: string): Promise<void> {
  await git(["worktree", "add", path, "-b", branchName], cwd);
}

/** Remove a worktree. */
export async function removeWorktree(path: string, cwd: string): Promise<void> {
  await git(["worktree", "remove", path, "--force"], cwd);
}
