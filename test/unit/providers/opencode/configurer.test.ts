import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLink } from "../../../../src/platform/paths";
import { installCommandsForProviders } from "../../../../src/providers/command-orchestrator";
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
    await mkdir(`${testShakaHome}/skills`, { recursive: true });

    // Create test hooks with TRIGGER exports (Shaka canonical names)
    await Bun.write(
      `${testShakaHome}/system/hooks/session-start.ts`,
      `export const TRIGGER = ["session.start"] as const;
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "test" } }));
`,
    );

    // Create critical agent for inference (resolved by frontmatter name)
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

    test("plugin wires user-prompt hooks through chat.message → transform with cached prompt", async () => {
      // Add a prompt.submit hook so the generated plugin emits the
      // chat.message handler + user-prompt dispatch path.
      await Bun.write(
        `${testShakaHome}/system/hooks/format-reminder.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;\nconsole.log("format");\n`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();

      // chat.message handler caches the user prompt text per session.
      expect(content).toContain('"chat.message"');
      expect(content).toContain("latestUserPromptBySession");
      expect(content).toContain("extractPromptText");

      // Transform handler reads the cached prompt and passes it as
      // { prompt: cachedPrompt } to runHookRaw (Claude Code shape).
      expect(content).toMatch(/cachedPrompt[\s\S]*?runHookRaw\(hookPath,\s*hookInput\)/);
      expect(content).toContain("{ prompt: cachedPrompt }");

      // Delete-on-consume: the cache entry is removed after the hooks run,
      // so tool-call continuations in the same turn don't re-classify and
      // long-lived processes (TUI/desktop) don't accumulate stale prompts.
      expect(content).toContain("latestUserPromptBySession.delete(input.sessionID)");
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

  describe("Shaka tools registered with opencode", () => {
    // opencode plugins can expose custom tools via the `tool` field of their
    // returned object. The Shaka plugin surfaces our system tools the same
    // way Pi's extension does — both shell to `shaka tool <name>`, keeping
    // tool defs in one place (defaults/system/tools/) regardless of provider.

    test("plugin declares memory-search and inference tools", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toContain("memory-search");
      expect(content).toContain("inference");
    });

    test("tool execute shells to `shaka tool <name>`", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      // The fragment must include both "tool" subcommand wiring and the
      // `runShakaTool` helper that pipes JSON args via stdin to subprocess.
      expect(content).toContain("tool: {");
      expect(content).toContain("runShakaTool");
    });

    test("runShakaTool escalates SIGTERM → SIGKILL on timeout (mirrors agent-execution)", async () => {
      // A `shaka tool` that traps or ignores SIGTERM would still wedge the
      // turn — the same risk `runAgentStep` mitigates with a 500ms SIGKILL
      // follow-up. Substring-asserted because the plugin runs in opencode's
      // runtime; live spawn would require docker.
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      expect(content).toMatch(/SIGTERM/);
      expect(content).toMatch(/SIGKILL/);
    });

    test("runShakaTool bounds the subprocess with a timeout (so a hung shaka can't wedge the model turn)", async () => {
      // Live-path symmetry with Pi's bridge — both shells to `shaka tool
      // <name>` on every model invocation, both must fail fast if the
      // subprocess hangs. Substring-asserted on the generator output
      // because the plugin runs in opencode's runtime, not in this
      // process (same module-load constraint as Pi's extension template).
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      // Pin the concrete timeout wiring — the previous loose
      // `setTimeout|AbortSignal|timed out` regex passed even if the
      // SIGTERM/SIGKILL escalation got removed, just because the error
      // string still contained "timed out".
      expect(content).toContain("TOOL_TIMEOUT_MS");
      expect(content).toContain("setTimeout(");
      expect(content).toContain('proc.kill("SIGTERM")');
      expect(content).toContain('proc.kill("SIGKILL")');
    });

    test("tool args use zod ZodRawShape, not JSON Schema (Exp 53 — opencode rejects JSON Schema)", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(`${testProjectRoot}/plugins/shaka.ts`).text();
      // Zod-shaped args use `z.string()` / `z.enum(...)` chained with
      // `.describe()` / `.optional()`. The JSON Schema shape we used to ship
      // (`{ type: "object", properties: {...} }`) crashes opencode's plugin
      // runtime with `n._zod.def` undefined — see Exp 53 README.
      expect(content).toContain("z.string()");
      expect(content).not.toMatch(/args:\s*\{\s*type:\s*["']object["']/);
      expect(content).toContain('import { tool } from "@opencode-ai/plugin"');
    });
  });

  describe("commands", () => {
    /** Helper: install + orchestrate commands (the real flow) */
    async function installWithCommands(configurer: OpencodeProviderConfigurer) {
      await configurer.install({ shakaHome: testShakaHome });
      await installCommandsForProviders(testShakaHome, [configurer]);
    }

    test("installs discovered commands as flat .md files", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nAnalyze staged changes.\n\n$ARGUMENTS",
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);

      const cmdFile = Bun.file(`${testProjectRoot}/commands/commit.md`);
      expect(await cmdFile.exists()).toBe(true);
      const content = await cmdFile.text();
      expect(content).toContain("description: Create a commit");
    });

    test("uninstall removes commands but leaves manifest for orchestrator", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nBody",
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);
      expect(await Bun.file(`${testProjectRoot}/commands/commit.md`).exists()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });

      expect(await Bun.file(`${testProjectRoot}/commands/commit.md`).exists()).toBe(false);
      expect(await Bun.file(`${testShakaHome}/commands-manifest.json`).exists()).toBe(true);
    });

    test("checkInstallation includes commands status", async () => {
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await configurer.install({ shakaHome: testShakaHome });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(true);
    });

    test("installs scoped command to cwd project directory", async () => {
      const projectDir = join(testProjectRoot, "my-project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        `---\ndescription: Deploy\ncwd: ${projectDir}\n---\nDeploy body`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);

      const cmdFile = Bun.file(join(projectDir, ".opencode", "commands", "deploy.md"));
      expect(await cmdFile.exists()).toBe(true);
      const content = await cmdFile.text();
      expect(content).toContain("description: Deploy");
    });

    test("skips scoped command when cwd does not exist", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        "---\ndescription: Deploy\ncwd: /nonexistent/path\n---\nBody",
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);

      const manifest = await Bun.file(`${testShakaHome}/commands-manifest.json`).json();
      // Manifest includes the scoped entry (deterministic from discovery),
      // but the actual file wasn't installed (directory doesn't exist)
      expect(manifest.scoped["/nonexistent/path"]).toContain("deploy");
    });

    test("uninstall cleans scoped commands", async () => {
      const projectDir = join(testProjectRoot, "my-project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        `---\ndescription: Deploy\ncwd: ${projectDir}\n---\nBody`,
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);
      expect(await Bun.file(join(projectDir, ".opencode", "commands", "deploy.md")).exists()).toBe(
        true,
      );

      await configurer.uninstall({ shakaHome: testShakaHome });

      expect(await Bun.file(join(projectDir, ".opencode", "commands", "deploy.md")).exists()).toBe(
        false,
      );
    });

    test("applies provider overrides during compilation", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/test-cmd.md`,
        "---\ndescription: Test\nmodel: sonnet\nproviders:\n  opencode:\n    model: anthropic/claude-sonnet-4-5\n---\nBody",
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);

      const content = await Bun.file(`${testProjectRoot}/commands/test-cmd.md`).text();
      expect(content).toContain("model: anthropic/claude-sonnet-4-5");
      expect(content).not.toContain("model: sonnet");
    });

    test("customization override installs with overridden content", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await mkdir(`${testShakaHome}/customizations/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: System commit\n---\nSystem body",
      );
      await Bun.write(
        `${testShakaHome}/customizations/commands/commit.md`,
        "---\ndescription: Custom commit\n---\nCustom body",
      );
      const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: testProjectRoot });

      await installWithCommands(configurer);

      const content = await Bun.file(`${testProjectRoot}/commands/commit.md`).text();
      expect(content).toContain("description: Custom commit");
      expect(content).toContain("Custom body");
      expect(content).not.toContain("System body");
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
      expect(result.installedSkills.ok).toBe(true);
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
