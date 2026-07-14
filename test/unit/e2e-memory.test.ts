import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const memoryE2eHelper = join(repoRoot, "test", "e2e", "lib", "memory.sh");

describe("memory E2E helper", () => {
  let testDir: string;
  let shakaHome: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "shaka-memory-e2e-test-"));
    shakaHome = join(testDir, "shaka-home");
    binDir = join(testDir, "bin");
    await mkdir(shakaHome, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await symlink(join(repoRoot, "defaults", "system"), join(shakaHome, "system"));

    const shakaWrapper = join(binDir, "shaka");
    await Bun.write(
      shakaWrapper,
      `#!/usr/bin/env bash
exec bun "${join(repoRoot, "src", "index.ts")}" "$@"
`,
    );
    await chmod(shakaWrapper, 0o755);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("validates project-scoped recall through installed command surfaces", async () => {
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `source "${join(repoRoot, "test", "e2e", "lib", "common.sh")}" && source "${memoryE2eHelper}" && run_memory_recall_e2e`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          SHAKA_HOME: shakaHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(stdout).toContain("Default memory search stays in the current project");
    expect(stdout).toContain("All-project memory search is explicit");
    expect(stdout).toContain("Compiled knowledge is searchable");
    expect(stdout).toContain("Session-start context stays in the current project");
    expect(stdout).toContain("Compiled knowledge records project metadata");

    const sessionFiles = await readdir(join(shakaHome, "memory", "sessions")).catch(() => []);
    const knowledgeDirs = await readdir(join(shakaHome, "memory", "knowledge")).catch(() => []);
    expect(sessionFiles).not.toContain("2026-07-14-memorye2e-current.md");
    expect(sessionFiles).not.toContain("2026-07-14-memorye2e-unrelated.md");
    expect(knowledgeDirs).not.toContain("memory-e2e-current");
    expect(knowledgeDirs).not.toContain("memory-e2e-unrelated");
  });

  test("every provider E2E suite runs the shared memory contract", async () => {
    for (const provider of ["claudecode", "opencode", "codex", "pi"]) {
      const script = await Bun.file(join(repoRoot, "test", "e2e", `${provider}.sh`)).text();
      expect(script).toContain('source "$(dirname "$0")/lib/memory.sh"');
      expect(script).toContain("run_memory_recall_e2e");
    }
  });
});
