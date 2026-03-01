import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearDetectionCache } from "../../../src/services/provider-detection";

describe("agent-execution", () => {
  beforeEach(() => {
    clearDetectionCache();
  });

  afterEach(() => {
    clearDetectionCache();
  });

  test("module exports runAgentStep", async () => {
    const mod = await import("../../../src/domain/agent-execution");
    expect(typeof mod.runAgentStep).toBe("function");
  });

  test("returns error when no provider available", async () => {
    // Temporarily override Bun.which to return null for all providers
    const originalWhich = Bun.which;
    (Bun as Record<string, unknown>).which = () => null;
    clearDetectionCache();

    try {
      const { runAgentStep } = await import("../../../src/domain/agent-execution");
      const result = await runAgentStep({ prompt: "test" });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No agent provider available");
    } finally {
      (Bun as Record<string, unknown>).which = originalWhich;
      clearDetectionCache();
    }
  });
});
