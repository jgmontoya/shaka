import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Pi E2E script", () => {
  test("preserves parent env when evaluating shell conditions", async () => {
    expect(
      await evaluateHasAuth(
        '[ "$HOME" = "/tmp/shaka-parent-home" ] && [ "$AUTH_JSON" = "auth" ]',
        "auth",
        {},
        { HOME: "/tmp/shaka-parent-home" },
      ),
    ).toBe(true);
  });

  test("extracts auth condition across CRLF and indentation-only shell formatting changes", async () => {
    const script = [
      "AUTH_JSON=/tmp/auth.json",
      "HAS_AUTH=false",
      'if { [ -f "$AUTH_JSON" ] && [ -s "$AUTH_JSON" ]; } || \\',
      '   [ -n "${ANTHROPIC_API_KEY:-}" ]; then',
      "\tHAS_AUTH=true",
      "fi",
      "",
    ].join("\r\n");

    const condition = extractHasAuthCondition(script);

    expect(
      await evaluateHasAuth(condition, "/tmp/missing-auth.json", {
        ANTHROPIC_API_KEY: "test-key",
      }),
    ).toBe(true);
  });

  test("treats auth.json as credentials only when it is a non-empty regular file", async () => {
    const script = await Bun.file("test/e2e/pi.sh").text();
    const condition = extractHasAuthCondition(script);
    const root = join(tmpdir(), `shaka-pi-script-auth-${process.pid}-${Date.now()}`);

    try {
      await mkdir(join(root, "dir-auth", "auth.json"), { recursive: true });
      await mkdir(join(root, "file-auth"), { recursive: true });
      await Bun.write(join(root, "file-auth", "auth.json"), "{}");
      await mkdir(join(root, "empty-auth"), { recursive: true });
      await Bun.write(join(root, "empty-auth", "auth.json"), "");

      expect(
        await evaluateHasAuth(condition, join(root, "dir-auth", "auth.json"), {
          ANTHROPIC_API_KEY: "",
        }),
      ).toBe(false);
      expect(await evaluateHasAuth(condition, join(root, "file-auth", "auth.json"), {})).toBe(true);
      expect(
        await evaluateHasAuth(condition, join(root, "empty-auth", "auth.json"), {
          ANTHROPIC_API_KEY: "",
        }),
      ).toBe(false);
      expect(
        await evaluateHasAuth(condition, join(root, "missing", "auth.json"), {
          ANTHROPIC_API_KEY: "test-key",
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function extractHasAuthCondition(script: string): string {
  const normalizedScript = script.replace(/\r\n/g, "\n");
  const match = normalizedScript.match(
    /HAS_AUTH=false\nif (?<condition>[\s\S]*?); then\s*\n[ \t]*HAS_AUTH=true\s*\nfi/,
  );
  const condition = match?.groups?.condition;
  if (!condition) throw new Error("Could not find HAS_AUTH condition in test/e2e/pi.sh");
  return condition.replace(/\\\n/g, "\n");
}

async function evaluateHasAuth(
  condition: string,
  authJson: string,
  env: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const proc = Bun.spawn(["bash", "-c", `if ${condition}; then echo true; else echo false; fi`], {
    env: {
      ...parentEnv,
      AUTH_JSON: authJson,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`HAS_AUTH condition failed: ${stderr}`);
  return stdout.trim() === "true";
}
