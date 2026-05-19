import { describe, expect, test } from "bun:test";
import { claudeInference } from "../../../../src/providers/claude/inference";
import type { ProcessInvocation, ProcessResult } from "../../../../src/platform/process-runner";

function successResult(stdout = "OK"): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("claudeInference", () => {
  test("invokes Claude print mode with containment flags and stdin prompt", async () => {
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldShakaToken = process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
    let invocation: ProcessInvocation | undefined;

    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;

      const result = await claudeInference.run(
        {
          userPrompt: "summarize this",
          systemPrompt: "be concise",
          model: "sonnet",
          timeout: 12_000,
        },
        {
          processRunner: async (nextInvocation) => {
            invocation = nextInvocation;
            return successResult();
          },
        },
      );

      expect(result).toMatchObject({ success: true, text: "OK", provider: "claude-cli" });
      expect(invocation).toEqual({
        command: "claude",
        args: [
          "--setting-sources",
          "",
          "--tools",
          "",
          "--no-session-persistence",
          "--model",
          "sonnet",
          "--system-prompt",
          "be concise",
          "-p",
        ],
        stdin: "summarize this",
        timeout: 12_000,
        env: undefined,
      });
    } finally {
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
    }
  });

  test("uses stdout as the diagnostic when Claude exits non-zero with empty stderr", async () => {
    const result = await claudeInference.run(
      { userPrompt: "summarize this" },
      {
        processRunner: async () => ({
          exitCode: 1,
          stdout: "OAuth token unavailable to hook child",
          stderr: "",
          timedOut: false,
        }),
      },
    );

    expect(result).toMatchObject({
      success: false,
      provider: "claude-cli",
      error: "Claude CLI error: OAuth token unavailable to hook child",
    });
  });

  test("bridges Shaka's hook-scoped Claude token into the child Claude CLI env", async () => {
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldShakaToken = process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
    let invocation: ProcessInvocation | undefined;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN = "from-shaka-hook";

      await claudeInference.run(
        { userPrompt: "summarize this" },
        {
          processRunner: async (nextInvocation) => {
            invocation = nextInvocation;
            return successResult();
          },
        },
      );

      expect(invocation?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "from-shaka-hook" });
    } finally {
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
    }
  });
});
