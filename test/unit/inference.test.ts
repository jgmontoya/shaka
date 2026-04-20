import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("inference", () => {
  describe("hasInferenceProvider", () => {
    test("returns true when codex is the only installed provider", async () => {
      const { hasInferenceProvider } = await import("../../src/inference");
      const result = await hasInferenceProvider({
        claude: false,
        opencode: false,
        codex: true,
      });
      expect(result).toBe(true);
    });

    test("returns false when no providers are installed", async () => {
      const { hasInferenceProvider } = await import("../../src/inference");
      const result = await hasInferenceProvider({
        claude: false,
        opencode: false,
        codex: false,
      });
      expect(result).toBe(false);
    });
  });

  describe("parseOpencodeJsonStream", () => {
    test("extracts session ID from the first step_start event", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const stream =
        '{"type":"step_start","sessionID":"ses_abc123","part":{}}\n' +
        '{"type":"text","part":{"text":"hello"}}\n';
      const result = parseOpencodeJsonStream(stream);
      expect(result.sessionId).toBe("ses_abc123");
    });

    test("concatenates text from all type:text events in stream order", async () => {
      const { parseOpencodeJsonStream } = await import("../../src/inference");
      const stream =
        '{"type":"step_start","sessionID":"ses_abc"}\n' +
        '{"type":"text","part":{"text":"hello "}}\n' +
        '{"type":"text","part":{"text":"world"}}\n' +
        '{"type":"step_finish"}\n';
      const result = parseOpencodeJsonStream(stream);
      expect(result.text).toBe("hello world");
    });
  });

  describe("inference()", () => {
    test("error message names all three providers when none are available", async () => {
      const { inference } = await import("../../src/inference");
      const result = await inference(
        { userPrompt: "test" },
        { claude: false, opencode: false, codex: false },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("claude");
      expect(result.error).toContain("opencode");
      expect(result.error).toContain("codex");
    });
  });

  describe("resolveInferenceAttempts", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-inference-attempts");
    const savedShakaHome = process.env.SHAKA_HOME;

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
      process.env.SHAKA_HOME = testShakaHome;
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      if (savedShakaHome === undefined) {
        delete process.env.SHAKA_HOME;
      } else {
        process.env.SHAKA_HOME = savedShakaHome;
      }
    });

    test("resolves winning provider's summarization_model when caller omits model", async () => {
      // Config: claude has an explicit summarization_model; opencode has its own.
      // Both are installed — claude wins by priority and its model is used first.
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: true, opencode: true, codex: false },
      );

      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({ provider: "claude", model: "sonnet" });
      expect(attempts[1]).toEqual({
        provider: "opencode",
        model: "openrouter/anthropic/claude-haiku-4.5",
      });
    });

    test("explicit options.model overrides per-provider config", async () => {
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi", model: "opus" },
        { claude: true, opencode: true, codex: false },
      );

      // Explicit model wins for every attempt — config is ignored entirely.
      for (const attempt of attempts) {
        expect(attempt.model).toBe("opus");
      }
    });

    test("skips providers that are not installed", async () => {
      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: false, opencode: true, codex: false },
      );

      expect(attempts.length).toBe(1);
      expect(attempts[0]?.provider).toBe("opencode");
    });

    test("returns empty array when no providers are installed", async () => {
      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi" },
        { claude: false, opencode: false, codex: false },
      );

      expect(attempts).toEqual([]);
    });

    test("prefers hinted provider and resolves its summarization_model", async () => {
      // When the caller passes a `provider` hint, that provider moves to the
      // head of the attempt list even if a higher-priority provider is also
      // installed. Other installed providers remain as fallbacks.
      const config = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: {
            enabled: true,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const { resolveInferenceAttempts } = await import("../../src/inference");
      const attempts = await resolveInferenceAttempts(
        { userPrompt: "hi", provider: "opencode" },
        { claude: true, opencode: true, codex: false },
      );

      expect(attempts.length).toBe(2);
      expect(attempts[0]).toEqual({
        provider: "opencode",
        model: "openrouter/anthropic/claude-haiku-4.5",
      });
      expect(attempts[1]).toEqual({ provider: "claude", model: "sonnet" });
    });
  });
});
