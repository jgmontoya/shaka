import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCwdAllowed } from "../../../src/commands/run";
import { discoverWorkflows } from "../../../src/providers/workflow-discovery";

describe("run command", () => {
  const testHome = join(tmpdir(), `shaka-test-run-cmd-${process.pid}`);

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

  test("prints until progress and satisfied summary", async () => {
    const workDir = join(testHome, "work");
    await mkdir(workDir, { recursive: true });
    await Bun.write(
      join(testHome, "system", "workflows", "done.yaml"),
      `description: Done workflow
state: none
loop: 2
until:
  run: test -f done.txt
steps:
  - name: done
    run: echo done > done.txt`,
    );

    const oldHome = process.env.SHAKA_HOME;
    const oldCwd = process.cwd();
    const oldLog = console.log;
    const lines: string[] = [];

    try {
      process.env.SHAKA_HOME = testHome;
      process.chdir(workDir);
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };

      const { createRunCommand } = await import("../../../src/commands/run");
      await createRunCommand().parseAsync(["done"], { from: "user" });
    } finally {
      console.log = oldLog;
      process.chdir(oldCwd);
      if (oldHome === undefined) {
        delete process.env.SHAKA_HOME;
      } else {
        process.env.SHAKA_HOME = oldHome;
      }
    }

    expect(lines.join("\n")).toContain("[iter 1/2] Checking until condition...");
    expect(lines.join("\n")).toContain("until satisfied");
    expect(lines.join("\n")).toContain("Status: completed (satisfied after 1/2 iterations)");
  });
});
