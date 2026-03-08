import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AgentCall = {
  prompt: string;
  cwd?: string;
  continueSession?: boolean;
};

type MockResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const agentCalls: AgentCall[] = [];
const queuedResults: MockResult[] = [];

mock.module("../../../src/domain/agent-execution", () => ({
  runAgentStep: async (options: AgentCall): Promise<MockResult> => {
    agentCalls.push(options);
    const next = queuedResults.shift();
    return (
      next ?? {
        exitCode: 0,
        stdout: [
          "ROUND_STATUS: done",
          "SUMMARY: completed default round",
          "FILES: src/example.ts",
          "REJECTED: none",
          "RISKS: none",
          "VERIFY: none",
          "NEXT: no next step",
        ].join("\n"),
        stderr: "",
      }
    );
  },
}));

import { __testables, createLoopCommand } from "../../../src/commands/loop";

type RunJson = {
  completedRounds: number;
  blockedRounds: number;
  verifyPassed: boolean;
  stoppedBecause: string;
};

async function readRunArtifacts(baseDir: string): Promise<{ runJson: RunJson; stateText: string }> {
  const logRoot = join(baseDir, ".loop-logs");
  const runDirs = await readdir(logRoot);
  const runDir = runDirs[0];
  if (!runDir) {
    throw new Error("expected loop log directory");
  }
  const runJson = (await Bun.file(join(logRoot, runDir, "run.json")).json()) as RunJson;

  const files = await readdir(baseDir);
  const stateFile = files.find((file) => file.startsWith(".loop-state-") && file.endsWith(".md"));
  if (!stateFile) {
    throw new Error("expected loop state file");
  }
  const stateText = await Bun.file(join(baseDir, stateFile)).text();
  return { runJson, stateText };
}

describe("loop command", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "shaka-test-loop-"));
    originalCwd = process.cwd();
    agentCalls.length = 0;
    queuedResults.length = 0;
    await mkdir(join(testDir, "workspace"), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    agentCalls.length = 0;
    queuedResults.length = 0;
    await rm(testDir, { recursive: true, force: true });
  });

  test("structured round output is parsed into lists and next step", () => {
    const result = __testables.parseRoundOutput(
      [
        "ROUND_STATUS: blocked",
        "SUMMARY: hit a migration conflict",
        "FILES: src/db.ts, test/db.test.ts",
        "REJECTED: rewrite the ORM; change API shapes",
        "RISKS: migration may still fail in prod; missing rollback coverage",
        "VERIFY: bun test failed",
        "NEXT: fix the migration ordering",
      ].join("\n"),
      2,
      1500,
    );

    expect(result.status).toBe("blocked");
    expect(result.filesChanged).toEqual(["src/db.ts", "test/db.test.ts"]);
    expect(result.rejectedDirections).toEqual(["rewrite the ORM", "change API shapes"]);
    expect(result.openRisks).toEqual(["migration may still fail in prod", "missing rollback coverage"]);
    expect(result.nextStep).toBe("fix the migration ordering");
  });

  test("FILES: none parses as no changed files", () => {
    const result = __testables.parseRoundOutput(
      [
        "ROUND_STATUS: done",
        "SUMMARY: made no code changes",
        "FILES: none",
        "REJECTED: none",
        "RISKS: none",
        "VERIFY: none",
        "NEXT: wait for more input",
      ].join("\n"),
      1,
      20,
    );

    expect(result.filesChanged).toEqual([]);
  });

  test("passes cwd and continueSession through to agent rounds", async () => {
    const cmd = createLoopCommand();
    const workDir = join(testDir, "workspace");

    await cmd.parseAsync(["test task", "--dir", workDir, "--continue", "--rounds", "1"], {
      from: "user",
    });

    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]).toMatchObject({
      cwd: workDir,
      continueSession: true,
    });
  });

  test("baseline pass still writes metadata and final state", async () => {
    process.chdir(testDir);
    const cmd = createLoopCommand();

    await cmd.parseAsync(["already green", "--verify", "true"], { from: "user" });

    expect(agentCalls).toHaveLength(0);
    const { runJson, stateText } = await readRunArtifacts(testDir);

    expect(runJson.completedRounds).toBe(0);
    expect(runJson.verifyPassed).toBe(true);
    expect(runJson.stoppedBecause).toBe("baseline verification already passed");
    expect(stateText).toContain("Baseline verification already passed; no coding rounds were needed.");
    expect(stateText).toContain("Verification: passed");
  });

  test("state file is maintained by the outer loop", async () => {
    process.chdir(testDir);
    queuedResults.push({
      exitCode: 0,
      stdout: [
        "ROUND_STATUS: done",
        "SUMMARY: tightened auth guard",
        "FILES: src/auth.ts",
        "REJECTED: broaden scope to billing",
        "RISKS: missing integration test coverage",
        "VERIFY: bun test auth.ts passed",
        "NEXT: add an integration test for revoked sessions",
      ].join("\n"),
      stderr: "",
    });

    const cmd = createLoopCommand();
    await cmd.parseAsync(["improve auth", "--rounds", "1"], { from: "user" });

    const { stateText } = await readRunArtifacts(testDir);
    expect(stateText).toContain("Round 1: tightened auth guard");
    expect(stateText).toContain("broaden scope to billing");
    expect(stateText).toContain("missing integration test coverage");
    expect(stateText).toContain("add an integration test for revoked sessions");
  });

  test("blockedRounds metadata counts total blocked rounds, not final streak", async () => {
    process.chdir(testDir);
    queuedResults.push(
      {
        exitCode: 0,
        stdout: [
          "ROUND_STATUS: blocked",
          "SUMMARY: waiting on API schema details",
          "FILES: none",
          "REJECTED: guess the schema",
          "RISKS: contract mismatch",
          "VERIFY: none",
          "NEXT: inspect the API contract",
        ].join("\n"),
        stderr: "",
      },
      {
        exitCode: 0,
        stdout: [
          "ROUND_STATUS: done",
          "SUMMARY: documented the known schema assumptions",
          "FILES: docs/api.md",
          "REJECTED: none",
          "RISKS: assumptions may age poorly",
          "VERIFY: none",
          "NEXT: validate assumptions with real examples",
        ].join("\n"),
        stderr: "",
      },
      {
        exitCode: 0,
        stdout: [
          "ROUND_STATUS: blocked",
          "SUMMARY: still missing sample payloads",
          "FILES: none",
          "REJECTED: invent sample payloads",
          "RISKS: examples may be misleading",
          "VERIFY: none",
          "NEXT: request sample payloads",
        ].join("\n"),
        stderr: "",
      },
    );

    const cmd = createLoopCommand();
    await cmd.parseAsync(["stabilize api docs", "--rounds", "3"], { from: "user" });

    const { runJson } = await readRunArtifacts(testDir);
    expect(runJson.blockedRounds).toBe(2);
    expect(runJson.completedRounds).toBe(1);
  });

  test("blocked rounds do not appear in the completed section", async () => {
    process.chdir(testDir);
    queuedResults.push({
      exitCode: 0,
      stdout: [
        "ROUND_STATUS: blocked",
        "SUMMARY: still waiting on schema details",
        "FILES: none",
        "REJECTED: guess the schema",
        "RISKS: contract mismatch",
        "VERIFY: none",
        "NEXT: inspect the API contract",
      ].join("\n"),
      stderr: "",
    });

    const cmd = createLoopCommand();
    await cmd.parseAsync(["stabilize api docs", "--rounds", "1"], { from: "user" });

    const { stateText } = await readRunArtifacts(testDir);
    expect(stateText).toContain("Rounds: 1 / 1");
    expect(stateText).toContain("## Completed\n- none");
    expect(stateText).not.toContain("Round 1: still waiting on schema details");
  });
});
