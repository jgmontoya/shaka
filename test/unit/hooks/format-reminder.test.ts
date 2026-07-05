import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Subprocess tests for the deployed format-reminder hook.
 *
 * Inference is stubbed at the system boundary: a fake `claude` executable on
 * an isolated PATH echoes the classification set via SHIM_CLASSIFICATION.
 * With no executable on the PATH, inference fails and the hook's fail-safe
 * paths are exercised. No live model calls.
 */

const repoRoot = join(import.meta.dir, "../../..");
const hookPath = join(repoRoot, "defaults/system/hooks/format-reminder.ts");

interface HookRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let shimDir: string;

async function runHook(
  stdin: string,
  shakaHome: string,
  options: { classification?: string; env?: Record<string, string | undefined> } = {},
): Promise<HookRun> {
  // With no classification, the shim dir is left off the PATH so no
  // inference provider is detected and the hook must fail safe.
  const path = options.classification ? `${shimDir}:/usr/bin:/bin` : "/usr/bin:/bin";

  const proc = Bun.spawn([process.execPath, hookPath], {
    env: {
      ...process.env,
      SHAKA_HOME: shakaHome,
      PATH: path,
      SHIM_CLASSIFICATION: options.classification,
      CLAUDE_AGENT_TYPE: undefined,
      SHAKA_OPENCODE_SUBAGENT: undefined,
      SHAKA_CODEX_SUBAGENT: undefined,
      SHAKA_PI_SUBAGENT: undefined,
      ...options.env,
    },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function promptInput(prompt: string): string {
  return JSON.stringify({ prompt });
}

async function makeShakaHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await symlink(join(repoRoot, "defaults/system"), join(home, "system"), "junction");
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      version: "0.12.0",
      reasoning: { enabled: true },
      permissions: { managed: true },
      providers: { claude: { enabled: false }, opencode: { enabled: false } },
      assistant: { name: "TestBot" },
      principal: { name: "Tester" },
    }),
  );
  return home;
}

beforeAll(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "shaka-test-shim-"));
  const shim = join(shimDir, "claude");
  await Bun.write(shim, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$SHIM_CLASSIFICATION"\n`);
  await chmod(shim, 0o755);
});

afterAll(async () => {
  await rm(shimDir, { recursive: true, force: true });
});

describe("format-reminder hook", () => {
  let fakeShakaHome: string;

  beforeAll(async () => {
    fakeShakaHome = await makeShakaHome("shaka-test-format-");
  });

  afterAll(async () => {
    await rm(fakeShakaHome, { recursive: true, force: true });
  });

  test("renders the reminder for the classified depth with the configured name", async () => {
    const result = await runHook(promptInput("tweak the padding"), fakeShakaHome, {
      classification: JSON.stringify({ depth: "ITERATION", capabilities: [], thinking: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEPTH: ITERATION");
    expect(result.stdout).toContain("TestBot");
  });

  test("renders selected capabilities and thinking tools", async () => {
    const result = await runHook(promptInput("review this design"), fakeShakaHome, {
      classification: JSON.stringify({
        depth: "FULL",
        capabilities: ["analyst"],
        thinking: ["council"],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEPTH: FULL");
    expect(result.stdout).toContain("Analyst → Algorithm (subagent_type=Algorithm)");
    expect(result.stdout).toContain("council — Surfaces stronger decisions");
  });

  test("drops capability and tool keys that don't exist", async () => {
    const result = await runHook(promptInput("do something"), fakeShakaHome, {
      classification: JSON.stringify({
        depth: "FULL",
        capabilities: ["nonexistent-capability", "analyst"],
        thinking: ["bogus-tool"],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Analyst");
    expect(result.stdout).not.toContain("nonexistent-capability");
    expect(result.stdout).not.toContain("bogus-tool");
  });

  test("falls back to FULL on an invalid depth", async () => {
    const result = await runHook(promptInput("hello"), fakeShakaHome, {
      classification: JSON.stringify({ depth: "BANANAS", capabilities: [], thinking: [] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEPTH: FULL");
  });

  test("fails safe to FULL when no inference provider is available", async () => {
    const result = await runHook(promptInput("hello"), fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEPTH: FULL");
    // Rendered from the real template, not the hardcoded catch fallback
    expect(result.stdout).toContain("OBSERVE");
  });

  test("emits the hardcoded FULL fallback when SHAKA_HOME is unusable", async () => {
    const brokenHome = await mkdtemp(join(tmpdir(), "shaka-test-broken-"));
    try {
      const result = await runHook(promptInput("hello"), brokenHome, {
        classification: JSON.stringify({ depth: "MINIMAL", capabilities: [], thinking: [] }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DEPTH: FULL");
      expect(result.stdout).not.toContain("OBSERVE");
    } finally {
      await rm(brokenHome, { recursive: true, force: true });
    }
  });

  test("stays silent for subagents", async () => {
    const result = await runHook(promptInput("hello"), fakeShakaHome, {
      classification: JSON.stringify({ depth: "FULL", capabilities: [], thinking: [] }),
      env: { CLAUDE_AGENT_TYPE: "Task" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stays silent on empty stdin", async () => {
    const result = await runHook("", fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("stays silent when the payload has no prompt", async () => {
    const result = await runHook(JSON.stringify({ other: "field" }), fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("format-reminder skill override", () => {
  let overrideHome: string;

  beforeAll(async () => {
    overrideHome = await makeShakaHome("shaka-test-format-override-");
    await Bun.write(
      join(overrideHome, "skills", "council", "SKILL.md"),
      [
        "---",
        "name: Council Override",
        "description: overridden description",
        "key: council",
        "include_when: always",
        "---",
        "",
        "# overridden",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(overrideHome, { recursive: true, force: true });
  });

  test("an installed skill overrides the system skill with the same key", async () => {
    const result = await runHook(promptInput("decide something"), overrideHome, {
      classification: JSON.stringify({ depth: "FULL", capabilities: [], thinking: ["council"] }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Council Override — overridden description");
    expect(result.stdout).not.toContain("Surfaces stronger decisions");
  });
});
