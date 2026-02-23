import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("session-start hook", () => {
  test("exports TRIGGER with session.start", async () => {
    const mod = await import("../../../defaults/system/hooks/session-start.ts");
    expect(mod.TRIGGER).toEqual(["session.start"]);
  });

  test("source file imports memory functions from shaka", async () => {
    const source = await Bun.file("defaults/system/hooks/session-start.ts").text();
    expect(source).toContain("listSummaries");
    expect(source).toContain("selectRecentSummaries");
  });

  test("source file uses shared renderSessionSection", async () => {
    const source = await Bun.file("defaults/system/hooks/session-start.ts").text();
    expect(source).toContain("renderSessionSection");
  });

  test("source file includes memory size cap", async () => {
    const source = await Bun.file("defaults/system/hooks/session-start.ts").text();
    // Should have a constant or logic for capping memory section size
    expect(source).toMatch(/MAX_MEMORY|5.*KB|5000|5120/i);
  });

  test("source file includes template skip logic", async () => {
    const source = await Bun.file("defaults/system/hooks/session-start.ts").text();
    expect(source).toContain("isUnmodifiedTemplate");
    expect(source).toContain("unmodified template, skipped");
  });
});

/**
 * Integration tests for the unmodified-template detection.
 *
 * These create a fake SHAKA_HOME with a system/ symlink that points
 * to the real defaults/system directory, which lets the hook resolve
 * defaults/user/ templates via the same mechanism used in production.
 */
describe("unmodified template detection", () => {
  let fakeShakaHome: string;
  const repoRoot = join(import.meta.dir, "../../..");
  const defaultsDir = join(repoRoot, "defaults");

  beforeAll(async () => {
    // Create a temp SHAKA_HOME with a system symlink → real defaults/system
    fakeShakaHome = await mkdtemp(join(tmpdir(), "shaka-test-"));
    await Bun.write(
      `${fakeShakaHome}/config.json`,
      JSON.stringify({
        version: "0.3.0",
        reasoning: { enabled: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "TestBot" },
        principal: { name: "Tester" },
      }),
    );
    await symlink(`${defaultsDir}/system`, `${fakeShakaHome}/system`, "junction");
  });

  afterAll(async () => {
    await rm(fakeShakaHome, { recursive: true, force: true });
  });

  async function setupUserDir(files: Record<string, string>): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    const userDir = `${fakeShakaHome}/user`;
    await mkdir(userDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await Bun.write(`${userDir}/${name}`, content);
    }
  }

  async function cleanUserDir(): Promise<void> {
    await rm(`${fakeShakaHome}/user`, { recursive: true, force: true });
  }

  test("skips unmodified goals.md (verbatim copy of default)", async () => {
    const defaultGoals = await Bun.file(`${defaultsDir}/user/goals.md`).text();
    await setupUserDir({ "goals.md": defaultGoals });

    // Run session-start hook as subprocess pointing at fake home
    const proc = Bun.spawn(["bun", `${defaultsDir}/system/hooks/session-start.ts`], {
      env: {
        ...process.env,
        SHAKA_HOME: fakeShakaHome,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(stderr).toContain("goals.md (unmodified template, skipped)");
    // The goals content should NOT appear in the output
    expect(stdout).not.toContain("[Primary Goal]");

    await cleanUserDir();
  });

  test("includes customized goals.md", async () => {
    const customGoals = `# Goals

## Active Goals

### G0: Ship Shaka v1.0

**Status:** Active
**Target:** Q1 2026
**Progress:**

- [x] Implement session memory
- [ ] Add plugin system
`;
    await setupUserDir({ "goals.md": customGoals });

    const proc = Bun.spawn(["bun", `${defaultsDir}/system/hooks/session-start.ts`], {
      env: {
        ...process.env,
        SHAKA_HOME: fakeShakaHome,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    expect(stderr).toContain("goals.md");
    expect(stderr).not.toContain("skipped");
    expect(stdout).toContain("Ship Shaka v1.0");

    await cleanUserDir();
  });

  test("skips all unmodified default templates", async () => {
    // Copy all plain .md defaults verbatim
    const files: Record<string, string> = {};
    for (const name of ["goals.md", "missions.md", "projects.md", "tech-stack.md"]) {
      files[name] = await Bun.file(`${defaultsDir}/user/${name}`).text();
    }
    await setupUserDir(files);

    const proc = Bun.spawn(["bun", `${defaultsDir}/system/hooks/session-start.ts`], {
      env: {
        ...process.env,
        SHAKA_HOME: fakeShakaHome,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    expect(stderr).toContain("goals.md (unmodified template, skipped)");
    expect(stderr).toContain("missions.md (unmodified template, skipped)");
    expect(stderr).toContain("projects.md (unmodified template, skipped)");
    expect(stderr).toContain("tech-stack.md (unmodified template, skipped)");

    await cleanUserDir();
  });

  test("always includes eta-sourced files (user.md) even when unmodified", async () => {
    // Render the .eta template exactly as shaka init would
    const { Eta } = await import("eta");
    const eta = new Eta({ autoEscape: false });
    const etaSource = await Bun.file(`${defaultsDir}/user/user.md.eta`).text();
    const rendered = eta.renderString(etaSource, {
      principalName: "Tester",
      assistantName: "TestBot",
    });

    await setupUserDir({ "user.md": rendered });

    const proc = Bun.spawn(["bun", `${defaultsDir}/system/hooks/session-start.ts`], {
      env: {
        ...process.env,
        SHAKA_HOME: fakeShakaHome,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    // user.md has no direct .md template in defaults/user/ (only .eta),
    // so it should NOT be skipped — it contains configured identity info
    expect(stderr).toContain("user.md");
    expect(stderr).not.toContain("user.md (unmodified template, skipped)");

    await cleanUserDir();
  });
});
