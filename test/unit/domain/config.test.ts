import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ShakaConfig,
  ensureConfigComplete,
  getAssistantName,
  getPrincipalName,
  getSummarizationModel,
  isPermissionsManaged,
  isSubagent,
  loadConfig,
  loadShakaFile,
  resolveShakaHome,
  validateConfig,
} from "../../../src/domain/config";

describe("Config", () => {
  describe("validateConfig", () => {
    const validConfig: ShakaConfig = {
      version: "0.1.0",
      reasoning: { enabled: true },
      permissions: { managed: true },
      providers: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
      assistant: { name: "Shaka" },
      principal: { name: "User" },
    };

    test("returns ok for valid config", () => {
      const result = validateConfig(validConfig);
      expect(result.ok).toBe(true);
    });

    test("returns error for null config", () => {
      const result = validateConfig(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must be an object");
      }
    });

    test("returns error for non-object config", () => {
      const result = validateConfig("not an object");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must be an object");
      }
    });

    test("returns error for missing version", () => {
      const { version: _, ...configWithoutVersion } = validConfig;
      const result = validateConfig(configWithoutVersion);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have version string");
      }
    });

    test("returns error for missing reasoning section", () => {
      const { reasoning: _, ...configWithoutReasoning } = validConfig;
      const result = validateConfig(configWithoutReasoning);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have reasoning section");
      }
    });

    test("returns error for missing permissions section", () => {
      const { permissions: _, ...configWithoutPermissions } = validConfig;
      const result = validateConfig(configWithoutPermissions);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have permissions section");
      }
    });

    test("returns error for missing providers section", () => {
      const { providers: _, ...configWithoutProviders } = validConfig;
      const result = validateConfig(configWithoutProviders);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have providers section");
      }
    });

    test("returns error for missing assistant section", () => {
      const { assistant: _, ...configWithoutAssistant } = validConfig;
      const result = validateConfig(configWithoutAssistant);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have assistant section");
      }
    });

    test("returns error for missing principal section", () => {
      const { principal: _, ...configWithoutPrincipal } = validConfig;
      const result = validateConfig(configWithoutPrincipal);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Config must have principal section");
      }
    });
  });

  describe("resolveShakaHome", () => {
    test("uses SHAKA_HOME env var if set", () => {
      const home = resolveShakaHome({ SHAKA_HOME: "/custom/shaka" });
      expect(home).toBe("/custom/shaka");
    });

    test("uses XDG_CONFIG_HOME if set", () => {
      const home = resolveShakaHome({
        XDG_CONFIG_HOME: "/custom/config",
        HOME: "/home/user",
      });
      expect(home).toBe(join("/custom/config", "shaka"));
    });

    test("falls back to ~/.config/shaka", () => {
      const home = resolveShakaHome({ HOME: "/home/user" });
      expect(home).toBe(join("/home/user", ".config", "shaka"));
    });

    test("uses USERPROFILE when HOME is not set", () => {
      const home = resolveShakaHome({ USERPROFILE: "C:\\Users\\test" });
      expect(home).toBe(join("C:\\Users\\test", ".config", "shaka"));
    });

    test("falls back to os.homedir() when no env vars set", () => {
      const home = resolveShakaHome({});
      expect(home).toBe(join(homedir(), ".config", "shaka"));
    });

    test("uses process.env when no argument provided", () => {
      // This test verifies the function works without explicit env
      const home = resolveShakaHome();
      expect(typeof home).toBe("string");
      expect(home.length).toBeGreaterThan(0);
    });
  });

  describe("loadConfig", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-config");
    const validConfig: ShakaConfig = {
      version: "0.1.0",
      reasoning: { enabled: true },
      permissions: { managed: true },
      providers: {
        claude: { enabled: false },
        opencode: { enabled: false },
      },
      assistant: { name: "TestAssistant" },
      principal: { name: "TestUser" },
    };

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("returns config when valid config.json exists", async () => {
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(validConfig));

      const config = await loadConfig(testShakaHome);

      expect(config).not.toBeNull();
      expect(config?.version).toBe("0.1.0");
      expect(config?.assistant.name).toBe("TestAssistant");
    });

    test("returns null when config.json does not exist", async () => {
      const config = await loadConfig(testShakaHome);
      expect(config).toBeNull();
    });

    test("returns null when config.json is invalid JSON", async () => {
      await Bun.write(`${testShakaHome}/config.json`, "not valid json");

      const config = await loadConfig(testShakaHome);
      expect(config).toBeNull();
    });

    test("returns null when config.json fails validation", async () => {
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify({ invalid: true }));

      const config = await loadConfig(testShakaHome);
      expect(config).toBeNull();
    });

    test("returns null for pre-v0.4.0 config missing permissions", async () => {
      const legacyConfig = {
        version: "0.3.0",
        reasoning: { enabled: true },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(legacyConfig));

      const config = await loadConfig(testShakaHome);
      expect(config).toBeNull();
    });
  });

  describe("loadShakaFile", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-files");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(`${testShakaHome}/system`, { recursive: true });
      await mkdir(`${testShakaHome}/customizations`, { recursive: true });
      await mkdir(`${testShakaHome}/user`, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("loads file from system directory", async () => {
      await Bun.write(`${testShakaHome}/system/test.md`, "system content");

      const content = await loadShakaFile("system/test.md", testShakaHome);
      expect(content).toBe("system content");
    });

    test("loads customization override for system file", async () => {
      await Bun.write(`${testShakaHome}/system/test.md`, "system content");
      await Bun.write(`${testShakaHome}/customizations/test.md`, "custom content");

      const content = await loadShakaFile("system/test.md", testShakaHome);
      expect(content).toBe("custom content");
    });

    test("falls back to system file when no customization exists", async () => {
      await Bun.write(`${testShakaHome}/system/test.md`, "system content");

      const content = await loadShakaFile("system/test.md", testShakaHome);
      expect(content).toBe("system content");
    });

    test("loads non-system files directly", async () => {
      await Bun.write(`${testShakaHome}/user/data.md`, "user content");

      const content = await loadShakaFile("user/data.md", testShakaHome);
      expect(content).toBe("user content");
    });

    test("returns null for non-existent file", async () => {
      const content = await loadShakaFile("system/nonexistent.md", testShakaHome);
      expect(content).toBeNull();
    });
  });

  describe("getAssistantName", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-assistant");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("returns assistant name from config", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "TestBot" },
        principal: { name: "TestUser" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const name = await getAssistantName(testShakaHome);
      expect(name).toBe("TestBot");
    });

    test("returns default when config missing", async () => {
      const name = await getAssistantName(testShakaHome);
      expect(name).toBe("Shaka");
    });
  });

  describe("getPrincipalName", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-principal");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("returns principal name from config", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "TestBot" },
        principal: { name: "Alice" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const name = await getPrincipalName(testShakaHome);
      expect(name).toBe("Alice");
    });

    test("returns default when config missing", async () => {
      const name = await getPrincipalName(testShakaHome);
      expect(name).toBe("User");
    });
  });

  describe("getSummarizationModel", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-summ-model");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("defaults to haiku for claude", async () => {
      const model = await getSummarizationModel("claude", testShakaHome);
      expect(model).toBe("haiku");
    });

    test("defaults to undefined (auto) for opencode", async () => {
      const model = await getSummarizationModel("opencode", testShakaHome);
      expect(model).toBeUndefined();
    });

    test("reads claude model from config", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: false, summarization_model: "sonnet" },
          opencode: { enabled: false },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const model = await getSummarizationModel("claude", testShakaHome);
      expect(model).toBe("sonnet");
    });

    test("reads opencode model from config", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: false },
          opencode: {
            enabled: false,
            summarization_model: "openrouter/anthropic/claude-haiku-4.5",
          },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const model = await getSummarizationModel("opencode", testShakaHome);
      expect(model).toBe("openrouter/anthropic/claude-haiku-4.5");
    });

    test("auto returns undefined", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: false, summarization_model: "auto" },
          opencode: { enabled: false },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const model = await getSummarizationModel("claude", testShakaHome);
      expect(model).toBeUndefined();
    });

    test("providers can have different models", async () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: false, summarization_model: "haiku" },
          opencode: { enabled: false, summarization_model: "openrouter/google/gemini-2.0-flash" },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const claude = await getSummarizationModel("claude", testShakaHome);
      const opencode = await getSummarizationModel("opencode", testShakaHome);
      expect(claude).toBe("haiku");
      expect(opencode).toBe("openrouter/google/gemini-2.0-flash");
    });
  });

  describe("isSubagent", () => {
    test("returns false with empty env", () => {
      expect(isSubagent({})).toBe(false);
    });

    test("returns true when CLAUDE_AGENT_TYPE is set", () => {
      expect(isSubagent({ CLAUDE_AGENT_TYPE: "task" })).toBe(true);
    });

    test("returns true when CLAUDE_PROJECT_DIR contains /.claude/Agents/", () => {
      expect(isSubagent({ CLAUDE_PROJECT_DIR: "/home/user/.claude/Agents/task-123" })).toBe(true);
    });

    test("returns false when CLAUDE_PROJECT_DIR does not contain Agents", () => {
      expect(isSubagent({ CLAUDE_PROJECT_DIR: "/home/user/project" })).toBe(false);
    });

    test("returns true when OPENCODE_SUBAGENT is true", () => {
      expect(isSubagent({ OPENCODE_SUBAGENT: "true" })).toBe(true);
    });

    test("returns false when OPENCODE_SUBAGENT is not true", () => {
      expect(isSubagent({ OPENCODE_SUBAGENT: "false" })).toBe(false);
    });

    test("returns true when OPENCODE_AGENT_ID is set", () => {
      expect(isSubagent({ OPENCODE_AGENT_ID: "agent-123" })).toBe(true);
    });

    test("detects Claude Agents path with Windows backslashes", () => {
      expect(isSubagent({ CLAUDE_PROJECT_DIR: "C:\\Users\\test\\.claude\\Agents\\task-123" })).toBe(
        true,
      );
    });
  });

  describe("ensureConfigComplete", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-ensure-config");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("adds permissions field to config missing it", async () => {
      const config = {
        version: "0.3.0",
        reasoning: { enabled: true },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(true);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.permissions).toEqual({ managed: true });
    });

    test("does not modify config that already has all sections", async () => {
      const config = {
        version: "0.3.0",
        reasoning: { enabled: true },
        permissions: { managed: false },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
        memory: {
          learnings_budget: 6000,
          sessions_budget: 5000,
          recency_window_days: 90,
          search_max_results: 10,
          knowledge_enabled: true,
          maintenance: { enabled: true },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(false);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.permissions.managed).toBe(false);
    });

    test("returns false when config.json does not exist", async () => {
      const changed = await ensureConfigComplete(testShakaHome);
      expect(changed).toBe(false);
    });

    test("preserves all existing fields", async () => {
      const config = {
        version: "0.3.0",
        reasoning: { enabled: true },
        providers: {
          claude: { enabled: true, summarization_model: "sonnet" },
          opencode: { enabled: false },
        },
        assistant: { name: "Alfred" },
        principal: { name: "Bruce" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      await ensureConfigComplete(testShakaHome);

      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.assistant.name).toBe("Alfred");
      expect(updated.principal.name).toBe("Bruce");
      expect(updated.providers.claude.summarization_model).toBe("sonnet");
      expect(updated.permissions).toEqual({ managed: true });
    });
  });

  describe("ensureConfigComplete - memory section", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-ensure-memory");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("adds memory section to config missing it", async () => {
      const config = {
        version: "0.4.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(true);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.memory).toEqual({
        learnings_budget: 6000,
        sessions_budget: 5000,
        recency_window_days: 90,
        search_max_results: 10,
        knowledge_enabled: true,
        maintenance: { enabled: true },
      });
    });

    test("backfills missing fields in partial memory section", async () => {
      const config = {
        version: "0.4.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
        memory: { learnings_budget: 3000 },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(true);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.memory).toEqual({
        learnings_budget: 3000,
        sessions_budget: 5000,
        recency_window_days: 90,
        search_max_results: 10,
        knowledge_enabled: true,
        maintenance: { enabled: true },
      });
    });

    test("does not modify config that already has memory section", async () => {
      const config = {
        version: "0.4.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: true }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
        memory: {
          learnings_budget: 3000,
          sessions_budget: 2000,
          recency_window_days: 60,
          search_max_results: 5,
          knowledge_enabled: true,
          maintenance: { enabled: true },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(false);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.memory.learnings_budget).toBe(3000);
    });
  });

  describe("ensureConfigComplete - maintenance section", () => {
    const testShakaHome = join(tmpdir(), "shaka-test-ensure-maintenance");

    beforeEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
      await mkdir(testShakaHome, { recursive: true });
    });

    afterEach(async () => {
      await rm(testShakaHome, { recursive: true, force: true });
    });

    test("backfills maintenance defaults when memory section exists but maintenance missing", async () => {
      const config = {
        version: "0.7.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
        memory: {
          learnings_budget: 6000,
          sessions_budget: 5000,
          recency_window_days: 90,
          search_max_results: 10,
          knowledge_enabled: true,
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(true);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.memory.maintenance).toEqual({ enabled: true });
    });

    test("preserves user-set maintenance.enabled = false", async () => {
      const config = {
        version: "0.7.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "Chief" },
        memory: {
          learnings_budget: 6000,
          sessions_budget: 5000,
          recency_window_days: 90,
          search_max_results: 10,
          knowledge_enabled: true,
          maintenance: { enabled: false },
        },
      };
      await Bun.write(`${testShakaHome}/config.json`, JSON.stringify(config));

      const changed = await ensureConfigComplete(testShakaHome);

      expect(changed).toBe(false);
      const updated = await Bun.file(`${testShakaHome}/config.json`).json();
      expect(updated.memory.maintenance.enabled).toBe(false);
    });
  });

  describe("validateConfig - memory section", () => {
    test("accepts config with memory section", () => {
      const config = {
        version: "0.4.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
        memory: { learnings_budget: 6000 },
      };
      const result = validateConfig(config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memory?.learnings_budget).toBe(6000);
      }
    });

    test("accepts config without memory section", () => {
      const config = {
        version: "0.4.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      const result = validateConfig(config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memory).toBeUndefined();
      }
    });
  });

  describe("isPermissionsManaged", () => {
    test("returns true when config is null", () => {
      expect(isPermissionsManaged(null)).toBe(true);
    });

    test("returns true when permissions.managed is true", () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      expect(isPermissionsManaged(config)).toBe(true);
    });

    test("returns false when permissions.managed is false", () => {
      const config: ShakaConfig = {
        version: "0.1.0",
        reasoning: { enabled: true },
        permissions: { managed: false },
        providers: { claude: { enabled: false }, opencode: { enabled: false } },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      };
      expect(isPermissionsManaged(config)).toBe(false);
    });
  });
});
