import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printOpencodeSummarizationHint } from "../../../src/commands/hints";
import type { ShakaConfig } from "../../../src/domain/config";

describe("hints", () => {
  const testShakaHome = join(tmpdir(), "shaka-test-hints");

  const validConfig: ShakaConfig = {
    version: "0.1.0",
    reasoning: { enabled: true },
    permissions: { managed: true },
    providers: {
      claude: { enabled: false },
      opencode: { enabled: true },
    },
    assistant: { name: "Shaka" },
    principal: { name: "User" },
  };

  beforeEach(async () => {
    await rm(testShakaHome, { recursive: true, force: true });
    await mkdir(testShakaHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(testShakaHome, { recursive: true, force: true });
  });

  describe("printOpencodeSummarizationHint", () => {
    test("does not throw when config does not exist", async () => {
      // Should silently return without error
      await printOpencodeSummarizationHint(testShakaHome);
    });

    test("does not throw when opencode is not enabled", async () => {
      const config = {
        ...validConfig,
        providers: { ...validConfig.providers, opencode: { enabled: false } },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      await printOpencodeSummarizationHint(testShakaHome);
    });

    test("does not throw when summarization_model is already set", async () => {
      const config = {
        ...validConfig,
        providers: {
          ...validConfig.providers,
          opencode: { enabled: true, summarization_model: "haiku" },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      await printOpencodeSummarizationHint(testShakaHome);
    });

    test("does not throw when opencode enabled and model is auto", async () => {
      const config = {
        ...validConfig,
        providers: {
          ...validConfig.providers,
          opencode: { enabled: true, summarization_model: "auto" },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      // This would print the hint, but we just verify it doesn't throw
      await printOpencodeSummarizationHint(testShakaHome);
    });

    test("does not throw when opencode enabled and model is undefined", async () => {
      const config = {
        ...validConfig,
        providers: {
          ...validConfig.providers,
          opencode: { enabled: true },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      await printOpencodeSummarizationHint(testShakaHome);
    });
  });
});
