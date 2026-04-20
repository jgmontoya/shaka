import { describe, expect, test } from "bun:test";
import { runWizard } from "../../../src/commands/autoresearch-wizard";

function scriptedAsk(answers: string[]): (q: string, defaultValue?: string) => Promise<string> {
  let i = 0;
  return async (_q: string, defaultValue?: string) => {
    const raw = answers[i++];
    if (raw === undefined) throw new Error(`wizard asked more questions than scripted (${i})`);
    return raw === "" && defaultValue !== undefined ? defaultValue : raw;
  };
}

describe("runWizard", () => {
  test("collects the user's answers in order and returns WizardAnswers", async () => {
    const ask = scriptedAsk([
      "bun test", // benchmark command
      "minimize", // direction
      "s", // unit
      "bun test --only correctness", // checks
      "test/**/*.test.ts", // files in scope
      "must pass just check", // constraints
    ]);

    const answers = await runWizard({ objective: "speed up tests", ask });

    expect(answers.objective).toBe("speed up tests");
    expect(answers.benchmarkCommand).toBe("bun test");
    expect(answers.direction).toBe("minimize");
    expect(answers.unit).toBe("s");
    expect(answers.checksCommand).toBe("bun test --only correctness");
    expect(answers.filesInScope).toBe("test/**/*.test.ts");
    expect(answers.constraints).toBe("must pass just check");
  });

  test("falls back to sensible defaults for blank direction/unit", async () => {
    const ask = scriptedAsk([
      "bun bench",
      "", // direction → default minimize
      "", // unit → default ms
      "", // checks → skipped
      "", // files → skipped
      "", // constraints → skipped
    ]);

    const answers = await runWizard({ objective: "x", ask });

    expect(answers.direction).toBe("minimize");
    expect(answers.unit).toBe("ms");
    expect(answers.checksCommand).toBe("");
    expect(answers.filesInScope).toBe("");
    expect(answers.constraints).toBe("");
  });

  test("treats any direction other than 'maximize' as 'minimize' (fuzzy by default)", async () => {
    const ask = scriptedAsk(["cmd", "MAXIMIZE", "ms", "", "", ""]);
    expect((await runWizard({ objective: "x", ask })).direction).toBe("maximize");
  });

  test("requires a non-empty benchmark command", async () => {
    const ask = scriptedAsk(["", "bun test", "minimize", "ms", "", "", ""]);
    // First empty answer is re-asked; second non-empty is accepted.
    const answers = await runWizard({ objective: "x", ask });
    expect(answers.benchmarkCommand).toBe("bun test");
  });
});
