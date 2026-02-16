import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLink } from "../../../../src/platform/paths";
import { OpencodeProviderConfigurer } from "../../../../src/providers/opencode/configurer";

describe("OpencodeProviderConfigurer", () => {
  const testProjectRoot = join(tmpdir(), "shaka-test-opencode-project");
  const testShakaHome = join(tmpdir(), "shaka-test-shaka");

  beforeEach(async () => {
    await rm(testProjectRoot, { recursive: true, force: true });
    await rm(testShakaHome, { recursive: true, force: true });
    await mkdir(testProjectRoot, { recursive: true });
    await mkdir(`${testShakaHome}/system/hooks`, { recursive: true });
    await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
    await mkdir(`${testShakaHome}/system/skills`, { recursive: true });

    // Create test hooks with TRIGGER exports (Shaka canonical names)
    await Bun.write(
      `${testShakaHome}/system/hooks/session-start.ts`,
      `export const TRIGGER = ["session.start"] as const;
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "test" } }));
`,
    );

    // Create critical agent for inference (will be symlinked as shaka/inference)
    await Bun.write(
      `${testShakaHome}/system/agents/inference.md`,
      `---
mode: primary
hidden: true
permission:
  "*": deny
---

You are a text-only inference assistant.
`,
    );
  });

  afterEach(async () => {
    await rm(testProjectRoot, { recursive: true, force: true });
    await rm(testShakaHome, { recursive: true, force: true });
  });

  describe("name", () => {
    test("returns opencode", () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      expect(configurer.name).toBe("opencode");
    });
  });

  describe("installHooks", () => {
    test("creates plugins directory in opencode config dir", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
      const pluginFile = Bun.file(`${testProjectRoot}/plugins/shaka.ts`);
      expect(await pluginFile.exists()).toBe(true);
    });

    test("creates shaka.ts plugin file", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const pluginFile = Bun.file(join(testProjectRoot, "plugins", "shaka.ts"));
      expect(await pluginFile.exists()).toBe(true);
      const content = await pluginFile.text();
      expect(content).toContain("SHAKA_HOME");
      // Path is JSON-stringified in the generated plugin (backslashes escaped on Windows)
      expect(content).toContain(JSON.stringify(testShakaHome));
    });

    test("plugin includes discovered hooks in header comment", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("session-start.ts (session.start)");
    });

    test("plugin includes runHookRaw helper function", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("async function runHookRaw");
    });

    test("plugin includes system.transform hook for session.start", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("experimental.chat.system.transform");
    });

    test("discovers multiple hook types", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/format-reminder.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("format");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("session-start.ts (session.start)");
      expect(content).toContain("format-reminder.ts (prompt.submit)");
    });

    test("includes matchers in header comment for hooks with matchers", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash", "Edit"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("security.ts (tool.before, matchers: Bash, Edit)");
    });

    test("generates TOOL_HOOKS array with matcher configuration", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("const TOOL_HOOKS: ToolHookConfig[]");
      expect(content).toContain('"matchers"');
      expect(content).toContain('"Bash"');
    });

    test("generates shouldRunForTool helper for matcher filtering", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("function shouldRunForTool");
      expect(content).toContain("hook.matchers.includes(toolName)");
    });

    test("generates format normalization for tool hooks", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      // Should normalize opencode format to Claude format
      expect(content).toContain("interface ClaudeHookInput");
      expect(content).toContain("normalizeToolName");
      expect(content).toContain("normalizeArgs");
      expect(content).toContain("tool_name: claudeToolName");
      expect(content).toContain("tool_input: claudeArgs");
    });

    test("generates exit code handling for blocked operations", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("exitCode === 2");
      expect(content).toContain("throw new Error");
      expect(content).toContain("[SHAKA SECURITY] Operation blocked");
    });

    test("generates warning handling for confirm decisions", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain('decision === "ask"');
      expect(content).toContain("[SHAKA SECURITY] Warning");
    });

    test("generates event handler for session.end hooks", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("event:");
      expect(content).toContain("session.created");
      expect(content).toContain("session.idle");
    });

    test("generated plugin tracks session ID from session.created", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("sessionId");
      expect(content).toContain("event.properties");
    });

    test("generated plugin has debounce timer for session.idle", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("idleTimer");
      expect(content).toContain("setTimeout");
      expect(content).toContain("clearTimeout");
    });

    test("generated plugin cancels timer on session.status busy", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("session.status");
      expect(content).toContain('"busy"');
      expect(content).toContain("clearTimeout");
    });

    test("generated plugin passes session_id and cwd to session.end hooks", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("session_id");
      expect(content).toContain("cwd");
      expect(content).toContain("reason");
    });

    test("does not generate event handler when no session.end hooks", async () => {
      // Only session.start hook exists (from beforeEach)
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).not.toContain("idleTimer");
    });

    test("generates tool.execute.after handler for tool.after hooks", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/post-tool.ts`,
        `export const TRIGGER = ["tool.after"] as const;
console.log("tool after");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain('"tool.execute.after"');
    });

    test("plugin with session.end hooks passes syntax validation", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
    });

    test("plugin with all hook types passes syntax validation", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("session end");
`,
      );
      await Bun.write(
        `${testShakaHome}/system/hooks/post-tool.ts`,
        `export const TRIGGER = ["tool.after"] as const;
console.log("tool after");
`,
      );
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      await Bun.write(
        `${testShakaHome}/system/hooks/format.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("format");
`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
    });

    test("exports a plugin function, not a plain object", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      // opencode's plugin loader calls each export as a function.
      // A plain `export default { ... }` crashes with "fn is not a function".
      expect(content).toContain("export const ShakaPlugin = async (ctx");
      expect(content).not.toContain("export default {");
    });

    test("validates generated plugin syntax", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.install({ shakaHome: testShakaHome });

      // Should succeed - generated plugin should be valid
      expect(result.ok).toBe(true);
    });
  });

  describe("permissions", () => {
    test("applies default permissions on fresh install", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const configFile = Bun.file(`${testProjectRoot}/opencode.json`);
      expect(await configFile.exists()).toBe(true);
      const config = await configFile.json();
      expect(config.permission.edit).toBe("allow");
      expect(config.permission.bash).toBe("allow");
    });

    test("does not overwrite existing permissions by default", async () => {
      await Bun.write(
        `${testProjectRoot}/opencode.json`,
        JSON.stringify({ permission: { edit: "ask", bash: "ask" } }),
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const config = await Bun.file(`${testProjectRoot}/opencode.json`).json();
      expect(config.permission.edit).toBe("ask");
      expect(config.permission.bash).toBe("ask");
    });

    test("applies permissions when mode is apply", async () => {
      await Bun.write(
        `${testProjectRoot}/opencode.json`,
        JSON.stringify({ permission: { edit: "ask", bash: "ask" } }),
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const config = await Bun.file(`${testProjectRoot}/opencode.json`).json();
      expect(config.permission.edit).toBe("allow");
      expect(config.permission.bash).toBe("allow");
    });

    test("skips permissions when mode is skip", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "skip" });

      const configFile = Bun.file(`${testProjectRoot}/opencode.json`);
      if (await configFile.exists()) {
        const config = await configFile.json();
        expect(config.permission).toBeUndefined();
      }
    });

    test("preserves other opencode config fields", async () => {
      await Bun.write(
        `${testProjectRoot}/opencode.json`,
        JSON.stringify({ model: "anthropic/claude-sonnet-4-5", theme: "dark" }),
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const config = await Bun.file(`${testProjectRoot}/opencode.json`).json();
      expect(config.model).toBe("anthropic/claude-sonnet-4-5");
      expect(config.theme).toBe("dark");
      expect(config.permission.edit).toBe("allow");
    });
  });

  describe("uninstall", () => {
    test("removes shaka.ts plugin file", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const result = await configurer.uninstall({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
      const pluginFile = Bun.file(`${testProjectRoot}/plugins/shaka.ts`);
      expect(await pluginFile.exists()).toBe(false);
    });

    test("succeeds if plugin file does not exist", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.uninstall({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
    });
  });

  describe("checkInstallation", () => {
    test("returns all ok when fully installed", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.hooks.ok).toBe(true);
      expect(result.agents.ok).toBe(true);
      expect(result.skills.ok).toBe(true);
    });

    test("returns hooks not ok when plugin missing", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.hooks.ok).toBe(false);
      expect(result.hooks.issue).toBe("shaka.ts plugin not found");
    });

    test("detects wrong-target agents symlink", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      // Create a symlink pointing to wrong location
      const agentsDir = join(testProjectRoot, "agents");
      await removeLink(join(agentsDir, "shaka"));
      await mkdir(agentsDir, { recursive: true });
      await symlink(join(tmpdir(), "shaka-test-wrong-path"), join(agentsDir, "shaka"), "junction");

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.agents.ok).toBe(false);
      expect(result.agents.issue).toContain("wrong location");
    });
  });
});
