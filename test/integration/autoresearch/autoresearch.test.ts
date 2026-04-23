import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentExecutionOptions,
  AgentExecutionResult,
} from "../../../src/domain/agent-execution";
import {
  type BenchResult,
  runLoop,
  setupWorkspace,
} from "../../../src/services/autoresearch";
import type { DetectedProviders } from "../../../src/services/provider-detection";

const NO_PROVIDERS: DetectedProviders = { claude: false, opencode: false, codex: false };

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} failed: ${err}`);
  return out.trim();
}

describe("autoresearch walking skeleton", () => {
  const trash: string[] = [];

  afterEach(async () => {
    for (const d of trash.splice(0)) await rm(d, { recursive: true, force: true });
  });

  test("3 iterations end-to-end: jsonl shape, commits, original checkout untouched", async () => {
    // ── Fresh source repo with one committed file ────────────────────────
    const parent = join(
      tmpdir(),
      `shaka-ar-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const repo = join(parent, "project");
    trash.push(parent);
    await mkdir(repo, { recursive: true });
    await sh(["git", "init", "-q", "-b", "main"], repo);
    await sh(["git", "config", "user.email", "test@shaka"], repo);
    await sh(["git", "config", "user.name", "Test"], repo);
    await Bun.write(join(repo, "slow.ts"), "export const x = 1;\n");
    await sh(["git", "add", "-A"], repo);
    await sh(["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "init"], repo);

    const sourceHead = await sh(["git", "rev-parse", "HEAD"], repo);
    const sourceBranch = await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo);

    // ── Setup: creates worktree + templates + setup commit ───────────────
    const setup = await setupWorkspace({
      repoRoot: repo,
      objective: "make tests fast",
      templateMode: "todo",
    });

    // Overwrite the TODO template with one that has a real direction so runLoop
    // can parse it — real users edit the template or let the wizard populate it.
    await Bun.write(
      join(setup.worktreePath, "autoresearch.md"),
      "# Autoresearch: e2e\n\n## Metric\n- direction: minimize\n- unit: ms\n",
    );
    await sh(["git", "add", "-A"], setup.worktreePath);
    await sh(
      ["git", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "finalize spec"],
      setup.worktreePath,
    );

    // ── Scripted agent + benchmark: iter1=keep, iter2=discard, iter3=keep ─
    let agentCall = 0;
    const agent = async (
      _opts: AgentExecutionOptions,
      _det: DetectedProviders,
    ): Promise<AgentExecutionResult> => {
      agentCall++;
      // Each iter edits the file so there's something to commit on keep
      await Bun.write(join(setup.worktreePath, "slow.ts"), `export const x = ${agentCall + 1};\n`);
      return {
        exitCode: 0,
        stdout: `HYPOTHESIS: bump to ${agentCall + 1}`,
        stderr: "",
        provider: "claude",
        timedOut: false,
      };
    };

    // baseline=100, iter1=70 keep, iter2=80 discard (worse than 70), iter3=50 keep
    const values = [100, 70, 80, 50];
    let benchCall = 0;
    const benchmark = async (_cwd: string): Promise<BenchResult> => {
      const v = values[benchCall++]!;
      return {
        exitCode: 0,
        stdout: `METRIC name=t value=${v} unit=ms`,
        stderr: "",
        measurement: { name: "t", value: v, unit: "ms" },
      };
    };

    await runLoop(
      {
        cwd: setup.worktreePath,
        providers: NO_PROVIDERS,
        stopWhen: (s) => s.iter >= 3,
      },
      { agent, benchmark },
    );

    // ── Assert jsonl shape ────────────────────────────────────────────────
    const jsonl = (await Bun.file(join(setup.worktreePath, "autoresearch.jsonl")).text()).trim();
    const entries = jsonl.split("\n").map((l) => JSON.parse(l));

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.verdict)).toEqual(["keep", "discard", "keep"]);
    expect(entries.map((e) => e.iter)).toEqual([1, 2, 3]);
    expect(entries[0].commit).toMatch(/^[0-9a-f]{7}$/);
    expect(entries[1].commit).toBeNull();
    expect(entries[2].commit).toMatch(/^[0-9a-f]{7}$/);

    // ── Assert git log on the experiment branch ───────────────────────────
    const branchLog = await sh(["git", "log", "--format=%s", setup.branch], repo);
    const commits = branchLog.split("\n");
    // source init + setup template + finalize-spec + 2 keep commits = 5
    expect(commits).toHaveLength(5);
    expect(commits[0]).toContain("iter 3"); // newest first
    expect(commits[1]).toContain("iter 1");

    // ── Assert the jsonl is NOT tracked at HEAD ──────────────────────────
    const treeFiles = await sh(
      ["git", "ls-tree", "-r", setup.branch, "--name-only"],
      repo,
    );
    expect(treeFiles.split("\n")).not.toContain("autoresearch.jsonl");

    // ── Original checkout remained untouched ─────────────────────────────
    expect(await sh(["git", "rev-parse", "HEAD"], repo)).toBe(sourceHead);
    expect(await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo)).toBe(sourceBranch);

    // The worktree path lives next to the original repo and is still present
    expect(dirname(setup.worktreePath)).toBe(parent);
    expect(await Bun.file(join(setup.worktreePath, "autoresearch.md")).exists()).toBe(true);
  });
});
