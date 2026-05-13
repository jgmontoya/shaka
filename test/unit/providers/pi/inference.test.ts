import { describe, expect, test } from "bun:test";
import { piInference } from "../../../../src/providers/pi/inference";

describe("piInference", () => {
  test("returns stdout text when Pi exits zero", async () => {
    const result = await piInference.run(
      { userPrompt: "summarize this" },
      {
        processRunner: async () => ({
          exitCode: 0,
          stdout: "Model answer",
          stderr: "",
          timedOut: false,
        }),
      },
    );

    expect(result).toMatchObject({
      success: true,
      provider: "pi-cli",
      text: "Model answer",
    });
  });

  test("uses stdout as the diagnostic when Pi exits non-zero with empty stderr", async () => {
    const result = await piInference.run(
      { userPrompt: "summarize this" },
      {
        processRunner: async () => ({
          exitCode: 1,
          stdout: "Not logged in. Run pi /login",
          stderr: "",
          timedOut: false,
        }),
      },
    );

    expect(result).toMatchObject({
      success: false,
      provider: "pi-cli",
      error: "Pi CLI error: Not logged in. Run pi /login",
    });
  });

  test("uses an explicit placeholder when Pi exits non-zero without output", async () => {
    const result = await piInference.run(
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
      provider: "pi-cli",
      error: "Pi CLI error: no output",
    });
  });
});
