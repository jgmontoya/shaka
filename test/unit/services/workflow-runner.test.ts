import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepResult, Workflow } from "../../../src/domain/workflow";
import {
  generateRunId,
  resolveTemplates,
  runWorkflow,
} from "../../../src/services/workflow-runner";

describe("generateRunId", () => {
  test("produces YYYYMMDD-HHmmss-mmm format", () => {
    const id = generateRunId();
    expect(id).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
});

describe("resolveTemplates", () => {
  const makeResult = (overrides: Partial<StepResult> = {}): StepResult => ({
    name: "test",
    type: "run",
    exitCode: 0,
    output: "test output",
    durationMs: 100,
    iteration: 1,
    ...overrides,
  });

  test("replaces {input}", () => {
    expect(resolveTemplates("echo {input}", "hello world", new Map(), null)).toBe(
      "echo hello world",
    );
  });

  test("replaces {previous.output}", () => {
    const prev = makeResult({ output: "prev out" });
    expect(resolveTemplates("{previous.output}", "", new Map(), prev)).toBe("prev out");
  });

  test("replaces {previous.exitCode}", () => {
    const prev = makeResult({ exitCode: 42 });
    expect(resolveTemplates("code: {previous.exitCode}", "", new Map(), prev)).toBe("code: 42");
  });

  test("{previous.output} → empty when no previous", () => {
    expect(resolveTemplates("{previous.output}", "", new Map(), null)).toBe("");
  });

  test("replaces {steps.<name>.output}", () => {
    const steps = new Map<string, StepResult>();
    steps.set("build", makeResult({ output: "build ok" }));
    expect(resolveTemplates("{steps.build.output}", "", steps, null)).toBe("build ok");
  });

  test("replaces {steps.<name>.exitCode}", () => {
    const steps = new Map<string, StepResult>();
    steps.set("lint", makeResult({ exitCode: 1 }));
    expect(resolveTemplates("{steps.lint.exitCode}", "", steps, null)).toBe("1");
  });

  test("unknown step reference → empty", () => {
    expect(resolveTemplates("{steps.missing.output}", "", new Map(), null)).toBe("");
  });

  test("multiple variables in one string", () => {
    const prev = makeResult({ output: "data" });
    const result = resolveTemplates("input={input} prev={previous.output}", "foo", new Map(), prev);
    expect(result).toBe("input=foo prev=data");
  });

  test("replaces {loop.iteration}", () => {
    const result = resolveTemplates("iter {loop.iteration}", "", new Map(), null, {
      iteration: 2,
      total: 5,
    });
    expect(result).toBe("iter 2");
  });

  test("replaces {loop.total}", () => {
    const result = resolveTemplates("of {loop.total}", "", new Map(), null, {
      iteration: 1,
      total: 3,
    });
    expect(result).toBe("of 3");
  });

  test("loop variables default to 1 when omitted", () => {
    const result = resolveTemplates("{loop.iteration}/{loop.total}", "", new Map(), null);
    expect(result).toBe("1/1");
  });
});

describe("runWorkflow", () => {
  const testDir = join(tmpdir(), `shaka-test-runner-${process.pid}`);
  const artifactHome = join(tmpdir(), `shaka-test-artifacts-${process.pid}`);

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(artifactHome, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    await mkdir(artifactHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(artifactHome, { recursive: true, force: true });
  });

  const simpleWorkflow: Workflow = {
    name: "test-wf",
    description: "Test workflow",
    state: "none",
    loop: 1,
    steps: [{ type: "run", name: "hello", run: "echo hello" }],
    sourcePath: "/fake/path.md",
  };

  test("executes run step and captures output", async () => {
    const { metadata, artifactDir } = await runWorkflow({
      workflow: simpleWorkflow,
      input: "test input",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.workflow).toBe("test-wf");
    expect(metadata.input).toBe("test input");
    expect(metadata.branch).toBeNull(); // state: none
    expect(metadata.steps).toHaveLength(1);
    expect(metadata.steps[0]?.exitCode).toBe(0);
    expect(metadata.steps[0]?.output).toContain("hello");

    // Artifact files written
    const outputFile = await Bun.file(join(artifactDir, "hello.out")).text();
    expect(outputFile).toContain("hello");

    const runJson = await Bun.file(join(artifactDir, "run.json")).json();
    expect(runJson.status).toBe("completed");
  });

  test("state: none skips all git operations", async () => {
    const { metadata } = await runWorkflow({
      workflow: simpleWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.branch).toBeNull();
    expect(metadata.status).toBe("completed");
  });

  test("allowFailure continues on non-zero exit", async () => {
    const workflow: Workflow = {
      name: "lenient",
      description: "Lenient",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "fail", run: "exit 1", allowFailure: true },
        { type: "run", name: "after", run: "echo after" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(2);
    expect(metadata.steps[0]?.exitCode).not.toBe(0);
    expect(metadata.steps[1]?.exitCode).toBe(0);
  });

  test("fail-fast halts on non-zero exit without allowFailure", async () => {
    const workflow: Workflow = {
      name: "strict",
      description: "Strict",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "fail", run: "exit 1" },
        { type: "run", name: "never", run: "echo never" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("failed");
    expect(metadata.steps).toHaveLength(1); // second step never runs
    expect(metadata.steps[0]?.name).toBe("fail");
  });

  test("template variables resolve in run steps", async () => {
    const workflow: Workflow = {
      name: "template",
      description: "Template test",
      state: "none",
      loop: 1,
      steps: [{ type: "run", name: "greet", run: "echo {input}" }],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "world",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.steps[0]?.output).toContain("world");
  });

  test("multi-step with output handoff via {previous.output}", async () => {
    const workflow: Workflow = {
      name: "chain",
      description: "Chain test",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "first", run: "echo FIRST" },
        { type: "run", name: "second", run: "echo got:{previous.output}" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.steps).toHaveLength(2);
    // The second step should have echoed the output of the first
    // Note: previous.output includes trailing newline from echo
    expect(metadata.steps[1]?.output).toContain("got:");
    expect(metadata.steps[1]?.output).toContain("FIRST");
  });

  async function initGitRepo(dir: string): Promise<void> {
    await Bun.spawn(["git", "init", dir], { stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.spawn(["git", "config", "user.name", "Test"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    await Bun.write(join(dir, ".gitkeep"), "");
    await Bun.spawn(["git", "add", "-A"], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
    await Bun.spawn(["git", "-c", "commit.gpgSign=false", "commit", "-m", "init"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  }

  test("git-branch state creates branch and auto-commits in worktree", async () => {
    await initGitRepo(testDir);

    const gitWorkflow: Workflow = {
      name: "git-wf",
      description: "Git workflow",
      state: "git-branch",
      loop: 1,
      steps: [{ type: "run", name: "create-file", run: "echo content > output.txt" }],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow: gitWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.branch).toMatch(/^shaka\/run-git-wf-\d{8}-\d{6}-\d{3}$/);
    expect(metadata.steps).toHaveLength(1);
    expect(metadata.steps[0]?.exitCode).toBe(0);

    // User's workspace stays on the original branch (not the workflow branch)
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).not.toBe(metadata.branch);

    // The workflow branch should exist with the step's commit
    const branchExists = Bun.spawn(["git", "rev-parse", "--verify", metadata.branch!], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await branchExists.exited).toBe(0);

    // Worktree should be cleaned up after run (no active worktrees besides main)
    const listProc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const worktreeList = (await new Response(listProc.stdout).text()).trim();
    expect(worktreeList).not.toContain("shaka-worktrees");
  });

  test("git-branch auto-saves dirty workspace and restores immediately", async () => {
    await initGitRepo(testDir);
    await Bun.write(join(testDir, "dirty.txt"), "dirty content");

    const gitWorkflow: Workflow = {
      name: "git-wf",
      description: "Git workflow",
      state: "git-branch",
      loop: 1,
      steps: [{ type: "run", name: "step1", run: "echo hello" }],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow: gitWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(1);

    // User stays on the original branch
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    expect(branch).not.toBe(metadata.branch);

    // Dirty file was restored as uncommitted (WIP commit was undone)
    const restored = await Bun.file(join(testDir, "dirty.txt")).text();
    expect(restored).toBe("dirty content");

    const statusProc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const status = (await new Response(statusProc.stdout).text()).trim();
    expect(status).toContain("dirty.txt");
  });

  test("git-branch worktree includes dirty files from user workspace", async () => {
    await initGitRepo(testDir);
    await Bun.write(join(testDir, "feature.txt"), "new feature code");

    const gitWorkflow: Workflow = {
      name: "git-wf",
      description: "Git workflow",
      state: "git-branch",
      loop: 1,
      steps: [{ type: "run", name: "check", run: "cat feature.txt" }],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow: gitWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // The worktree was created from the WIP commit, so dirty files are visible
    expect(metadata.steps[0]?.output).toContain("new feature code");
  });

  test("loop: 1 behaves identically to no loop", async () => {
    const { metadata } = await runWorkflow({
      workflow: simpleWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.totalIterations).toBe(1);
    expect(metadata.completedIterations).toBe(1);
    expect(metadata.steps).toHaveLength(1);
    expect(metadata.steps[0]?.iteration).toBe(1);
  });

  test("loop: 3 runs all steps three times", async () => {
    const workflow: Workflow = {
      name: "looped",
      description: "Looped",
      state: "none",
      loop: 3,
      steps: [{ type: "run", name: "count", run: "echo iteration" }],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.totalIterations).toBe(3);
    expect(metadata.completedIterations).toBe(3);
    expect(metadata.steps).toHaveLength(3);
    expect(metadata.steps[0]?.iteration).toBe(1);
    expect(metadata.steps[1]?.iteration).toBe(2);
    expect(metadata.steps[2]?.iteration).toBe(3);
  });

  test("loop: 3 with allow-failure runs all iterations", async () => {
    const workflow: Workflow = {
      name: "loop-allow",
      description: "Loop with allow-failure",
      state: "none",
      loop: 3,
      steps: [
        { type: "run", name: "fail", run: "exit 1", allowFailure: true },
        { type: "run", name: "after", run: "echo ok" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.completedIterations).toBe(3);
    // 2 steps * 3 iterations = 6 results
    expect(metadata.steps).toHaveLength(6);
  });

  test("loop: 3 halts on non-allow-failure step failure", async () => {
    const workflow: Workflow = {
      name: "loop-halt",
      description: "Loop halts on failure",
      state: "none",
      loop: 3,
      steps: [{ type: "run", name: "boom", run: "exit 1" }],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("failed");
    expect(metadata.completedIterations).toBe(0);
    // Only 1 step ran (iteration 1, then halt)
    expect(metadata.steps).toHaveLength(1);
    expect(metadata.steps[0]?.iteration).toBe(1);
  });

  test("previousResult carries across iterations", async () => {
    const workflow: Workflow = {
      name: "carry",
      description: "Cross-iteration handoff",
      state: "none",
      loop: 2,
      steps: [
        { type: "run", name: "echo-prev", run: "echo prev:{previous.output}" },
        { type: "run", name: "produce", run: "echo PRODUCED" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(4);
    // Iteration 1, step 1: no previous → empty
    expect(metadata.steps[0]?.output).toContain("prev:");
    // Iteration 2, step 1: previous is "produce" from iteration 1
    expect(metadata.steps[2]?.output).toContain("PRODUCED");
  });

  test("loop artifacts use iter-N/ subdirectories", async () => {
    const workflow: Workflow = {
      name: "loop-artifacts",
      description: "Artifact test",
      state: "none",
      loop: 2,
      steps: [{ type: "run", name: "out", run: "echo hello" }],
      sourcePath: "/fake/path.md",
    };

    const { artifactDir } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    // When loop > 1, artifacts go into iter-N/ subdirectories
    const iter1 = await Bun.file(join(artifactDir, "iter-1", "out.out")).text();
    expect(iter1).toContain("hello");
    const iter2 = await Bun.file(join(artifactDir, "iter-2", "out.out")).text();
    expect(iter2).toContain("hello");
  });

  test("loop: 1 artifacts use flat structure", async () => {
    const { artifactDir } = await runWorkflow({
      workflow: simpleWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    // When loop = 1, artifacts stay flat (backward compatible)
    const file = await Bun.file(join(artifactDir, "hello.out")).text();
    expect(file).toContain("hello");
  });

  test("stepMap overwrites across iterations", async () => {
    const workflow: Workflow = {
      name: "overwrite",
      description: "stepMap overwrite test",
      state: "none",
      loop: 2,
      steps: [
        { type: "run", name: "val", run: "echo iter-{loop.iteration}" },
        { type: "run", name: "read-map", run: "echo got:{steps.val.output}" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.steps).toHaveLength(4);
    // Iteration 2, step "read-map" should see iteration 2's "val" output (overwritten)
    expect(metadata.steps[3]?.output).toContain("iter-2");
  });

  test("loop: 3 with failure on iteration 2 halts and records partial progress", async () => {
    // First iteration succeeds, second fails — verifies multi-iteration before halt
    const workflow: Workflow = {
      name: "late-fail",
      description: "Fails on second iteration",
      state: "none",
      loop: 3,
      steps: [
        { type: "run", name: "maybe-fail", run: "test -f fail.flag && exit 1 || echo ok" },
        { type: "run", name: "create-flag", run: "touch fail.flag" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("failed");
    // Iteration 1: both steps pass (flag doesn't exist yet)
    // Iteration 2: maybe-fail finds flag, exits 1, halts
    expect(metadata.completedIterations).toBe(1);
    expect(metadata.steps).toHaveLength(3); // 2 from iter 1, 1 from iter 2
    expect(metadata.steps[0]?.iteration).toBe(1);
    expect(metadata.steps[1]?.iteration).toBe(1);
    expect(metadata.steps[2]?.iteration).toBe(2);
    expect(metadata.steps[2]?.exitCode).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // Group steps
  // -------------------------------------------------------------------------

  test("group step runs inner steps", async () => {
    const workflow: Workflow = {
      name: "with-group",
      description: "Group test",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "batch",
          loop: 1,
          steps: [
            { type: "run", name: "a", run: "echo A" },
            { type: "run", name: "b", run: "echo B" },
          ],
        },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(2);
    expect(metadata.steps[0]?.output).toContain("A");
    expect(metadata.steps[1]?.output).toContain("B");
  });

  test("group step with loop runs inner steps multiple times", async () => {
    const workflow: Workflow = {
      name: "group-loop",
      description: "Group loop test",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "cycle",
          loop: 3,
          steps: [{ type: "run", name: "count", run: "echo iter" }],
        },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(3);
    expect(metadata.steps[0]?.iteration).toBe(1);
    expect(metadata.steps[1]?.iteration).toBe(2);
    expect(metadata.steps[2]?.iteration).toBe(3);
  });

  test("group step isolates stepMap from outer context", async () => {
    const workflow: Workflow = {
      name: "scope-test",
      description: "StepMap scoping",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "outer-val", run: "echo OUTER" },
        {
          type: "group",
          name: "inner",
          loop: 1,
          steps: [
            // Inside the group, {steps.outer-val.output} should be empty (isolated)
            { type: "run", name: "check", run: "echo inner-sees:{steps.outer-val.output}" },
          ],
        },
        // After the group, {steps.inner.output} should be the group's last result
        { type: "run", name: "after", run: "echo after-sees:{steps.inner.output}" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // Inner step should NOT see outer-val
    expect(metadata.steps[1]?.output).toContain("inner-sees:");
    expect(metadata.steps[1]?.output).not.toContain("OUTER");
    // Outer step after group should see group projected result
    expect(metadata.steps[2]?.output).toContain("after-sees:");
    expect(metadata.steps[2]?.output).toContain("inner-sees:");
  });

  test("group step: previousResult flows across group boundary", async () => {
    const workflow: Workflow = {
      name: "prev-flow",
      description: "Previous result flow",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "before", run: "echo BEFORE" },
        {
          type: "group",
          name: "inner",
          loop: 1,
          steps: [{ type: "run", name: "check-prev", run: "echo prev:{previous.output}" }],
        },
        { type: "run", name: "after-group", run: "echo after:{previous.output}" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // First step inside group sees "before" step's output as previous
    expect(metadata.steps[1]?.output).toContain("BEFORE");
    // Step after group sees the group's last step as previous
    expect(metadata.steps[2]?.output).toContain("prev:");
  });

  test("group step halts pipeline on inner failure", async () => {
    const workflow: Workflow = {
      name: "group-fail",
      description: "Group failure propagation",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "failing",
          loop: 1,
          steps: [{ type: "run", name: "boom", run: "exit 1" }],
        },
        { type: "run", name: "never", run: "echo never" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("failed");
    expect(metadata.steps).toHaveLength(1);
    expect(metadata.steps[0]?.name).toBe("boom");
  });

  test("group step with allowFailure continues pipeline", async () => {
    const workflow: Workflow = {
      name: "group-allow",
      description: "Group allowFailure",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "fragile",
          loop: 1,
          allowFailure: true,
          steps: [{ type: "run", name: "boom", run: "exit 1" }],
        },
        { type: "run", name: "continues", run: "echo ok" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(2);
    expect(metadata.steps[1]?.output).toContain("ok");
  });

  test("group artifacts stored in subdirectory", async () => {
    const workflow: Workflow = {
      name: "group-artifacts",
      description: "Group artifact test",
      state: "none",
      loop: 1,
      steps: [
        { type: "run", name: "flat", run: "echo flat" },
        {
          type: "group",
          name: "inner",
          loop: 2,
          steps: [{ type: "run", name: "out", run: "echo grouped" }],
        },
      ],
      sourcePath: "/fake/path.md",
    };

    const { artifactDir } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    // Flat step at root
    const flat = await Bun.file(join(artifactDir, "flat.out")).text();
    expect(flat).toContain("flat");
    // Group artifacts in subdirectory with iter-N since loop > 1
    const iter1 = await Bun.file(join(artifactDir, "inner", "iter-1", "out.out")).text();
    expect(iter1).toContain("grouped");
    const iter2 = await Bun.file(join(artifactDir, "inner", "iter-2", "out.out")).text();
    expect(iter2).toContain("grouped");
  });

  test("group with loop: 1 uses flat artifact structure", async () => {
    const workflow: Workflow = {
      name: "group-flat-artifacts",
      description: "Group flat artifact test",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "inner",
          loop: 1,
          steps: [{ type: "run", name: "out", run: "echo hello" }],
        },
      ],
      sourcePath: "/fake/path.md",
    };

    const { artifactDir } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    // loop: 1 → flat within group directory
    const file = await Bun.file(join(artifactDir, "inner", "out.out")).text();
    expect(file).toContain("hello");
  });

  test("outer loop with inner group step", async () => {
    const workflow: Workflow = {
      name: "nested-loops",
      description: "Outer loop + inner group",
      state: "none",
      loop: 2,
      steps: [
        {
          type: "group",
          name: "inner",
          loop: 2,
          steps: [{ type: "run", name: "echo", run: "echo iter" }],
        },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // 2 outer iterations × 2 inner iterations × 1 step = 4 step results
    expect(metadata.steps).toHaveLength(4);
  });

  test("group loop context does not leak to outer loop templates", async () => {
    const workflow: Workflow = {
      name: "loop-context",
      description: "Loop context isolation",
      state: "none",
      loop: 2,
      steps: [
        {
          type: "group",
          name: "inner",
          loop: 3,
          steps: [
            { type: "run", name: "inner-step", run: "echo inner-{loop.iteration}-of-{loop.total}" },
          ],
        },
        { type: "run", name: "outer-check", run: "echo outer-{loop.iteration}-of-{loop.total}" },
      ],
      sourcePath: "/fake/path.md",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // Find the outer-check steps (should see outer loop context: 1/2 and 2/2)
    const outerChecks = metadata.steps.filter((s) => s.name === "outer-check");
    expect(outerChecks).toHaveLength(2);
    expect(outerChecks[0]?.output).toContain("outer-1-of-2");
    expect(outerChecks[1]?.output).toContain("outer-2-of-2");
    // Inner steps should see inner loop context
    const innerSteps = metadata.steps.filter((s) => s.name === "inner-step");
    expect(innerSteps).toHaveLength(6); // 3 inner × 2 outer
  });

  test("nested groups (group inside group)", async () => {
    const workflow: Workflow = {
      name: "nested-groups",
      description: "Nested group test",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "outer-group",
          loop: 2,
          steps: [
            {
              type: "group",
              name: "inner-group",
              loop: 2,
              steps: [
                {
                  type: "run",
                  name: "deep-step",
                  run: "echo deep-{loop.iteration}-of-{loop.total}",
                },
              ],
            },
          ],
        },
      ],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    // 2 outer × 2 inner = 4 deep-step results
    const deepSteps = metadata.steps.filter((s) => s.name === "deep-step");
    expect(deepSteps).toHaveLength(4);
    // Each inner iteration sees inner loop context (1/2 and 2/2), not outer
    expect(deepSteps[0]?.output).toContain("deep-1-of-2");
    expect(deepSteps[1]?.output).toContain("deep-2-of-2");
    expect(deepSteps[2]?.output).toContain("deep-1-of-2");
    expect(deepSteps[3]?.output).toContain("deep-2-of-2");

    // Execution correctness verified through deepSteps assertions above
  });

  test("group stepMap clears between inner iterations, previousResult carries", async () => {
    const workflow: Workflow = {
      name: "group-iteration-state",
      description: "Group iteration state test",
      state: "none",
      loop: 1,
      steps: [
        {
          type: "group",
          name: "iter-group",
          loop: 2,
          steps: [
            { type: "run", name: "write-val", run: "echo iter-{loop.iteration}" },
            {
              type: "run",
              name: "read-named",
              run: "echo named:{steps.write-val.output}",
            },
            {
              type: "run",
              name: "read-prev",
              run: "echo prev:{previous.output}",
            },
          ],
        },
      ],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.steps).toHaveLength(6); // 3 steps × 2 iterations

    // Iteration 1
    expect(metadata.steps[0]?.output).toContain("iter-1");
    expect(metadata.steps[1]?.output).toContain("named:iter-1");
    expect(metadata.steps[2]?.output).toContain("prev:named:iter-1");

    // Iteration 2: stepMap was cleared, so write-val resolved fresh for this iteration
    expect(metadata.steps[3]?.output).toContain("iter-2");
    // Named ref resolves to THIS iteration's write-val, not iteration 1's
    expect(metadata.steps[4]?.output).toContain("named:iter-2");
    // previousResult carries from last step of iteration 1 into first step's output,
    // but read-prev sees the step before it (read-named), not cross-iteration
    expect(metadata.steps[5]?.output).toContain("prev:named:iter-2");
  });

  test("git-branch loop commits include iteration context", async () => {
    await initGitRepo(testDir);

    const gitWorkflow: Workflow = {
      name: "git-loop",
      description: "Git loop test",
      state: "git-branch",
      loop: 2,
      steps: [{ type: "run", name: "touch", run: "echo {loop.iteration} > file.txt" }],
      sourcePath: "/fake/path.yaml",
    };

    const { metadata } = await runWorkflow({
      workflow: gitWorkflow,
      input: "",
      cwd: testDir,
      shakaHome: artifactHome,
    });

    expect(metadata.status).toBe("completed");
    expect(metadata.completedIterations).toBe(2);

    // Check commit messages on the workflow branch contain iteration context
    const logProc = Bun.spawn(["git", "log", "--format=%s", metadata.branch!], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = (await new Response(logProc.stdout).text()).trim();
    const commits = log.split("\n");

    // Should have commits with [1/2] and [2/2] markers
    expect(commits.some((c) => c.includes("[1/2]"))).toBe(true);
    expect(commits.some((c) => c.includes("[2/2]"))).toBe(true);
  });
});
