import { describe, expect, test } from "bun:test";
import { codexInference } from "../../../../src/providers/codex/inference";

describe("codexInference", () => {
  test("uses stdout as the diagnostic when Codex exits non-zero with empty stderr", async () => {
    const result = await codexInference.run(
      { userPrompt: "summarize this" },
      {
        processRunner: async () => ({
          exitCode: 1,
          stdout: "Not logged in. Run codex login",
          stderr: "",
          timedOut: false,
        }),
      },
    );

    expect(result).toMatchObject({
      success: false,
      provider: "codex-cli",
      error: "Codex CLI error: Not logged in. Run codex login",
    });
  });

  test("uses an explicit placeholder when Codex exits non-zero without output", async () => {
    const result = await codexInference.run(
      { userPrompt: "summarize this" },
      {
        processRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
        }),
      },
    );

    expect(result).toMatchObject({
      success: false,
      provider: "codex-cli",
      error: "Codex CLI error: no output",
    });
  });
});
