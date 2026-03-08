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

  test("buildAgentInvocation wires continue and cwd for claude", async () => {
    const { buildAgentInvocation } = await import("../../../src/domain/agent-execution");
    const invocation = buildAgentInvocation("claude", {
      prompt: "fix tests",
      cwd: "/tmp/project",
      continueSession: true,
    });

    expect(invocation).toEqual({
      command: "claude",
      args: ["-p", "--continue"],
      stdin: "fix tests",
      cwd: "/tmp/project",
    });
  });

  test("buildAgentInvocation wires continue and cwd for opencode", async () => {
    const { buildAgentInvocation } = await import("../../../src/domain/agent-execution");
    const invocation = buildAgentInvocation("opencode", {
      prompt: "fix tests",
      cwd: "/tmp/project",
      continueSession: true,
    });

    expect(invocation).toEqual({
      command: "opencode",
      args: ["run", "--agent", "coder", "--continue", "fix tests"],
      stdin: "",
      cwd: "/tmp/project",
    });
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
