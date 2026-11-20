import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCwdAllowed } from "../../../src/commands/run";
import { discoverWorkflows } from "../../../src/providers/workflow-discovery";

describe("run command", () => {
  const testHome = join(tmpdir(), `shaka-test-run-cmd-${process.pid}`);

  async function runFixture(yaml: string, ...args: string[]) {
    const cwd = join(testHome, "work");
    await mkdir(cwd, { recursive: true });
    await Bun.write(join(testHome, "system", "workflows", "fixture.yaml"), yaml);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../../../src/index.ts"),
        "run",
        "fixture",
        ...args,
      ],
      cwd,
      env: { ...process.env, SHAKA_HOME: testHome },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  }

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await mkdir(join(testHome, "system", "workflows"), { recursive: true });
    await mkdir(join(testHome, "customizations", "workflows"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  test("workflow resolution finds named workflow", async () => {
    await Bun.write(
      join(testHome, "system", "workflows", "deploy.yaml"),
      `description: Deploy workflow
steps:
  - name: build
    run: echo build`,
    );

    const { workflows } = await discoverWorkflows(testHome);
    const found = workflows.find((w) => w.name === "deploy");

    expect(found).toBeDefined();
    expect(found!.name).toBe("deploy");
  });

  test("workflow resolution returns undefined for nonexistent", async () => {
    const { workflows } = await discoverWorkflows(testHome);
    const found = workflows.find((w) => w.name === "nonexistent");

    expect(found).toBeUndefined();
  });

  test("CWD scoping allows matching directory", () => {
    expect(isCwdAllowed("/home/user/project", ["/home/user/project"])).toBe(true);
    expect(isCwdAllowed("/home/user/project/sub", ["/home/user/project"])).toBe(true);
    expect(isCwdAllowed("/home/user/other", ["/home/user/project"])).toBe(false);
  });

  test("input parts are joined with spaces", () => {
    const parts = ["add", "a", "login", "page"];
    const input = parts.join(" ");
    expect(input).toBe("add a login page");
  });

  test("createRunCommand exports correctly", async () => {
    const { createRunCommand } = await import("../../../src/commands/run");
    const cmd = createRunCommand();
    expect(cmd.name()).toBe("run");
  });

  test.each([1, 2])(
    "reports an unconfirmed stopping condition with a limit of %i",
    async (limit) => {
      const { exitCode, stdout } = await runFixture(
        `description: Exhausted workflow
state: none
loop: 2
until:
  run: exit 1
steps:
  - name: work
    run: echo work`,
        "--loop",
        String(limit),
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        limit === 1 ? "Status: completed\n" : "Status: completed (2/2 iterations)",
      );
      expect(stdout).toContain("Stopping condition unconfirmed at the iteration limit");
    },
  );

  test("reports a group condition verdict without claiming a workflow-level outcome", async () => {
    const { exitCode, stdout } = await runFixture(`description: Group condition
state: none
steps:
  - name: nested
    loop: 2
    until:
      run: test {loop.iteration} -eq {loop.total}
    steps:
      - name: work
        run: echo work`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("until unconfirmed");
    expect(stdout).toContain("until satisfied");
    expect(stdout).not.toContain("until continue");
    expect(stdout).not.toContain("Stopping condition unconfirmed at the iteration limit");
  });

  test("reports a failed step without claiming that the stopping condition was evaluated", async () => {
    const { exitCode, stdout } = await runFixture(`description: Failed step
state: none
loop: 2
until:
  run: exit 0
steps:
  - name: work
    run: exit 7`);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("Status: failed (0/2 iterations)");
    expect(stdout).not.toContain("Checking until condition");
    expect(stdout).not.toContain("Stopping condition unconfirmed at the iteration limit");
  });

  test.each([1, 2])("reports satisfaction on iteration %i of two", async (iteration) => {
    const { exitCode, stdout } = await runFixture(`description: Done workflow
state: none
loop: 2
until:
  run: test {loop.iteration} -eq ${iteration}
steps:
  - name: work
    run: echo work`);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[iter ${iteration}/2] Checking until condition...`);
    expect(stdout).toContain("until satisfied");
    expect(stdout).toContain(`Status: completed (satisfied after ${iteration}/2 iterations)`);
    expect(stdout).not.toContain("Stopping condition unconfirmed at the iteration limit");
  });
});
