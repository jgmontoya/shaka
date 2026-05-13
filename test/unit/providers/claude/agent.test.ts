import { describe, expect, test } from "bun:test";
import { claudeAgentExecution } from "../../../../src/providers/claude/agent";
import type { ProcessInvocation } from "../../../../src/platform/process-runner";

describe("claudeAgentExecution", () => {
  test("bridges Shaka's hook-scoped Claude token into the child Claude CLI env", async () => {
    const oldClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const oldShakaToken = process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
    let invocation: ProcessInvocation | undefined;
    try {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      process.env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN = "from-shaka-hook";

      await claudeAgentExecution.run(
        { prompt: "build this", timeout: 12_000 },
        {
          processRunner: async (nextInvocation) => {
            invocation = nextInvocation;
            return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
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
