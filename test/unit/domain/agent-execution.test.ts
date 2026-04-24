import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runAgentStep } from "../../../src/domain/agent-execution";

const NO_PROVIDERS = { claude: false, opencode: false, codex: false } as const;

describe("agent-execution", () => {
  test("module exports runAgentStep", () => {
    expect(typeof runAgentStep).toBe("function");
  });

  test("returns error when no provider is available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No agent provider available");
  });

  test("error message names all three providers when none are available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.stderr).toContain("claude");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("codex");
  });

  test("no-provider result exposes provider=null and timedOut=false", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.provider).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("options accept cwd without breaking no-provider path", async () => {
    const result = await runAgentStep({ prompt: "test", cwd: "/tmp" }, NO_PROVIDERS);

    expect(result.exitCode).toBe(1);
    expect(result.provider).toBeNull();
  });

  test.skipIf(process.platform === "win32")("forwards cwd to the provider subprocess", async () => {
    const root = join(
      tmpdir(),
      `shaka-agent-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const binDir = join(root, "bin");
    const workDir = join(root, "work");
    const oldPath = process.env.PATH;
    try {
      await mkdir(binDir, { recursive: true });
      await mkdir(workDir, { recursive: true });
      const codex = join(binDir, "codex");
      await Bun.write(codex, "#!/bin/sh\npwd\n");
      await chmod(codex, 0o755);
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

      const result = await runAgentStep(
        { prompt: "test", cwd: workDir },
        { claude: false, opencode: false, codex: true },
      );

      expect(result.exitCode).toBe(0);
      expect(result.provider).toBe("codex");
      expect(result.stdout.trim()).toBe(await realpath(workDir));
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("pipes Codex prompts via stdin", async () => {
    const root = join(
      tmpdir(),
      `shaka-agent-codex-stdin-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    try {
      await mkdir(binDir, { recursive: true });
      const codex = join(binDir, "codex");
      await Bun.write(codex, "#!/bin/sh\nprintf 'args=%s\\n' \"$*\"\nprintf 'stdin='\ncat\n");
      await chmod(codex, 0o755);
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

      const result = await runAgentStep(
        { prompt: "---\nread this prompt from stdin" },
        { claude: false, opencode: false, codex: true },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("args=exec --full-auto -");
      expect(result.stdout).toContain("stdin=---\nread this prompt from stdin");
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("does not crash when a provider closes stdin early", async () => {
    const root = join(
      tmpdir(),
      `shaka-agent-early-stdin-close-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    try {
      await mkdir(binDir, { recursive: true });
      const codex = join(binDir, "codex");
      await Bun.write(codex, "#!/bin/sh\nexit 7\n");
      await chmod(codex, 0o755);
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

      const result = await runAgentStep(
        { prompt: "x".repeat(8 * 1024 * 1024), timeout: 1000 },
        { claude: false, opencode: false, codex: true },
      );

      expect(result.provider).toBe("codex");
      expect(result.exitCode).toBe(7);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("waits for a timed-out provider to exit", async () => {
    const root = join(
      tmpdir(),
      `shaka-agent-timeout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const binDir = join(root, "bin");
    const oldPath = process.env.PATH;
    try {
      await mkdir(binDir, { recursive: true });
      const codex = join(binDir, "codex");
      await Bun.write(
        codex,
        "#!/bin/sh\nexec bun -e 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'\n",
      );
      await chmod(codex, 0o755);
      process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

      const start = performance.now();
      const result = await runAgentStep(
        { prompt: "test", timeout: 600 },
        { claude: false, opencode: false, codex: true },
      );
      const elapsedMs = performance.now() - start;

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
      // Floor at the timeout itself, not timeout+SIGKILL-grace, so the
      // assertion doesn't flake on slow CI where spawn overhead eats into
      // the 500ms escalation window. Upper bound caps runaway if the
      // SIGKILL escalation fails — otherwise a stuck subprocess would hang
      // the whole test file.
      expect(elapsedMs).toBeGreaterThanOrEqual(600);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
