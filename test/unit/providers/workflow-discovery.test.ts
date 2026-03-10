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

  test("defaults loop to 1 when omitted", async () => {
    await Bun.write(join(testHome, "system", "workflows", "hello.yaml"), minimalWorkflow);

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows[0]?.loop).toBe(1);
  });

  test("parses loop field", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "looped.yaml"),
      `description: Looped workflow
loop: 3
steps:
  - name: step1
    run: echo hello`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.loop).toBe(3);
  });

  test("rejects loop: 0", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad loop
loop: 0
steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
  });

  test("rejects negative loop", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad loop
loop: -1
steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
  });

  test("rejects fractional loop", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad loop
loop: 1.5
steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
  });

  test("rejects non-numeric loop", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad loop
loop: three
steps:
  - name: step1
    run: echo hello`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
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

  // -------------------------------------------------------------------------
  // Inline group steps
  // -------------------------------------------------------------------------

  test("parses inline group step with loop", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "grouped.yaml"),
      `description: Grouped workflow
steps:
  - name: setup
    run: echo setup
  - name: review-fix
    loop: 3
    steps:
      - name: review
        run: echo review
      - name: fix
        run: echo fix
  - name: deploy
    run: echo deploy`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    expect(workflows).toHaveLength(1);
    const steps = workflows[0]!.steps;
    expect(steps).toHaveLength(3);
    expect(steps[0]?.type).toBe("run");
    expect(steps[1]?.type).toBe("group");
    if (steps[1]?.type === "group") {
      expect(steps[1].loop).toBe(3);
      expect(steps[1].steps).toHaveLength(2);
      expect(steps[1].steps[0]?.name).toBe("review");
      expect(steps[1].steps[1]?.name).toBe("fix");
    }
    expect(steps[2]?.type).toBe("run");
  });

  test("inline group defaults loop to 1", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "group-no-loop.yaml"),
      `description: Group without loop
steps:
  - name: batch
    steps:
      - name: a
        run: echo a
      - name: b
        run: echo b`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    const group = workflows[0]!.steps[0]!;
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.loop).toBe(1);
    }
  });

  test("rejects inline group with empty steps", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad group
steps:
  - name: empty-group
    steps: []`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("non-empty array");
  });

  // -------------------------------------------------------------------------
  // Leaf step with loop (normalized to single-step group)
  // -------------------------------------------------------------------------

  test("leaf step with loop normalizes to group", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "retry.yaml"),
      `description: Retry workflow
steps:
  - name: test
    run: bun test
    loop: 3
    allow-failure: true`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    expect(workflows).toHaveLength(1);
    const step = workflows[0]!.steps[0]!;
    expect(step.type).toBe("group");
    if (step.type === "group") {
      expect(step.name).toBe("test");
      expect(step.loop).toBe(3);
      expect(step.allowFailure).toBe(true);
      expect(step.steps).toHaveLength(1);
      expect(step.steps[0]?.type).toBe("run");
    }
  });

  test("leaf step with loop: 1 stays as leaf", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "no-retry.yaml"),
      `description: No retry
steps:
  - name: test
    run: bun test
    loop: 1`,
    );

    const { workflows } = await discoverWorkflows(testHome);

    expect(workflows[0]!.steps[0]!.type).toBe("run");
  });

  test("rejects step with both workflow and run keys", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Ambiguous
steps:
  - name: test
    workflow: other
    run: echo hi`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("exactly one of");
  });

  test("rejects step with both steps and prompt keys", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Ambiguous
steps:
  - name: test
    steps:
      - name: inner
        run: echo hi
    prompt: do something`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("exactly one of");
  });

  test("rejects leaf step with invalid loop", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad.yaml"),
      `description: Bad leaf loop
steps:
  - name: test
    run: bun test
    loop: 0`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
  });

  // -------------------------------------------------------------------------
  // Workflow references
  // -------------------------------------------------------------------------

  test("resolves workflow reference to group step", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "review-and-fix.yaml"),
      `description: Review and fix
loop: 3
steps:
  - name: review
    run: echo review
  - name: fix
    run: echo fix`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "full-pipeline.yaml"),
      `description: Full pipeline
steps:
  - name: setup
    run: echo setup
  - name: review-cycle
    workflow: review-and-fix
  - name: deploy
    run: echo deploy`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    expect(workflows).toHaveLength(2);

    const pipeline = workflows.find((w) => w.name === "full-pipeline")!;
    expect(pipeline.steps).toHaveLength(3);
    expect(pipeline.steps[0]?.type).toBe("run");
    expect(pipeline.steps[1]?.type).toBe("group");
    if (pipeline.steps[1]?.type === "group") {
      expect(pipeline.steps[1].name).toBe("review-cycle");
      expect(pipeline.steps[1].loop).toBe(3);
      expect(pipeline.steps[1].steps).toHaveLength(2);
      expect(pipeline.steps[1].steps[0]?.name).toBe("review");
    }
    expect(pipeline.steps[2]?.type).toBe("run");
  });

  test("rejects empty workflow reference value", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad-ref.yaml"),
      `description: Bad ref
steps:
  - name: empty
    workflow: ""`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("non-empty string");
  });

  test("rejects invalid loop on inline group", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad-group-loop.yaml"),
      `description: Bad group loop
steps:
  - name: bad
    loop: 0
    steps:
      - name: a
        run: echo a`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("positive integer");
  });

  test("valid workflows still resolve when sibling has ref errors", async () => {
    await Bun.write(join(testHome, "system", "workflows", "good.yaml"), minimalWorkflow);
    await Bun.write(
      join(testHome, "system", "workflows", "bad-ref.yaml"),
      `description: Broken ref
steps:
  - name: missing
    workflow: does-not-exist`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe("good");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rejects reference to non-existent workflow", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "bad-ref.yaml"),
      `description: Bad reference
steps:
  - name: missing
    workflow: does-not-exist`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("not found");
  });

  test("rejects circular workflow reference (A → B → A)", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "a.yaml"),
      `description: Workflow A
steps:
  - name: use-b
    workflow: b`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "b.yaml"),
      `description: Workflow B
steps:
  - name: use-a
    workflow: a`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors.length).toBeGreaterThan(0);
    const refError = errors.find((e) => e.error.includes("circular reference"));
    expect(refError).toBeDefined();
  });

  test("rejects self-referencing workflow", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "self.yaml"),
      `description: Self-referencing
steps:
  - name: recurse
    workflow: self`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("circular reference");
  });

  test("resolves transitive workflow references (A → B → C)", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "leaf.yaml"),
      `description: Leaf
steps:
  - name: step1
    run: echo leaf`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "middle.yaml"),
      `description: Middle
loop: 2
steps:
  - name: use-leaf
    workflow: leaf`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "outer.yaml"),
      `description: Outer
steps:
  - name: setup
    run: echo setup
  - name: use-middle
    workflow: middle
  - name: teardown
    run: echo teardown`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    expect(workflows).toHaveLength(3);

    const outer = workflows.find((w) => w.name === "outer")!;
    expect(outer.steps).toHaveLength(3);
    expect(outer.steps[0]?.type).toBe("run");

    // Middle is embedded as a group with loop: 2
    const middleGroup = outer.steps[1]!;
    expect(middleGroup.type).toBe("group");
    if (middleGroup.type === "group") {
      expect(middleGroup.loop).toBe(2);
      // Middle's step is itself a group (resolved from leaf)
      expect(middleGroup.steps).toHaveLength(1);
      expect(middleGroup.steps[0]?.type).toBe("group");
      if (middleGroup.steps[0]?.type === "group") {
        expect(middleGroup.steps[0].steps[0]?.type).toBe("run");
      }
    }

    expect(outer.steps[2]?.type).toBe("run");
  });

  test("rejects circular reference in transitive chain (A → B → C → A)", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "a.yaml"),
      `description: A
steps:
  - name: use-b
    workflow: b`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "b.yaml"),
      `description: B
steps:
  - name: use-c
    workflow: c`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "c.yaml"),
      `description: C
steps:
  - name: use-a
    workflow: a`,
    );

    const { errors } = await discoverWorkflows(testHome);

    expect(errors.length).toBeGreaterThan(0);
    const cycleError = errors.find((e) => e.error.includes("circular reference"));
    expect(cycleError).toBeDefined();
  });

  test("rejects inline group containing workflow reference", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "leaf.yaml"),
      `description: Leaf
steps:
  - name: step1
    run: echo hello`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "bad-group.yaml"),
      `description: Bad nested group
steps:
  - name: outer-group
    steps:
      - name: nested-ref
        workflow: leaf`,
    );

    const { errors } = await discoverWorkflows(testHome);

    const groupError = errors.find((e) => e.name === "bad-group");
    expect(groupError).toBeDefined();
    expect(groupError?.error).toContain("inline groups cannot contain workflow references");
  });

  test("workflow reference inherits allow-failure", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "fragile.yaml"),
      `description: Fragile
steps:
  - name: step1
    run: exit 1`,
    );
    await Bun.write(
      join(testHome, "system", "workflows", "tolerant.yaml"),
      `description: Tolerant
steps:
  - name: maybe-fail
    workflow: fragile
    allow-failure: true
  - name: after
    run: echo ok`,
    );

    const { workflows, errors } = await discoverWorkflows(testHome);

    expect(errors).toHaveLength(0);
    const tolerant = workflows.find((w) => w.name === "tolerant")!;
    expect(tolerant.steps[0]?.type).toBe("group");
    if (tolerant.steps[0]?.type === "group") {
      expect(tolerant.steps[0].allowFailure).toBe(true);
    }
  });
});
