import { describe, expect, test } from "bun:test";
import { runAgentStep } from "../../../src/domain/agent-execution";

const NO_PROVIDERS = { claude: false, opencode: false, codex: false } as const;

describe("agent-execution", () => {
  test("module exports runAgentStep", () => {
    expect(typeof runAgentStep).toBe("function");
  });

  test("returns error when no provider is available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No agent provider available");
  });

  test("error message names all three providers when none are available", async () => {
    const result = await runAgentStep({ prompt: "test" }, NO_PROVIDERS);

    expect(result.stderr).toContain("claude");
    expect(result.stderr).toContain("opencode");
    expect(result.stderr).toContain("codex");
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
});
