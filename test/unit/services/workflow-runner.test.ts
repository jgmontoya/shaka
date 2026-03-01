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
    steps: [
      { type: "run", name: "hello", run: "echo hello" },
    ],
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
      steps: [
        { type: "run", name: "greet", run: "echo {input}" },
      ],
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
      steps: [
        { type: "run", name: "create-file", run: "echo content > output.txt" },
      ],
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
    const branchExists = Bun.spawn(
      ["git", "rev-parse", "--verify", metadata.branch!],
      { cwd: testDir, stdout: "pipe", stderr: "pipe" },
    );
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
});
