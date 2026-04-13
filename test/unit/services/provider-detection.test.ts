import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getProviderNames } from "../../../src/providers/registry";
import {
  type DetectedProviders,
  clearDetectionCache,
  detectInstalledProviders,
  isProviderInstalled,
} from "../../../src/services/provider-detection";

describe("provider-detection", () => {
  afterEach(() => {
    clearDetectionCache();
  });

  describe("detectInstalledProviders", () => {
    test("returns object with claude and opencode properties", () => {
      const result = detectInstalledProviders();

      expect(result).toHaveProperty("claude");
      expect(result).toHaveProperty("opencode");
      expect(typeof result.claude).toBe("boolean");
      expect(typeof result.opencode).toBe("boolean");
    });

    test("result shape matches DetectedProviders interface", () => {
      const result: DetectedProviders = detectInstalledProviders();

      // TypeScript compilation verifies the shape
      expect(result).toBeDefined();
    });

    test("has an entry for every registered provider", () => {
      const result = detectInstalledProviders();
      const names = getProviderNames();

      for (const name of names) {
        expect(result).toHaveProperty(name);
        expect(typeof result[name]).toBe("boolean");
      }
    });

    test("caches results across calls", () => {
      const result1 = detectInstalledProviders();
      const result2 = detectInstalledProviders();

      expect(result1).toBe(result2); // same reference
    });

    test("returns fresh results after cache clear", () => {
      const result1 = detectInstalledProviders();
      clearDetectionCache();
      const result2 = detectInstalledProviders();

      // Same values but different reference
      expect(result1).not.toBe(result2);
      expect(result1).toEqual(result2);
    });
  });

  describe("isProviderInstalled", () => {
    test("returns boolean for claude", () => {
      const result = isProviderInstalled("claude");
      expect(typeof result).toBe("boolean");
    });

    test("returns boolean for opencode", () => {
      const result = isProviderInstalled("opencode");
      expect(typeof result).toBe("boolean");
    });
  });
});
