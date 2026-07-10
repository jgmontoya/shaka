import { describe, expect, test } from "bun:test";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../src/platform/process-runner";

describe("process-runner", () => {
  test.skipIf(process.platform === "win32")(
    "captures stdout/stderr and forwards args, stdin, cwd, and env",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-basic-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const workDir = join(root, "work");
      const script = join(root, "probe");
      try {
        await mkdir(workDir, { recursive: true });
        await Bun.write(
          script,
          [
            "#!/bin/sh",
            'printf "cwd=%s\\n" "$(pwd)"',
            'printf "args=%s\\n" "$*"',
            'printf "env=%s\\n" "$RUNNER_ENV"',
            'printf "stdin="',
            "cat",
            'printf "stderr-ok\\n" >&2',
            "",
          ].join("\n"),
        );
        await chmod(script, 0o755);

        const result = await runProcess({
          command: script,
          args: ["one", "two"],
          stdin: "hello",
          cwd: workDir,
          env: { RUNNER_ENV: "yes" },
          timeout: 1000,
        });

        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
        expect(result.stdout).toContain(`cwd=${await realpath(workDir)}`);
        expect(result.stdout).toContain("args=one two");
        expect(result.stdout).toContain("env=yes");
        expect(result.stdout).toContain("stdin=hello");
        expect(result.stderr).toBe("stderr-ok\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")("preserves split UTF-8 stdout and stderr", async () => {
    const root = join(
      tmpdir(),
      `shaka-process-runner-utf8-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const script = join(root, "utf8");
    try {
      await mkdir(root, { recursive: true });
      await Bun.write(
        script,
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
      await chmod(script, 0o755);

      const result = await runProcess({ command: script, timeout: 1000 });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("é\n");
      expect(result.stderr).toBe("€\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "does not misclassify a process that exited while inherited streams are still draining",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-drain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const script = join(root, "drain");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(
          script,
          [
            "#!/usr/bin/env bun",
            'import { spawn } from "node:child_process";',
            'const child = spawn("sh", ["-c", "sleep 0.7; printf late"], {',
            '  stdio: ["ignore", "inherit", "inherit"],',
            "});",
            "child.unref();",
            "process.exit(0);",
            "",
          ].join("\n"),
        );
        await chmod(script, 0o755);

        const result = await runProcess({ command: script, timeout: 500, killGraceMs: 25 });

        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toBe("late");
        expect(result.stderr).not.toContain("Timeout after");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "escalates timed-out processes to SIGKILL",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-timeout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const script = join(root, "hang");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(
          script,
          [
            "#!/bin/sh",
            "exec bun -e 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'",
            "",
          ].join("\n"),
        );
        await chmod(script, 0o755);

        const start = performance.now();
        const result = await runProcess({ command: script, timeout: 50, killGraceMs: 50 });
        const elapsedMs = performance.now() - start;

        expect(result.exitCode).toBe(1);
        expect(result.timedOut).toBe(true);
        expect(result.stderr).toContain("Timeout after 50ms");
        expect(elapsedMs).toBeLessThan(2000);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "honors timeout 0 as an immediate timeout",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-zero-timeout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const script = join(root, "hang");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(
          script,
          [
            "#!/bin/sh",
            "exec bun -e 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'",
            "",
          ].join("\n"),
        );
        await chmod(script, 0o755);

        const result = await runProcess({ command: script, timeout: 0, killGraceMs: 25 });

        expect(result.exitCode).toBe(1);
        expect(result.timedOut).toBe(true);
        expect(result.stderr).toContain("Timeout after 0ms");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "returns after kill grace when descendants keep stdio open",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-timeout-descendant-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const script = join(root, "hang-with-descendant");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(
          script,
          [
            "#!/bin/sh",
            "(sleep 1) &",
            "exec bun -e 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000);'",
            "",
          ].join("\n"),
        );
        await chmod(script, 0o755);

        const start = performance.now();
        const result = await runProcess({ command: script, timeout: 25, killGraceMs: 25 });
        const elapsedMs = performance.now() - start;

        expect(result.exitCode).toBe(1);
        expect(result.timedOut).toBe(true);
        expect(result.stderr).toContain("Timeout after 25ms");
        expect(elapsedMs).toBeLessThan(500);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not crash when a child closes stdin before a large write completes",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-process-runner-stdin-close-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const script = join(root, "close-stdin");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(script, "#!/bin/sh\nexit 7\n");
        await chmod(script, 0o755);

        const result = await runProcess({
          command: script,
          stdin: "x".repeat(8 * 1024 * 1024),
          timeout: 1000,
        });

        expect(result.exitCode).toBe(7);
        expect(result.timedOut).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("returns a structured failure when the process cannot spawn", async () => {
    const result = await runProcess({
      command: `shaka-missing-command-${process.pid}-${Date.now()}`,
      timeout: 1000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
