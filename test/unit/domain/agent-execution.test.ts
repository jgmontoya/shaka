import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runAgentStep } from "../../../src/domain/agent-execution";

const NO_PROVIDERS = { claude: false, opencode: false, codex: false, pi: false } as const;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("agent-execution", () => {
  test("module exports runAgentStep", () => {
    expect(typeof runAgentStep).toBe("function");
  });

  test("returns error when no provider is available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No agent provider available");
  });

  test("error message names all four providers when none are available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.stderr).toContain("claude");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("codex");
    expect(result.stderr).toContain("pi");
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
        { claude: false, opencode: false, codex: true, pi: false },
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
        { claude: false, opencode: false, codex: true, pi: false },
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

  test.skipIf(process.platform === "win32")(
    "preserves UTF-8 provider output split across chunks",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-agent-utf8-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const binDir = join(root, "bin");
      const oldPath = process.env.PATH;
      try {
        await mkdir(binDir, { recursive: true });
        const codex = join(binDir, "codex");
        await Bun.write(
          codex,
          [
            "#!/bin/sh",
            "printf '\\303'",
            "sleep 0.05",
            "printf '\\251\\n'",
            "printf '\\342' >&2",
            "sleep 0.05",
            "printf '\\202\\254\\n' >&2",
            "",
          ].join("\n"),
        );
        await chmod(codex, 0o755);
        process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

        const result = await runAgentStep(
          { prompt: "test" },
          { claude: false, opencode: false, codex: true, pi: false },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("é\n");
        expect(result.stderr).toBe("€\n");
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "dispatches to Pi when only pi is detected",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-agent-pi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const binDir = join(root, "bin");
      const oldPath = process.env.PATH;
      try {
        await mkdir(binDir, { recursive: true });
        const pi = join(binDir, "pi");
        // Stub `pi` echoes its argv and stdin so the test can assert on what
        // the runner actually sent to the binary (provider/model pinning,
        // print mode, prompt via stdin).
        await Bun.write(pi, "#!/bin/sh\nprintf 'args=%s\\n' \"$*\"\nprintf 'stdin='\ncat\n");
        await chmod(pi, 0o755);
        process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

        const result = await runAgentStep(
          { prompt: "do the thing" },
          { claude: false, opencode: false, codex: false, pi: true },
        );

        expect(result.exitCode).toBe(0);
        expect(result.provider).toBe("pi");
        // Pi defaults to google (Exp 42); the runner MUST pin Anthropic.
        expect(result.stdout).toContain("--provider anthropic");
        expect(result.stdout).toContain("--model anthropic/");
        // Token-bounded: `--provider` already contains `-p` as a substring,
        // so a bare `toContain("-p")` would silently pass even if the
        // print-mode flag were dropped. Parse the argv line into tokens
        // and assert standalone `-p` membership.
        const argvLine = result.stdout.split("\n").find((l) => l.startsWith("args="));
        const argv = argvLine?.replace(/^args=/, "").split(/\s+/) ?? [];
        expect(argv).toContain("-p");
        // Prompt arrives via stdin (avoids the `-`-prefix yargs hazard).
        expect(result.stdout).toContain("stdin=do the thing");
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "derives Pi provider from the model namespace",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-agent-pi-model-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const binDir = join(root, "bin");
      const oldPath = process.env.PATH;
      try {
        await mkdir(binDir, { recursive: true });
        const pi = join(binDir, "pi");
        await Bun.write(pi, "#!/bin/sh\nprintf 'args=%s\\n' \"$*\"\ncat >/dev/null\n");
        await chmod(pi, 0o755);
        process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

        const result = await runAgentStep(
          { prompt: "do the thing", piModel: "openai/gpt-5.1" },
          { claude: false, opencode: false, codex: false, pi: true },
        );

        expect(result.exitCode).toBe(0);
        expect(result.provider).toBe("pi");
        expect(result.stdout).toContain("--provider openai-codex");
        expect(result.stdout).toContain("--model openai/gpt-5.1");
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("rejects Pi provider overrides without a matching model override", async () => {
    const result = await runAgentStep(
      { prompt: "do the thing", piProvider: "openai-codex" },
      { claude: false, opencode: false, codex: false, pi: true },
    );

    expect(result.provider).toBe("pi");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("piModel");
  });

  test("rejects Pi provider overrides that disagree with the model namespace", async () => {
    const result = await runAgentStep(
      { prompt: "do the thing", piProvider: "anthropic", piModel: "openai/gpt-5.1" },
      { claude: false, opencode: false, codex: false, pi: true },
    );

    expect(result.provider).toBe("pi");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not match");
    expect(result.stderr).toContain("openai-codex");
  });

  test.skipIf(process.platform === "win32")(
    "rejects unsupported Pi model namespaces before spawning pi",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-agent-pi-unsupported-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const binDir = join(root, "bin");
      const invocationLog = join(root, "pi-invoked.log");
      const oldPath = process.env.PATH;
      try {
        await mkdir(binDir, { recursive: true });
        const pi = join(binDir, "pi");
        await Bun.write(
          pi,
          `#!/bin/sh\nprintf 'invoked\\n' > ${shellEscape(invocationLog)}\nexit 0\n`,
        );
        await chmod(pi, 0o755);
        process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

        const result = await runAgentStep(
          { prompt: "do the thing", piModel: "openrouter/anthropic/claude-sonnet-4-5" },
          { claude: false, opencode: false, codex: false, pi: true },
        );

        expect(result.provider).toBe("pi");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unsupported Pi model namespace");
        expect(result.stderr).toContain("openrouter/anthropic/claude-sonnet-4-5");
        expect(await Bun.file(invocationLog).exists()).toBe(false);
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "treats Pi exit-0-with-provider-error as a runner failure",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-agent-pi-err-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const binDir = join(root, "bin");
      const oldPath = process.env.PATH;
      try {
        await mkdir(binDir, { recursive: true });
        const pi = join(binDir, "pi");
        // Pi exits 0 even on 401 (Exp 43). The runner must scan stdout and
        // surface the failure to the caller so autoresearch / agent loops
        // don't treat the error body as a successful response.
        await Bun.write(
          pi,
          `#!/bin/sh\nprintf '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\\n'\nexit 0\n`,
        );
        await chmod(pi, 0o755);
        process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

        const result = await runAgentStep(
          { prompt: "test" },
          { claude: false, opencode: false, codex: false, pi: true },
        );

        expect(result.provider).toBe("pi");
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("401");
      } finally {
        if (oldPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = oldPath;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not crash when a provider closes stdin early",
    async () => {
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
          { claude: false, opencode: false, codex: true, pi: false },
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
    },
  );

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
        { claude: false, opencode: false, codex: true, pi: false },
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
