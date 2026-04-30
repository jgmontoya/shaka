import { describe, expect, test } from "bun:test";
import { ClaudeProviderConfigurer } from "../../../src/providers/claude/configurer";
import { CodexProviderConfigurer } from "../../../src/providers/codex/configurer";
import { OpencodeProviderConfigurer } from "../../../src/providers/opencode/configurer";
import { PiProviderConfigurer } from "../../../src/providers/pi/configurer";
import { createProvider, getAllProviders, getProviderNames } from "../../../src/providers/registry";
import type { ProviderName } from "../../../src/providers/types";

describe("Provider Registry", () => {
  describe("createProvider", () => {
    test("creates Claude provider", () => {
      const provider = createProvider("claude");
      expect(provider).toBeInstanceOf(ClaudeProviderConfigurer);
      expect(provider.name).toBe("claude");
    });

    test("creates opencode provider", () => {
      const provider = createProvider("opencode");
      expect(provider).toBeInstanceOf(OpencodeProviderConfigurer);
      expect(provider.name).toBe("opencode");
    });

    test("creates Codex provider", () => {
      const provider = createProvider("codex");
      expect(provider).toBeInstanceOf(CodexProviderConfigurer);
      expect(provider.name).toBe("codex");
    });

    test("creates Pi provider", () => {
      const provider = createProvider("pi");
      expect(provider).toBeInstanceOf(PiProviderConfigurer);
      expect(provider.name).toBe("pi");
    });
  });

  describe("getAllProviders", () => {
    test("returns all providers", () => {
      const providers = getAllProviders();
      expect(providers).toHaveLength(4);
      expect(providers.map((p) => p.name)).toContain("claude");
      expect(providers.map((p) => p.name)).toContain("opencode");
      expect(providers.map((p) => p.name)).toContain("codex");
      expect(providers.map((p) => p.name)).toContain("pi");
    });
  });

  describe("getProviderNames", () => {
    test("returns all provider names without constructing configurers", () => {
      const names = getProviderNames();
      expect(names).toEqual(["claude", "opencode", "codex", "pi"]);
    });

    test("returns ProviderName[] type", () => {
      const names: ProviderName[] = getProviderNames();
      expect(names).toBeDefined();
      expect(names.length).toBe(4);
    });
  });
});
