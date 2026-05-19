import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { enableHooksFeature } from "../../../../src/providers/codex/cli";

async function runBunScriptWithTimeout(
  scriptPath: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn([process.argv[0] ?? "bun", scriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

describe("codex cli helpers", () => {
  test("enableHooksFeature logs success to stdout, not stderr", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;

    try {
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      };
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };

      await enableHooksFeature(async (args) => {
        expect(args).toEqual(["codex", "features", "enable", "hooks"]);
        return { exitCode: 0, stderr: "" };
      });

      expect(logs).toEqual(["Enabled hooks feature flag in ~/.codex/config.toml"]);
      expect(errors).toEqual([]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test.skipIf(process.platform === "win32")(
    "defaultRunCommand completes when the child writes noisy stdout",
    async () => {
      const root = join(
        tmpdir(),
        `shaka-codex-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const runnerPath = join(root, "run-default-command.ts");
      try {
        await mkdir(root, { recursive: true });
        await Bun.write(
          runnerPath,
          [
            `import { defaultRunCommand } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/providers/codex/cli.ts")).href)};`,
            "const result = await defaultRunCommand([",
            '  "sh",',
            '  "-c",',
            '  "dd if=/dev/zero bs=1024 count=16384 2>/dev/null; printf codex-stderr >&2",',
            "]);",
            "console.log(JSON.stringify(result));",
            "",
          ].join("\n"),
        );

        const result = await runBunScriptWithTimeout(runnerPath, 2000);

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({ exitCode: 0, stderr: "codex-stderr" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
