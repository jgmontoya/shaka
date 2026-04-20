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

/**
 * Like {@link isClean} but treats files in `excludePaths` as not-dirty.
 *
 * Autoresearch keeps an untracked append-only jsonl in the worktree; a bare
 * {@link isClean} would always report the worktree as dirty, which masks real
 * unexpected state. Callers that legitimately carry untracked artifacts pass
 * them here.
 */
export async function isCleanExcept(
  excludePaths: readonly string[],
  cwd: string,
): Promise<boolean> {
  const output = await git(["status", "--porcelain"], cwd);
  if (output === "") return true;
  const excludeSet = new Set(excludePaths);
  return output.split("\n").every((line) => {
    // Porcelain format: `XY <path>` — 2 status chars, space, then path
    const path = line.slice(3);
    return excludeSet.has(path);
  });
}

/**
 * Return every path git considers dirty in the worktree — modified, added,
 * deleted, or untracked.
 *
 * Bypasses the shared `git()` wrapper because its `stdout.trim()` would
 * strip the leading-space status column that appears on unstaged entries
 * (` M path` → `M path`), shifting every path by one character. Uses
 * `git status --porcelain -z` for NUL-separated records so paths containing
 * whitespace parse unambiguously.
 */
export async function listDirtyPaths(cwd: string): Promise<readonly string[]> {
  const proc = Bun.spawn(["git", "-c", "commit.gpgSign=false", "status", "--porcelain", "-z"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git status failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  if (stdout === "") return [];
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(3));
}

/**
 * Revert the working tree to HEAD, preserving files named in `excludePaths`.
 *
 * Runs `git checkout -- .` (drops tracked-file edits) followed by
 * `git clean -fd` (removes untracked files and directories). The `-e` flag
 * on `clean` is load-bearing: pathspec excludes applied at stage time do
 * NOT prevent `clean` from deleting matching files.
 */
export async function revertWorkingTree(
  excludePaths: readonly string[],
  cwd: string,
): Promise<void> {
  await git(["checkout", "--", "."], cwd);
  const excludes = excludePaths.flatMap((p) => ["-e", p]);
  await git(["clean", "-fd", ...excludes], cwd);
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

/**
 * Stage and commit all changes except files named in `excludePaths`.
 *
 * Uses pathspec magic (`:(exclude)<path>`) to skip excluded files at stage
 * time. Returns the short SHA of the new commit. Throws if the commit fails
 * (e.g. a pre-commit hook rejects it) so callers can distinguish success
 * from failure and react accordingly.
 */
export async function commitAllExcept(
  excludePaths: readonly string[],
  message: string,
  cwd: string,
): Promise<string> {
  const excludes = excludePaths.map((p) => `:(exclude)${p}`);
  await git(["add", "-A", ".", ...excludes], cwd);
  await git(["commit", "-m", message], cwd);
  return git(["rev-parse", "--short=7", "HEAD"], cwd);
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

export interface WorktreeInfo {
  readonly path: string;
  readonly head: string;
  /** `refs/heads/<name>` for branched worktrees; null for detached HEAD. */
  readonly branch: string | null;
  /** Lock reason string if locked; null otherwise. Empty reason collapses to "". */
  readonly locked: string | null;
  /** Prune reason string if prunable; null otherwise. */
  readonly prunable: string | null;
}

/**
 * Enumerate worktrees via `git worktree list --porcelain`.
 *
 * Porcelain format: each record is a blank-line-terminated block with
 * `<key>` (single-word flag like `detached`, `bare`) or `<key> <value>`
 * lines. Every record starts with `worktree <path>`.
 */
export async function listWorktrees(cwd: string): Promise<readonly WorktreeInfo[]> {
  const raw = await git(["worktree", "list", "--porcelain"], cwd);
  if (raw === "") return [];

  const records: WorktreeInfo[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string | null;
    locked?: string | null;
    prunable?: string | null;
  } = {};

  const flush = (): void => {
    if (current.path !== undefined && current.head !== undefined) {
      records.push({
        path: current.path,
        head: current.head,
        branch: current.branch ?? null,
        locked: current.locked ?? null,
        prunable: current.prunable ?? null,
      });
    }
    current = {};
  };

  for (const line of raw.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
    switch (key) {
      case "worktree":
        current.path = value;
        break;
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "detached":
        current.branch = null;
        break;
      case "locked":
        current.locked = value;
        break;
      case "prunable":
        current.prunable = value;
        break;
      // Ignore other keys (bare, etc.) — not relevant for autoresearch discovery
    }
  }
  flush();

  return records;
}
