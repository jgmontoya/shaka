import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearDetectionCache } from "../../src/services/provider-detection";

describe("inference", () => {
  beforeEach(() => {
    clearDetectionCache();
  });

  afterEach(() => {
    clearDetectionCache();
  });

  describe("hasInferenceProvider", () => {
    test("returns true when codex is available", async () => {
      const originalWhich = Bun.which;
      // Only codex is installed, not claude or opencode
      (Bun as Record<string, unknown>).which = (name: string) =>
        name === "codex" ? "/usr/local/bin/codex" : null;
      clearDetectionCache();

      try {
        const { hasInferenceProvider } = await import("../../src/inference");
        const result = await hasInferenceProvider();
        expect(result).toBe(true);
      } finally {
        (Bun as Record<string, unknown>).which = originalWhich;
        clearDetectionCache();
      }
    });
  });

  describe("inference()", () => {
    test("error message includes codex when no providers available", async () => {
      const originalWhich = Bun.which;
      (Bun as Record<string, unknown>).which = () => null;
      clearDetectionCache();

      try {
        const { inference } = await import("../../src/inference");
        const result = await inference({ userPrompt: "test" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("codex");
      } finally {
        (Bun as Record<string, unknown>).which = originalWhich;
        clearDetectionCache();
      }
    });
  });
});
