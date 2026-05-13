import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

async function readEventually(path: string, timeoutMs = 250): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) return file.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Prefer a message naming the polling contract over the ENOENT the final
  // .text() would otherwise throw — helps readers diagnose "did the writer
  // never run?" vs "did the path I pass in even exist?"
  if (!(await Bun.file(path).exists())) {
    throw new Error(`readEventually: ${path} did not appear within ${timeoutMs}ms`);
  }
  return Bun.file(path).text();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("inference", () => {
  describe("hasInferenceProvider", () => {
    test("returns true when codex is the only installed provider", async () => {
      const { hasInferenceProvider } = await import("../../src/inference");
      const result = await hasInferenceProvider({
        claude: false,
        opencode: false,
        codex: true,
        pi: false,
      });
      expect(result).toBe(true);
    });

    test("returns true when pi is the only installed provider", async () => {
      const { hasInferenceProvider } = await import("../../src/inference");
      const result = await hasInferenceProvider({
        claude: false,
        opencode: false,
        codex: false,
        pi: true,
      });
      expect(result).toBe(true);
    });

    test("returns false when no providers are installed", async () => {
      const { hasInferenceProvider } = await import("../../src/inference");
      const result = await hasInferenceProvider({
        claude: false,
        opencode: false,
        codex: false,
        pi: false,
      });
      expect(result).toBe(false);
    });
  });

  describe("parseOpencodeJsonStream", () => {
    test("extracts session ID from the first step_start event", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const stream =
        '{"type":"step_start","sessionID":"ses_abc123","part":{}}\n' +
        '{"type":"text","part":{"text":"hello"}}\n';
      const result = parseOpencodeJsonStream(stream);
      expect(result.sessionId).toBe("ses_abc123");
    });

    test("concatenates text from all type:text events in stream order", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const stream =
        '{"type":"step_start","sessionID":"ses_abc"}\n' +
        '{"type":"text","part":{"text":"hello "}}\n' +
        '{"type":"text","part":{"text":"world"}}\n' +
        '{"type":"step_finish"}\n';
      const result = parseOpencodeJsonStream(stream);
      expect(result.text).toBe("hello world");
    });

    test("ignores malformed JSON lines while preserving valid text events", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const stream =
        '{"type":"text","part":{"text":"hello "}}\n' +
        "not json\n" +
        '{"type":"text","part":{"text":"world"}}\n';
      const result = parseOpencodeJsonStream(stream);
      expect(result.text).toBe("hello world");
    });

    test("returns null sessionId when no step_start event is present", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const result = parseOpencodeJsonStream('{"type":"text","part":{"text":"hello"}}\n');
      expect(result.sessionId).toBeNull();
    });
  });

  describe("parseResponse", () => {
    test("parses JSON arrays when expectJson is enabled", async () => {
      const { parseResponse } = await import("../../src/inference");

      const result = parseResponse('[{"status":"ok"}]', true, "test-provider");

      expect(result).toEqual({
        success: true,
        text: '[{"status":"ok"}]',
        parsed: [{ status: "ok" }],
        provider: "test-provider",
      });
    });
  });

  describe("inference()", () => {
    test("error message names all four providers when none are available", async () => {
      const { inference } = await import("../../src/inference");
      const result = await inference(
        { userPrompt: "test" },
        { claude: false, opencode: false, codex: false, pi: false },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("claude");
      expect(result.error).toContain("opencode");
      expect(result.error).toContain("codex");
      expect(result.error).toContain("pi");
    });

    test("continues to fallback providers when one provider rejects", async () => {
      const { claudeProvider } = await import("../../src/providers/claude/provider");
      const { opencodeProvider } = await import("../../src/providers/opencode/provider");
      const originalClaudeRun = claudeProvider.inference.run;
      const originalOpencodeRun = opencodeProvider.inference.run;
      try {
        claudeProvider.inference.run = async () => {
          throw new Error("claude exploded");
        };
        opencodeProvider.inference.run = async () => ({
          success: true,
          text: "fallback ok",
          provider: "opencode-cli",
        });

        const { inference } = await import("../../src/inference");
        const result = await inference(
          { userPrompt: "test" },
          { claude: true, opencode: true, codex: false, pi: false },
        );

        expect(result).toEqual({
          success: true,
          text: "fallback ok",
          provider: "opencode-cli",
        });
      } finally {
        claudeProvider.inference.run = originalClaudeRun;
        opencodeProvider.inference.run = originalOpencodeRun;
      }
    });

    test.skipIf(process.platform === "win32")(
      "includes Claude stdout in failure messages when stderr is empty",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-claude-stdout-error-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const claude = join(binDir, "claude");
          await Bun.write(
            claude,
            "#!/bin/sh\nprintf 'Not logged in · Please run /login\\n'\nexit 1\n",
          );
          await chmod(claude, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "test" },
            { claude: true, opencode: false, codex: false, pi: false },
          );

          expect(result.success).toBe(false);
          expect(result.error).toContain("Not logged in");
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
      "maps Shaka's Claude hook auth bridge env var to Claude's expected token name",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-claude-auth-bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        const oldShakaToken = process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
        try {
          await mkdir(binDir, { recursive: true });
          const claude = join(binDir, "claude");
          await Bun.write(claude, "#!/bin/sh\nprintf 'token=%s\\n' \"$CLAUDE_CODE_OAUTH_TOKEN\"\n");
          await chmod(claude, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
          process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN = "from-shaka-hook";

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "test" },
            { claude: true, opencode: false, codex: false, pi: false },
          );

          expect(result.success).toBe(true);
          expect(result.text).toBe("token=from-shaka-hook");
        } finally {
          if (oldPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = oldPath;
          }
          if (oldClaudeToken === undefined) {
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
          } else {
            process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaudeToken;
          }
          if (oldShakaToken === undefined) {
            delete process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
          } else {
            process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN = oldShakaToken;
          }
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    test.skipIf(process.platform === "win32")(
      "Codex inference uses distinct output files for concurrent calls",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-codex-output-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const captureFile = join(root, "outputs.txt");
        const oldPath = process.env.PATH;
        const originalDateNow = Date.now;
        try {
          await mkdir(binDir, { recursive: true });
          const codex = join(binDir, "codex");
          await Bun.write(
            codex,
            [
              "#!/bin/sh",
              "output=",
              'while [ "$#" -gt 0 ]; do',
              '  if [ "$1" = "-o" ]; then',
              "    shift",
              '    output="$1"',
              "  fi",
              "  shift",
              "done",
              `printf '%s\\n' "$output" >> ${shellQuote(captureFile)}`,
              'printf "codex ok\\n" > "$output"',
              "",
            ].join("\n"),
          );
          await chmod(codex, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
          Date.now = () => 1234567890;

          const { inference } = await import("../../src/inference");
          const [first, second] = await Promise.all([
            inference(
              { userPrompt: "first" },
              { claude: false, opencode: false, codex: true, pi: false },
            ),
            inference(
              { userPrompt: "second" },
              { claude: false, opencode: false, codex: true, pi: false },
            ),
          ]);

          expect(first.success).toBe(true);
          expect(second.success).toBe(true);
          const outputs = (await Bun.file(captureFile).text()).trim().split("\n");
          expect(new Set(outputs).size).toBe(2);
        } finally {
          Date.now = originalDateNow;
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
      "OpenCode inference selects the hidden inference agent by frontmatter name",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-opencode-agent-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const captureFile = join(root, "capture.txt");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const opencode = join(binDir, "opencode");
          await Bun.write(
            opencode,
            [
              "#!/bin/sh",
              `printf 'argv=%s\\n' "$*" > ${shellQuote(captureFile)}`,
              `printf 'env_subagent=%s\\n' "$SHAKA_OPENCODE_SUBAGENT" >> ${shellQuote(captureFile)}`,
              'printf \'%s\\n\' \'{"type":"text","part":{"text":"OK"}}\'',
              "",
            ].join("\n"),
          );
          await chmod(opencode, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "classify this", timeout: 1000 },
            { claude: false, opencode: true, codex: false, pi: false },
          );

          expect(result).toMatchObject({ success: true, text: "OK", provider: "opencode-cli" });
          const captured = await Bun.file(captureFile).text();
          expect(captured).toContain("--agent inference");
          expect(captured).not.toContain("shaka/inference");
          expect(captured).toContain("env_subagent=true");
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
      "pins Pi inference to anthropic + full isolation flag set + SHAKA_PI_SUBAGENT env",
      async () => {
        // Pi inference must:
        //  - pin --provider anthropic + --model anthropic/<id> (Pi defaults to google per Exp 42)
        //  - disable EVERY discovery surface (Exp 47, 51 — per-resource isolation)
        //  - replace the systemPrompt fully (Exp 45 — Pi's default embeds self-doc)
        //  - set SHAKA_PI_SUBAGENT=true so the generated extension early-returns
        //  - set PI_TELEMETRY=0 + PI_OFFLINE=1 to keep the call hermetic
        const root = join(
          tmpdir(),
          `shaka-inference-pi-argv-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const captureFile = join(root, "capture.txt");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          await Bun.write(
            pi,
            [
              "#!/bin/sh",
              `printf 'argv=%s\\n' "$*" > ${shellQuote(captureFile)}`,
              `printf 'env_subagent=%s\\n' "$SHAKA_PI_SUBAGENT" >> ${shellQuote(captureFile)}`,
              `printf 'env_telemetry=%s\\n' "$PI_TELEMETRY" >> ${shellQuote(captureFile)}`,
              `printf 'env_offline=%s\\n' "$PI_OFFLINE" >> ${shellQuote(captureFile)}`,
              "echo OK",
              "",
            ].join("\n"),
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          await inference(
            {
              userPrompt: "test",
              systemPrompt: "you are a classifier",
              model: "anthropic/claude-sonnet-4-5",
            },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          const captured = await Bun.file(captureFile).text();
          // Provider/model pinning
          expect(captured).toContain("--provider anthropic");
          expect(captured).toContain("--model anthropic/claude-sonnet-4-5");
          // Isolation flag set
          expect(captured).toContain("--no-extensions");
          expect(captured).toContain("--no-tools");
          expect(captured).toContain("--no-session");
          expect(captured).toContain("--no-skills");
          expect(captured).toContain("--no-prompt-templates");
          expect(captured).toContain("--no-context-files");
          expect(captured).toContain("--offline");
          // Print mode + system prompt. Token-bounded match on `-p` —
          // `--provider anthropic` already contains `-p` as a substring,
          // so a bare `toContain("-p")` would silently pass even if the
          // print-mode flag got dropped.
          expect(captured).toMatch(/(?:^|[\s=])-p(?:\s|$)/m);
          expect(captured).toContain("--system-prompt");
          expect(captured).toContain("you are a classifier");
          // Env: full Pi isolation contract. PI_OFFLINE=1 was added in
          // round-3 cycle-2 (provider-derive work) and assertion was
          // missing here — a regression slipped through three review
          // rounds before the bot's persistence caught it.
          expect(captured).toContain("env_subagent=true");
          expect(captured).toContain("env_telemetry=0");
          expect(captured).toContain("env_offline=1");
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

    // Coverage gap: spawnCLI's TERM → grace → KILL escalation is
    // structurally testable but not behaviorally — the API doesn't
    // expose the spawned PID, so we can't verify the process actually
    // died vs. just that resolve fired. Mirrors runAgentStep's
    // established pattern at src/domain/agent-execution.ts:160.
    test.skipIf(process.platform === "win32")(
      "Pi inference fails fast on an unknown model namespace instead of mismapping to anthropic",
      async () => {
        // Round-5 cycle 9 mapped unknown prefixes to "anthropic" by
        // default. That recreates the contradictory-flag bug for inputs
        // like `openrouter/anthropic/claude-...` — Pi gets
        // `--provider anthropic --model openrouter/anthropic/...` and
        // crashes. Surface a clean error before spawning Pi.
        const root = join(
          tmpdir(),
          `shaka-inference-pi-unknown-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          // Stub `pi` writes a sentinel so we can assert it was NEVER called.
          const pi = join(binDir, "pi");
          const sentinel = join(root, "pi-was-called.flag");
          await Bun.write(
            pi,
            ["#!/bin/sh", `: > ${shellQuote(sentinel)}`, "exit 0", ""].join("\n"),
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            {
              userPrompt: "test",
              systemPrompt: "system",
              model: "openrouter/anthropic/claude-sonnet-4-5",
            },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          expect(result.success).toBe(false);
          if (!result.success) {
            expect((result.error ?? "").toLowerCase()).toMatch(
              /unsupported|unknown.*namespace|openrouter/,
            );
          }
          expect(await Bun.file(sentinel).exists()).toBe(false);
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
      "Pi inference fails fast on bare model aliases instead of guessing a provider",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-pi-bare-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          const sentinel = join(root, "pi-was-called.flag");
          await Bun.write(
            pi,
            ["#!/bin/sh", `: > ${shellQuote(sentinel)}`, "exit 0", ""].join("\n"),
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            {
              userPrompt: "test",
              model: "claude-haiku-4.5",
            },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error ?? "").toContain("Unsupported Pi model namespace");
            expect(result.error ?? "").toContain("claude-haiku-4.5");
          }
          expect(await Bun.file(sentinel).exists()).toBe(false);
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
      "Pi inference suppresses Pi's default system prompt when caller omits one",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-pi-empty-system-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const captureFile = join(root, "argv.txt");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          await Bun.write(
            pi,
            [
              "#!/bin/sh",
              "i=0",
              'for arg in "$@"; do',
              `  printf 'arg_%s=%s\\n' "$i" "$arg" >> ${shellQuote(captureFile)}`,
              "  i=$((i + 1))",
              "done",
              "echo OK",
              "",
            ].join("\n"),
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            {
              userPrompt: "test",
              model: "anthropic/claude-sonnet-4-5",
            },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          expect(result.success).toBe(true);
          const lines = (await Bun.file(captureFile).text()).trimEnd().split("\n");
          const systemPromptIndex = lines.findIndex((line) => line.endsWith("=--system-prompt"));
          expect(systemPromptIndex).toBeGreaterThanOrEqual(0);
          expect(lines[systemPromptIndex + 1]).toMatch(/^arg_\d+=$/);
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
      "Pi inference maps openai/<model> to Pi's openai-codex provider (Exp 48)",
      async () => {
        // Pi's actual provider name for OpenAI-backed models is
        // "openai-codex" (verified Exp 48), not bare "openai". A naive
        // prefix split would send Pi an unknown provider value.
        const root = join(
          tmpdir(),
          `shaka-inference-pi-codex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const captureFile = join(root, "capture.txt");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          await Bun.write(
            pi,
            [
              "#!/bin/sh",
              `printf 'argv=%s\\n' "$*" > ${shellQuote(captureFile)}`,
              "echo OK",
              "",
            ].join("\n"),
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          await inference(
            {
              userPrompt: "test",
              systemPrompt: "system",
              model: "openai/gpt-5",
            },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          const captured = await Bun.file(captureFile).text();
          expect(captured).toContain("--provider openai-codex");
          expect(captured).toContain("--model openai/gpt-5");
          // Token-boundary regex catches both mid-argv and end-of-argv shapes —
          // a literal substring miss would silently pass on the trailing case.
          expect(captured).not.toMatch(/--provider\s+openai(?:\s|$)/m);
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
      "treats Pi exit-0-with-401 as inference failure (Exp 43)",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-pi-401-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          await Bun.write(
            pi,
            `#!/bin/sh\nprintf '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}\\n'\nexit 0\n`,
          );
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "test" },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toContain("401");
            expect(result.error).toContain("authentication_error");
          }
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
      "dispatches inference to Pi when only pi is detected",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-pi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const pi = join(binDir, "pi");
          // Stub Pi binary returns plain text — exercises the parseResponse path.
          await Bun.write(pi, "#!/bin/sh\nprintf 'OK\\n'\nexit 0\n");
          await chmod(pi, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "test" },
            { claude: false, opencode: false, codex: false, pi: true },
          );

          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.text).toContain("OK");
            expect(result.provider).toBe("pi-cli");
          }
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
      "enforces timeout for OpenCode CLI inference",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-opencode-timeout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const opencode = join(binDir, "opencode");
          await Bun.write(
            opencode,
            '#!/bin/sh\nsleep 0.3\nprintf \'%s\\n\' \'{"type":"text","part":{"text":"late success"}}\'\n',
          );
          await chmod(opencode, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const start = performance.now();
          const result = await inference(
            { userPrompt: "slow", timeout: 25 },
            { claude: false, opencode: true, codex: false, pi: false },
          );
          const elapsedMs = performance.now() - start;

          expect(result.success).toBe(false);
          expect(result.error).toContain("Timeout after 25ms");
          expect(elapsedMs).toBeLessThan(500);
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
      "cleans up OpenCode sessions discovered before timeout",
      async () => {
        const root = join(
          tmpdir(),
          `shaka-inference-opencode-timeout-cleanup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const binDir = join(root, "bin");
        const cleanupFile = join(root, "cleanup.txt");
        const oldPath = process.env.PATH;
        try {
          await mkdir(binDir, { recursive: true });
          const opencode = join(binDir, "opencode");
          await Bun.write(
            opencode,
            [
              "#!/bin/sh",
              'if [ "$1" = "--pure" ] && [ "$2" = "session" ] && [ "$3" = "delete" ]; then',
              `  printf "%s" "$4" > ${shellQuote(cleanupFile)}`,
              "  exit 0",
              "fi",
              'echo \'{"type":"step_start","sessionID":"ses_timeout_cleanup"}\'',
              "sleep 2",
              "",
            ].join("\n"),
          );
          await chmod(opencode, 0o755);
          process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;

          const { inference } = await import("../../src/inference");
          const result = await inference(
            { userPrompt: "slow", timeout: 1000 },
            { claude: false, opencode: true, codex: false, pi: false },
          );

          expect(result.success).toBe(false);
          expect(result.error).toContain("Timeout after 1000ms");
          await expect(readEventually(cleanupFile, 1000)).resolves.toBe("ses_timeout_cleanup");
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
  });

  describe("resolveInferenceAttempts", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-inference-attempts");
    const savedShakaHome = process.env.SHAKA_HOME;

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
      process.env.SHAKA_HOME = testShakaHome;
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      if (savedShakaHome === undefined) {
        delete process.env.SHAKA_HOME;
      } else {
        process.env.SHAKA_HOME = savedShakaHome;
      }
    });

    test("resolves winning provider's summarization_model when caller omits model", async () => {
      // Config: claude has an explicit summarization_model; opencode has its own.
      // Both are installed — claude wins by priority and its model is used first.
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: true, opencode: true, codex: false, pi: false },
      );

      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({ provider: "claude", model: "sonnet" });
      expect(attempts[1]).toEqual({
        provider: "opencode",
        model: "openrouter/anthropic/claude-haiku-4.5",
      });
    });

    test("explicit options.model overrides per-provider config", async () => {
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi", model: "opus" },
        { claude: true, opencode: true, codex: false, pi: false },
      );

      // Explicit model wins for every attempt — config is ignored entirely.
      for (const attempt of attempts) {
        expect(attempt.model).toBe("opus");
      }
    });

    test("skips providers that are not installed", async () => {
      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: false, opencode: true, codex: false, pi: false },
      );

      expect(attempts.length).toBe(1);
      expect(attempts[0]?.provider).toBe("opencode");
    });

    test("returns empty array when no providers are installed", async () => {
      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: false, opencode: false, codex: false, pi: false },
      );

      expect(attempts).toEqual([]);
    });

    test("prefers hinted provider and resolves its summarization_model", async () => {
      // When the caller passes a `provider` hint, that provider moves to the
      // head of the attempt list even if a higher-priority provider is also
      // installed. Other installed providers remain as fallbacks.
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi", provider: "opencode" },
        { claude: true, opencode: true, codex: false, pi: false },
      );

      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({
        provider: "opencode",
        model: "openrouter/anthropic/claude-haiku-4.5",
      });
      expect(attempts[1]).toEqual({ provider: "claude", model: "sonnet" });
    });
  });
});
