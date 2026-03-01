import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkflows } from "../../../src/providers/workflow-discovery";

describe("discoverWorkflows", () => {
  const testHome = join(tmpdir(), `shaka-test-workflows-${process.pid}`);

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await mkdir(join(testHome, "system", "workflows"), { recursive: true });
    await mkdir(join(testHome, "customizations", "workflows"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  const minimalWorkflow = `description: Test workflow
steps:
  - name: step1
    run: echo hello`;

  test("discovers workflow from system/", async () => {
    await Bun.write(join(testHome, "system", "workflows", "hello.yaml"), minimalWorkflow);

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe("hello");
    expect(workflows[0]?.description).toBe("Test workflow");
    expect(workflows[0]?.state).toBe("git-branch"); // default
    expect(workflows[0]?.steps).toHaveLength(1);
    expect(workflows[0]?.steps[0]?.type).toBe("run");
  });

  test("customization overrides system by name", async () => {
    await Bun.write(join(testHome, "system", "workflows", "deploy.yaml"), minimalWorkflow);
    await Bun.write(
      join(testHome, "customizations", "workflows", "deploy.yaml"),
      `description: Custom deploy
steps:
  - name: build
    run: make build`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.description).toBe("Custom deploy");
    expect(workflows[0]?.sourcePath).toContain("customizations");
  });

  test("validates step name uniqueness", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad workflow
steps:
  - name: step1
    run: echo a
  - name: step1
    run: echo b`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('duplicate step name "step1"');
  });

  test("rejects steps with multiple types", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad workflow
steps:
  - name: step1
    command: /build
    run: echo hello`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("must have exactly one of");
    expect(errors[0]?.error).toContain("found: command, run");
  });

  test("rejects empty steps array", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad workflow
steps: []`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("non-empty array");
  });

  test("handles CWD normalization", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "scoped.yaml"),
      `description: Scoped workflow
cwd: ~/Projects/app
steps:
  - name: step1
    run: echo hello`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.cwd).toBeArrayOfSize(1);
    expect(workflows[0]?.cwd?.[0]).toContain(join("Projects", "app"));
  });

  test("returns structured errors for invalid files", async () => {
    await Bun.write(join(testHome, "system", "workflows", "bad.yaml"), ": : : not valid yaml");

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("bad");
    expect(errors[0]?.error).toContain("Invalid YAML");
  });

  test("reports error for missing description", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Missing required field: description");
  });

  test("parses state: none", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "simple.yaml"),
      `description: Simple workflow
state: none
steps:
  - name: step1
    run: echo hello`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.state).toBe("none");
  });

  test("rejects invalid state", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad state
state: worktree
steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('Invalid state "worktree"');
  });

  test("parses all three step types", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "multi.yaml"),
      `description: Multi-step
steps:
  - name: build
    command: /build {input}
  - name: review
    prompt: Review the changes
  - name: test
    run: bun test`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    const steps = workflows[0]!.steps;
    expect(steps).toHaveLength(3);
    expect(steps[0]?.type).toBe("command");
    expect(steps[1]?.type).toBe("prompt");
    expect(steps[2]?.type).toBe("run");
  });

  test("parses allow-failure flag", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "lenient.yaml"),
      `description: Lenient
steps:
  - name: lint
    run: eslint .
    allow-failure: true`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows[0]?.steps[0]?.allowFailure).toBe(true);
  });

  test("handles empty directories", async () => {
    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("handles non-existent directories", async () => {
    const emptyHome = join(tmpdir(), `shaka-test-empty-wf-${process.pid}`);
    await mkdir(emptyHome, { recursive: true });

    const { workflows, errors } = await discoverWorkflows(emptyHome);

    expect(workflows).toHaveLength(0);
    expect(errors).toHaveLength(0);

    await rm(emptyHome, { recursive: true, force: true });
  });

  test("rejects reserved name", async () => {
    await Bun.write(join(testHome, "system", "workflows", "shaka.yaml"), minimalWorkflow);

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Reserved workflow name");
  });

  test("rejects invalid name", async () => {
    await Bun.write(join(testHome, "system", "workflows", "Bad Name.yaml"), minimalWorkflow);

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid workflow name");
  });

  test("ignores non-.yaml files", async () => {
    await Bun.write(join(testHome, "system", "workflows", "readme.txt"), "not a workflow");
    await Bun.write(join(testHome, "system", "workflows", "hello.yaml"), minimalWorkflow);

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe("hello");
  });

  test("rejects step names with path traversal characters", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "evil.yaml"),
      `description: Evil workflow
steps:
  - name: "../../etc/passwd"
    run: echo pwned`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("invalid name");
  });

  test("rejects step names with uppercase or spaces", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad-steps.yaml"),
      `description: Bad step names
steps:
  - name: "My Step"
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("invalid name");
  });

  test("returns valid workflows alongside errors", async () => {
    await Bun.write(join(testHome, "system", "workflows", "good.yaml"), minimalWorkflow);
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `steps:
  - name: step1
    run: echo hello`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe("good");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("bad");
  });
});
