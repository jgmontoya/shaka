import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ok } from "../../../../src/domain/result";
import {
  clearProviders,
  detectProvider,
  getAllSourceProviders,
  getProviderByName,
  registerProvider,
} from "../../../../src/services/skill-source/registry";
import type { SkillSourceProvider } from "../../../../src/services/skill-source/types";

function makeProvider(name: string, canHandle: (input: string) => boolean): SkillSourceProvider {
  return {
    name,
    canHandle,
    fetch: async () =>
      ok({ skillDir: "", tempDir: "", version: "", source: "", subdirectory: null }),
  };
}

describe("skill source registry", () => {
  beforeEach(() => {
    clearProviders();
  });

  afterEach(() => {
    clearProviders();
  });

  describe("registerProvider", () => {
    test("adds provider to registry", () => {
      const provider = makeProvider("test", () => true);
      registerProvider(provider);

      expect(getAllSourceProviders()).toHaveLength(1);
      expect(getAllSourceProviders()[0]?.name).toBe("test");
    });

    test("preserves registration order", () => {
      registerProvider(makeProvider("first", () => true));
      registerProvider(makeProvider("second", () => true));

      const providers = getAllSourceProviders();
      expect(providers[0]?.name).toBe("first");
      expect(providers[1]?.name).toBe("second");
    });
  });

  describe("detectProvider", () => {
    test("returns first matching provider", () => {
      registerProvider(makeProvider("github", (i) => i.includes("/")));
      registerProvider(makeProvider("clawhub", () => true));

      const result = detectProvider("user/repo");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("github");
      }
    });

    test("falls through to next provider if first does not match", () => {
      registerProvider(makeProvider("github", (i) => i.includes("/")));
      registerProvider(makeProvider("clawhub", () => true));

      const result = detectProvider("sonoscli");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("clawhub");
      }
    });

    test("returns error when no provider matches", () => {
      registerProvider(makeProvider("picky", () => false));

      const result = detectProvider("anything");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No skill source provider found");
      }
    });

    test("returns error when registry is empty", () => {
      const result = detectProvider("anything");
      expect(result.ok).toBe(false);
    });
  });

  describe("getProviderByName", () => {
    test("returns provider by name", () => {
      registerProvider(makeProvider("github", () => true));
      registerProvider(makeProvider("clawhub", () => true));

      const result = getProviderByName("clawhub");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("clawhub");
      }
    });

    test("maps legacy clawdhub alias to clawhub provider", () => {
      registerProvider(makeProvider("clawhub", () => true));

      const result = getProviderByName("clawdhub");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("clawhub");
      }
    });

    test("returns error for unknown provider name", () => {
      registerProvider(makeProvider("github", () => true));

      const result = getProviderByName("unknown");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unknown skill source provider");
      }
    });
  });

  describe("getAllSourceProviders", () => {
    test("returns empty array when no providers registered", () => {
      expect(getAllSourceProviders()).toHaveLength(0);
    });

    test("returns all registered providers", () => {
      registerProvider(makeProvider("a", () => true));
      registerProvider(makeProvider("b", () => true));
      registerProvider(makeProvider("c", () => true));

      expect(getAllSourceProviders()).toHaveLength(3);
    });
  });

  describe("clearProviders", () => {
    test("removes all providers", () => {
      registerProvider(makeProvider("a", () => true));
      registerProvider(makeProvider("b", () => true));

      clearProviders();
      expect(getAllSourceProviders()).toHaveLength(0);
    });
  });
});
