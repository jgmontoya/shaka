import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Eta } from "eta";
import { writeSummary } from "../../../src/memory/storage";

const repoRoot = join(import.meta.dir, "../../..");
const defaultsDir = join(repoRoot, "defaults");
const hookPath = join(defaultsDir, "system/hooks/session-start.ts");

describe("session-start hook", () => {
  test("exports TRIGGER with session.start", async () => {
    const mod = await import("../../../defaults/system/hooks/session-start.ts");
    expect(mod.TRIGGER).toEqual(["session.start"]);
  });

  test("source file cleans up stale session-end-input files", async () => {
    const source = await Bun.file(hookPath).text();
    expect(source).toContain(".session-end-input-*.json");
  });

  test("source file cleans up stale codex pending marker files", async () => {
    const source = await Bun.file(hookPath).text();
    expect(source).toContain(".codex-pending-*.json");
  });

  test("source file recovers stale codex markers by spawning session-end workers", async () => {
    const source = await Bun.file(hookPath).text();
    expect(source).toContain("session_id");
    expect(source).toContain("transcript_path");
    expect(source).toContain("spawnSessionEndWorker(tmpPath, logPath)");
  });
});

describe("emitted session context", () => {
  let testDir: string;
  let shakaHome: string;
  let projectDir: string;

  async function writeConfig(sessionsBudget = 5000): Promise<void> {
    await Bun.write(
      join(shakaHome, "config.json"),
      JSON.stringify({
        version: "0.15.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "TestBot" },
        principal: { name: "Tester" },
        memory: { sessions_budget: sessionsBudget },
      }),
    );
  }

  beforeEach(async () => {
    testDir = await realpath(await mkdtemp(join(tmpdir(), "shaka-test-session-start-")));
    shakaHome = join(testDir, "shaka");
    projectDir = join(testDir, "project");
    await mkdir(shakaHome, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await symlink(join(defaultsDir, "system"), join(shakaHome, "system"), "junction");
    await writeConfig();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function runHook(): Promise<string> {
    const userHome = join(testDir, "user-home");
    const proc = Bun.spawn([process.execPath, hookPath], {
      cwd: projectDir,
      env: {
        ...process.env,
        SHAKA_HOME: shakaHome,
        HOME: userHome,
        USERPROFILE: userHome,
        XDG_CONFIG_HOME: join(userHome, ".config"),
        CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
        CODEX_HOME: join(userHome, ".codex"),
        PI_CODING_AGENT_DIR: join(userHome, ".pi", "agent"),
        CLAUDE_AGENT_TYPE: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        SHAKA_OPENCODE_SUBAGENT: undefined,
        SHAKA_CODEX_SUBAGENT: undefined,
        SHAKA_PI_SUBAGENT: undefined,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    return stdout;
  }

  async function writeUserFiles(files: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(files)) {
      await Bun.write(join(shakaHome, "user", name), content);
    }
  }

  async function writeSession(session: {
    title: string;
    body: string;
    date: string;
    cwd?: string;
  }): Promise<void> {
    await writeSummary(join(shakaHome, "memory"), {
      metadata: {
        date: session.date,
        cwd: session.cwd ?? projectDir,
        provider: "claude",
        sessionId: session.title,
      },
      tags: [],
      title: session.title,
      body: session.body,
    });
  }

  test("a customized reasoning framework replaces the system framework", async () => {
    const systemFramework = await Bun.file(
      join(defaultsDir, "system/base-reasoning-framework.md"),
    ).text();
    expect(await runHook()).toContain(systemFramework);

    const customFramework = "# Project reasoning\n\nCUSTOM_FRAMEWORK_CONTEXT";
    await Bun.write(join(shakaHome, "customizations/base-reasoning-framework.md"), customFramework);

    const context = await runHook();
    expect(context).toContain(customFramework);
    expect(context).not.toContain(systemFramework);
  }, 15_000);

  test("skips unmodified plain-markdown user templates", async () => {
    const files: Record<string, string> = {};
    for (const name of ["goals.md", "missions.md", "projects.md", "tech-stack.md"]) {
      files[name] = await Bun.file(join(defaultsDir, "user", name)).text();
    }
    await writeUserFiles({ ...files, "notes.md": "CUSTOM_USER_CONTEXT" });

    const context = await runHook();
    expect(context).toContain("CUSTOM_USER_CONTEXT");
    for (const content of Object.values(files)) {
      expect(context).not.toContain(content.trim());
    }
  }, 15_000);

  test("includes customized goals", async () => {
    const goals = "# Goals\n\nShip Shaka v1.0";
    await writeUserFiles({ "goals.md": goals });

    expect(await runHook()).toContain(goals);
  }, 15_000);

  test("loads top-level user content without nested reference files", async () => {
    await writeUserFiles({
      "notes.md": "TOP_LEVEL_USER_CONTEXT",
      "references/notes.md": "NESTED_REFERENCE_CONTEXT",
    });

    const context = await runHook();
    expect(context).toContain("TOP_LEVEL_USER_CONTEXT");
    expect(context).not.toContain("NESTED_REFERENCE_CONTEXT");
  }, 15_000);

  test("includes rendered user identity even when unmodified", async () => {
    const eta = new Eta({ autoEscape: false });
    const template = await Bun.file(join(defaultsDir, "user/user.md.eta")).text();
    const identity = eta.renderString(template, {
      principalName: "Tester",
      assistantName: "TestBot",
    });
    await writeUserFiles({ "user.md": identity });

    expect(await runHook()).toContain(identity);
  }, 15_000);

  test("includes related sessions and excludes an unrelated project", async () => {
    await writeSession({
      title: "Current project session",
      body: "CURRENT_PROJECT_SESSION_CONTEXT",
      date: "2026-10-19",
    });
    await writeSession({
      title: "Nested project session",
      body: "NESTED_PROJECT_SESSION_CONTEXT",
      date: "2026-10-18",
      cwd: join(projectDir, "nested"),
    });
    await writeSession({
      title: "Unrelated project session",
      body: "UNRELATED_PROJECT_SESSION_CONTEXT",
      date: "2026-10-20",
      cwd: join(testDir, "unrelated-project"),
    });

    const context = await runHook();
    expect(context).toContain("CURRENT_PROJECT_SESSION_CONTEXT");
    expect(context).toContain("NESTED_PROJECT_SESSION_CONTEXT");
    expect(context).not.toContain("UNRELATED_PROJECT_SESSION_CONTEXT");
  }, 15_000);

  test("uses the configured session budget and preserves the first oversized summary", async () => {
    const latestBody = `LATEST_SESSION_CONTEXT\n${"Latest session detail. ".repeat(10).trim()}`;
    await writeSession({
      title: "Latest session",
      body: latestBody,
      date: "2026-10-20",
    });
    await writeSession({
      title: "Older session",
      body: "OLDER_SESSION_CONTEXT",
      date: "2026-10-19",
    });

    const defaultContext = await runHook();
    expect(defaultContext).toContain(latestBody);
    expect(defaultContext).toContain("OLDER_SESSION_CONTEXT");

    await writeConfig(1);

    const limitedContext = await runHook();
    expect(limitedContext).toContain(latestBody);
    expect(limitedContext).not.toContain("OLDER_SESSION_CONTEXT");
  }, 15_000);
});
