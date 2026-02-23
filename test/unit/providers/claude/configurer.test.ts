import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLink } from "../../../../src/platform/paths";
import { ClaudeProviderConfigurer } from "../../../../src/providers/claude/configurer";
import { installCommandsForProviders } from "../../../../src/providers/command-orchestrator";
import {
  HOOK_EVENTS,
  SHAKA_TO_CLAUDE_EVENT,
  SHAKA_TO_OPENCODE_HOOK,
  discoverAllHooks,
  discoverHooks,
  parseHookTrigger,
} from "../../../../src/providers/hook-discovery";

describe("ClaudeProviderConfigurer", () => {
  const testClaudeHome = join(tmpdir(), "shaka-test-claude");
  const testShakaHome = join(tmpdir(), "shaka-test-shaka");

  beforeEach(async () => {
    await rm(testClaudeHome, { recursive: true, force: true });
    await rm(testShakaHome, { recursive: true, force: true });
    await mkdir(testClaudeHome, { recursive: true });
    await mkdir(`${testShakaHome}/system/hooks`, { recursive: true });
    await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
    await mkdir(`${testShakaHome}/system/skills`, { recursive: true });

    // Create a test hook with TRIGGER export (Shaka canonical names)
    await Bun.write(
      `${testShakaHome}/system/hooks/session-start.ts`,
      `export const TRIGGER = ["session.start"] as const;
console.log("test");
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
    await rm(testClaudeHome, { recursive: true, force: true });
    await rm(testShakaHome, { recursive: true, force: true });
  });

  describe("name", () => {
    test("returns claude", () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      expect(configurer.name).toBe("claude");
    });
  });

  describe("installHooks", () => {
    test("creates settings.json if it does not exist", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
      const settingsFile = Bun.file(`${testClaudeHome}/settings.json`);
      expect(await settingsFile.exists()).toBe(true);
    });

    test("adds discovered hook entries", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);
    });

    test("preserves existing settings", async () => {
      await Bun.write(
        `${testClaudeHome}/settings.json`,
        JSON.stringify({ existingKey: "existingValue" }),
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.existingKey).toBe("existingValue");
      expect(settings.hooks).toBeDefined();
    });

    test("does not duplicate hook if already exists", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });
      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const shakaHooks = settings.hooks.SessionStart.filter(
        (h: { matcher?: string }) => !h.matcher,
      );
      expect(shakaHooks.length).toBe(1);
    });

    test("registers SessionEnd hooks for session.end trigger", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/session-end.ts`,
        `export const TRIGGER = ["session.end"] as const;
console.log("test");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.hooks.SessionEnd).toBeDefined();
      expect(settings.hooks.SessionEnd.length).toBeGreaterThan(0);
      const shakaEntry = settings.hooks.SessionEnd.find((h: { matcher?: string }) => !h.matcher);
      expect(shakaEntry).toBeDefined();
      expect(shakaEntry.hooks[0].command).toContain("session-end.ts");
    });

    test("installs multiple hooks for different events", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/format-reminder.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("format");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
    });

    test("registers all hooks when multiple hooks have same event type", async () => {
      // Create two hooks with same TRIGGER (Shaka canonical names)
      await Bun.write(
        `${testShakaHome}/system/hooks/hook-a.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("hook-a");
`,
      );
      await Bun.write(
        `${testShakaHome}/system/hooks/hook-b.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("hook-b");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const shakaEntry = settings.hooks.UserPromptSubmit.find(
        (h: { matcher?: string }) => !h.matcher,
      );
      expect(shakaEntry).toBeDefined();
      expect(shakaEntry.hooks).toHaveLength(2);
      expect(shakaEntry.hooks.map((h: { command: string }) => h.command)).toContain(
        `bun run ${join(testShakaHome, "system", "hooks", "hook-a.ts")}`,
      );
      expect(shakaEntry.hooks.map((h: { command: string }) => h.command)).toContain(
        `bun run ${join(testShakaHome, "system", "hooks", "hook-b.ts")}`,
      );
    });

    test("registers hooks with matchers under tool-specific entries", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash", "Edit"] as const;
console.log("security");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const bashEntry = settings.hooks.PreToolUse.find(
        (h: { matcher?: string }) => h.matcher === "Bash",
      );
      const editEntry = settings.hooks.PreToolUse.find(
        (h: { matcher?: string }) => h.matcher === "Edit",
      );

      expect(bashEntry).toBeDefined();
      expect(bashEntry.hooks).toHaveLength(1);
      expect(bashEntry.hooks[0].command).toBe(
        `bun run ${join(testShakaHome, "system", "hooks", "security.ts")}`,
      );

      expect(editEntry).toBeDefined();
      expect(editEntry.hooks).toHaveLength(1);
      expect(editEntry.hooks[0].command).toBe(
        `bun run ${join(testShakaHome, "system", "hooks", "security.ts")}`,
      );
    });

    test("handles mixed hooks with and without matchers", async () => {
      // Hook with matchers
      await Bun.write(
        `${testShakaHome}/system/hooks/security.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
console.log("security");
`,
      );
      // Hook without matchers (same event)
      await Bun.write(
        `${testShakaHome}/system/hooks/logger.ts`,
        `export const TRIGGER = ["tool.before"] as const;
console.log("logger");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();

      // Bash matcher should have security hook
      const bashEntry = settings.hooks.PreToolUse.find(
        (h: { matcher?: string }) => h.matcher === "Bash",
      );
      expect(bashEntry).toBeDefined();
      expect(bashEntry.hooks[0].command).toContain("security.ts");

      // No-matcher entry should have logger hook (catch-all)
      const catchAllEntry = settings.hooks.PreToolUse.find((h: { matcher?: string }) => !h.matcher);
      expect(catchAllEntry).toBeDefined();
      expect(catchAllEntry.hooks[0].command).toContain("logger.ts");
    });

    test("multiple hooks targeting same matcher are grouped together", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security-a.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      await Bun.write(
        `${testShakaHome}/system/hooks/security-b.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash"] as const;
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const bashEntry = settings.hooks.PreToolUse.find(
        (h: { matcher?: string }) => h.matcher === "Bash",
      );

      expect(bashEntry).toBeDefined();
      expect(bashEntry.hooks).toHaveLength(2);
    });

    test("discovers hooks from customizations/hooks/ directory", async () => {
      await mkdir(`${testShakaHome}/customizations/hooks`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/customizations/hooks/custom-prompt.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("custom");
`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      const catchAll = settings.hooks.UserPromptSubmit.find(
        (h: { matcher?: string }) => !h.matcher,
      );
      expect(catchAll).toBeDefined();
      expect(catchAll.hooks[0].command).toContain(
        join("customizations", "hooks", "custom-prompt.ts"),
      );
    });
  });

  describe("permissions", () => {
    test("applies default permissions on fresh install", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.permissions).toBeDefined();
      expect(settings.permissions.allow).toContain("Bash");
      expect(settings.permissions.allow).toContain("mcp__*");
      expect(settings.permissions.ask).toContain("Bash(rm -rf /)");
      expect(settings.permissions.deny).toEqual([]);
    });

    test("merges defaults into existing permissions by default", async () => {
      await Bun.write(
        `${testClaudeHome}/settings.json`,
        JSON.stringify({
          permissions: {
            allow: ["CustomTool"],
            deny: ["WebFetch"],
            ask: ["Bash(custom:*)"],
          },
        }),
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      // Existing entries preserved
      expect(settings.permissions.allow).toContain("CustomTool");
      expect(settings.permissions.deny).toEqual(["WebFetch"]);
      expect(settings.permissions.ask).toContain("Bash(custom:*)");
      // Defaults merged in
      expect(settings.permissions.allow).toContain("Bash");
      expect(settings.permissions.allow).toContain("mcp__*");
      expect(settings.permissions.ask).toContain("Bash(rm -rf /)");
    });

    test("applies permissions when mode is apply", async () => {
      await Bun.write(
        `${testClaudeHome}/settings.json`,
        JSON.stringify({
          permissions: {
            allow: ["Bash"],
            deny: ["WebFetch"],
            ask: [],
          },
        }),
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.permissions.allow).toContain("mcp__*");
      expect(settings.permissions.deny).toEqual([]);
    });

    test("merges permissions when mode is merge", async () => {
      await Bun.write(
        `${testClaudeHome}/settings.json`,
        JSON.stringify({
          permissions: {
            allow: ["CustomTool"],
            deny: ["WebFetch"],
            ask: ["Bash(custom:*)"],
          },
        }),
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "merge" });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.permissions.allow).toContain("CustomTool");
      expect(settings.permissions.allow).toContain("Bash");
      expect(settings.permissions.deny).toEqual(["WebFetch"]);
      expect(settings.permissions.ask).toContain("Bash(custom:*)");
      expect(settings.permissions.ask).toContain("Bash(rm -rf /)");
    });

    test("skips permissions when mode is skip", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "skip" });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      expect(settings.permissions).toBeUndefined();
    });

    test("merge is idempotent across repeated installs", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });
      await configurer.install({ shakaHome: testShakaHome });

      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      // Merging twice produces the same result
      expect(settings.permissions.allow).toContain("Bash");
      expect(settings.permissions.allow).toContain("mcp__*");
      // No duplicates
      const bashCount = settings.permissions.allow.filter((p: string) => p === "Bash").length;
      expect(bashCount).toBe(1);
    });
  });

  describe("uninstall", () => {
    test("removes shaka hooks from all events", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      await configurer.install({ shakaHome: testShakaHome });

      const result = await configurer.uninstall({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const remaining = (settings.hooks?.SessionStart ?? []).filter(
        (h: { hooks?: Array<{ command?: string }> }) =>
          h.hooks?.some((hook) => hook.command?.includes("/system/hooks/")),
      );
      expect(remaining.length).toBe(0);
    });

    test("removes customization hooks during uninstall", async () => {
      await mkdir(`${testShakaHome}/customizations/hooks`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/customizations/hooks/custom.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      await configurer.install({ shakaHome: testShakaHome });

      const result = await configurer.uninstall({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
      const settings = await Bun.file(`${testClaudeHome}/settings.json`).json();
      const remaining = (settings.hooks?.UserPromptSubmit ?? []).filter(
        (h: { hooks?: Array<{ command?: string }> }) =>
          h.hooks?.some((hook) => hook.command?.includes("/customizations/hooks/")),
      );
      expect(remaining.length).toBe(0);
    });

    test("succeeds if settings.json does not exist", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      const result = await configurer.uninstall({ shakaHome: testShakaHome });

      expect(result.ok).toBe(true);
    });
  });

  describe("checkInstallation", () => {
    test("returns all ok when fully installed", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      await configurer.install({ shakaHome: testShakaHome });

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.hooks.ok).toBe(true);
      expect(result.agents.ok).toBe(true);
      expect(result.skills.ok).toBe(true);
    });

    test("returns hooks not ok when settings.json missing", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      await rm(`${testClaudeHome}/settings.json`, { force: true });

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.hooks.ok).toBe(false);
      expect(result.hooks.issue).toBe("settings.json not found");
    });

    test("returns hooks not ok when no shaka hooks configured", async () => {
      await Bun.write(`${testClaudeHome}/settings.json`, JSON.stringify({ hooks: {} }));
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.hooks.ok).toBe(false);
      expect(result.hooks.issue).toBe("No Shaka hooks configured");
    });

    test("detects wrong-target agents symlink", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });
      await configurer.install({ shakaHome: testShakaHome });

      // Create a symlink pointing to wrong location
      const agentsDir = join(testClaudeHome, "agents");
      await removeLink(join(agentsDir, "shaka"));
      await mkdir(agentsDir, { recursive: true });
      await symlink(join(tmpdir(), "shaka-test-wrong-path"), join(agentsDir, "shaka"), "junction");

      const result = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(result.agents.ok).toBe(false);
      expect(result.agents.issue).toContain("wrong location");
    });
  });

  describe("commands", () => {
    /** Helper: install + orchestrate commands (the real flow) */
    async function installWithCommands(configurer: ClaudeProviderConfigurer) {
      await configurer.install({ shakaHome: testShakaHome });
      await installCommandsForProviders(testShakaHome, [configurer]);
    }

    test("installs discovered commands as skills", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nAnalyze staged changes.\n\n$ARGUMENTS",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const skillFile = Bun.file(`${testClaudeHome}/skills/commit/SKILL.md`);
      expect(await skillFile.exists()).toBe(true);
      const content = await skillFile.text();
      expect(content).toContain("description: Create a commit");
      expect(content).toContain("user-invocable: true");
    });

    test("writes manifest after installing commands", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const manifest = await Bun.file(`${testShakaHome}/commands-manifest.json`).json();
      expect(manifest.global).toContain("commit");
    });

    test("cleans previous commands on reinstall", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/old-cmd.md`,
        "---\ndescription: Old command\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      // Install old command
      await installWithCommands(configurer);
      expect(await Bun.file(`${testClaudeHome}/skills/old-cmd/SKILL.md`).exists()).toBe(true);

      // Remove old, add new
      await rm(`${testShakaHome}/system/commands/old-cmd.md`);
      await Bun.write(
        `${testShakaHome}/system/commands/new-cmd.md`,
        "---\ndescription: New command\n---\nBody",
      );

      await installWithCommands(configurer);

      expect(await Bun.file(`${testClaudeHome}/skills/old-cmd/SKILL.md`).exists()).toBe(false);
      expect(await Bun.file(`${testClaudeHome}/skills/new-cmd/SKILL.md`).exists()).toBe(true);
    });

    test("skips pre-existing skill not in manifest", async () => {
      // Create a pre-existing skill
      await mkdir(`${testClaudeHome}/skills/commit`, { recursive: true });
      await Bun.write(`${testClaudeHome}/skills/commit/SKILL.md`, "pre-existing");

      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      // Should not overwrite the pre-existing skill
      const content = await Bun.file(`${testClaudeHome}/skills/commit/SKILL.md`).text();
      expect(content).toBe("pre-existing");
    });

    test("uninstall removes skills but leaves manifest for orchestrator", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);
      expect(await Bun.file(`${testClaudeHome}/skills/commit/SKILL.md`).exists()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });

      expect(await Bun.file(`${testClaudeHome}/skills/commit/SKILL.md`).exists()).toBe(false);
      expect(await Bun.file(`${testShakaHome}/commands-manifest.json`).exists()).toBe(true);
    });

    test("checkInstallation reports commands ok when installed", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/commit.md`,
        "---\ndescription: Create a commit\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(true);
    });

    test("checkInstallation reports commands ok when no commands exist", async () => {
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await configurer.install({ shakaHome: testShakaHome });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(true);
    });

    test("installs scoped command to cwd project directory", async () => {
      const projectDir = join(testClaudeHome, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        `---\ndescription: Deploy\ncwd: ${projectDir}\n---\nDeploy body`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const skillFile = Bun.file(join(projectDir, ".claude", "skills", "deploy", "SKILL.md"));
      expect(await skillFile.exists()).toBe(true);
      const content = await skillFile.text();
      expect(content).toContain("description: Deploy");
    });

    test("scoped command recorded in manifest", async () => {
      const projectDir = join(testClaudeHome, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        `---\ndescription: Deploy\ncwd: ${projectDir}\n---\nBody`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const manifest = await Bun.file(`${testShakaHome}/commands-manifest.json`).json();
      expect(manifest.scoped[projectDir]).toContain("deploy");
    });

    test("skips scoped command when cwd does not exist", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        "---\ndescription: Deploy\ncwd: /nonexistent/path/project\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const manifest = await Bun.file(`${testShakaHome}/commands-manifest.json`).json();
      // Manifest includes the scoped entry (deterministic from discovery),
      // but the actual file wasn't installed (directory doesn't exist)
      expect(manifest.scoped["/nonexistent/path/project"]).toContain("deploy");
    });

    test("uninstall cleans scoped commands", async () => {
      const projectDir = join(testClaudeHome, "project");
      await mkdir(projectDir, { recursive: true });
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/deploy.md`,
        `---\ndescription: Deploy\ncwd: ${projectDir}\n---\nBody`,
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);
      expect(
        await Bun.file(join(projectDir, ".claude", "skills", "deploy", "SKILL.md")).exists(),
      ).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });

      expect(
        await Bun.file(join(projectDir, ".claude", "skills", "deploy", "SKILL.md")).exists(),
      ).toBe(false);
    });

    test("applies provider overrides during compilation", async () => {
      await mkdir(`${testShakaHome}/system/commands`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/commands/test-cmd.md`,
        "---\ndescription: Test\nmodel: sonnet\nproviders:\n  claude:\n    model: opus\n---\nBody",
      );
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const content = await Bun.file(`${testClaudeHome}/skills/test-cmd/SKILL.md`).text();
      expect(content).toContain("model: opus");
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
      const configurer = new ClaudeProviderConfigurer({ claudeHome: testClaudeHome });

      await installWithCommands(configurer);

      const content = await Bun.file(`${testClaudeHome}/skills/commit/SKILL.md`).text();
      expect(content).toContain("description: Custom commit");
      expect(content).toContain("Custom body");
      expect(content).not.toContain("System body");
    });
  });

  describe("registerMcpServer", () => {
    test("calls claude mcp add with correct arguments", async () => {
      const calls: string[][] = [];
      const mockRunCommand = async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      };
      const configurer = new ClaudeProviderConfigurer({
        claudeHome: testClaudeHome,
        runCommand: mockRunCommand,
      });

      const result = await configurer.registerMcpServer();

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        "claude",
        "mcp",
        "add",
        "shaka",
        "-s",
        "user",
        "--",
        "shaka",
        "mcp",
        "serve",
      ]);
    });

    test("returns error when claude mcp add fails", async () => {
      const mockRunCommand = async () => ({
        exitCode: 1,
        stderr: "command not found",
      });
      const configurer = new ClaudeProviderConfigurer({
        claudeHome: testClaudeHome,
        runCommand: mockRunCommand,
      });

      const result = await configurer.registerMcpServer();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("claude mcp add failed");
      }
    });
  });

  describe("unregisterMcpServer", () => {
    test("calls claude mcp remove with correct arguments", async () => {
      const calls: string[][] = [];
      const mockRunCommand = async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stderr: "" };
      };
      const configurer = new ClaudeProviderConfigurer({
        claudeHome: testClaudeHome,
        runCommand: mockRunCommand,
      });

      const result = await configurer.unregisterMcpServer();

      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["claude", "mcp", "remove", "shaka", "-s", "user"]);
    });

    test("succeeds even if server not found", async () => {
      const mockRunCommand = async () => ({
        exitCode: 1,
        stderr: "Server shaka not found",
      });
      const configurer = new ClaudeProviderConfigurer({
        claudeHome: testClaudeHome,
        runCommand: mockRunCommand,
      });

      const result = await configurer.unregisterMcpServer();

      expect(result.ok).toBe(true);
    });
  });
});

describe("Hook Discovery (shared)", () => {
  const testShakaHome = join(tmpdir(), "shaka-test-discovery");

  beforeEach(async () => {
    await rm(testShakaHome, { recursive: true, force: true });
    await mkdir(`${testShakaHome}/system/hooks`, { recursive: true });

    // Use Shaka canonical names
    await Bun.write(
      `${testShakaHome}/system/hooks/session-start.ts`,
      `export const TRIGGER = ["session.start"] as const;
console.log("test");
`,
    );
  });

  afterEach(async () => {
    await rm(testShakaHome, { recursive: true, force: true });
  });

  describe("HOOK_EVENTS", () => {
    test("includes session.end", () => {
      expect(HOOK_EVENTS).toContain("session.end");
    });
  });

  describe("SHAKA_TO_CLAUDE_EVENT", () => {
    test("maps session.end to SessionEnd", () => {
      expect(SHAKA_TO_CLAUDE_EVENT["session.end"]).toBe("SessionEnd");
    });
  });

  describe("SHAKA_TO_OPENCODE_HOOK", () => {
    test("maps session.end to null (special handling)", () => {
      expect(SHAKA_TO_OPENCODE_HOOK["session.end"]).toBeNull();
    });
  });

  describe("parseHookTrigger", () => {
    const hooksDir = () => join(testShakaHome, "system", "hooks");

    test("extracts triggers from exported array", async () => {
      const result = await parseHookTrigger(join(hooksDir(), "session-start.ts"));
      expect(result.events).toEqual(["session.start"]);
      expect(result.matchers).toBeUndefined();
    });

    test("extracts multiple triggers", async () => {
      await Bun.write(
        join(hooksDir(), "multi-trigger.ts"),
        `export const TRIGGER = ["session.start", "prompt.submit"] as const;`,
      );
      const result = await parseHookTrigger(join(hooksDir(), "multi-trigger.ts"));
      expect(result.events).toEqual(["session.start", "prompt.submit"]);
    });

    test("extracts matchers when present", async () => {
      await Bun.write(
        join(hooksDir(), "with-matchers.ts"),
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash", "Edit"] as const;`,
      );
      const result = await parseHookTrigger(join(hooksDir(), "with-matchers.ts"));
      expect(result.events).toEqual(["tool.before"]);
      expect(result.matchers).toEqual(["Bash", "Edit"]);
    });

    test("returns empty events for file without TRIGGER export", async () => {
      await Bun.write(join(hooksDir(), "no-trigger.ts"), "console.log('no trigger');");
      const result = await parseHookTrigger(join(hooksDir(), "no-trigger.ts"));
      expect(result.events).toEqual([]);
    });

    test("filters out invalid TRIGGER values", async () => {
      await Bun.write(
        join(hooksDir(), "invalid-trigger.ts"),
        `export const TRIGGER = ["InvalidEvent", "session.start"] as const;`,
      );
      const result = await parseHookTrigger(join(hooksDir(), "invalid-trigger.ts"));
      expect(result.events).toEqual(["session.start"]);
    });

    test("returns empty events for non-array TRIGGER", async () => {
      await Bun.write(
        join(hooksDir(), "string-trigger.ts"),
        `export const TRIGGER = "session.start" as const;`,
      );
      const result = await parseHookTrigger(join(hooksDir(), "string-trigger.ts"));
      expect(result.events).toEqual([]);
    });

    test("returns empty events for non-existent file", async () => {
      const result = await parseHookTrigger(join(hooksDir(), "nonexistent.ts"));
      expect(result.events).toEqual([]);
    });
  });

  describe("discoverHooks", () => {
    test("discovers hooks with TRIGGER export", async () => {
      const hooks = await discoverHooks(`${testShakaHome}/system/hooks`);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.event).toBe("session.start");
      expect(hooks[0]?.filename).toBe("session-start.ts");
    });

    test("ignores files without TRIGGER export", async () => {
      await Bun.write(`${testShakaHome}/system/hooks/no-trigger.ts`, "console.log('no trigger');");
      const hooks = await discoverHooks(`${testShakaHome}/system/hooks`);
      expect(hooks).toHaveLength(1);
    });

    test("discovers multiple hooks", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/format-reminder.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;
console.log("format");
`,
      );
      const hooks = await discoverHooks(`${testShakaHome}/system/hooks`);
      expect(hooks).toHaveLength(2);
      expect(hooks.map((h) => h.event).sort()).toEqual(["prompt.submit", "session.start"]);
    });

    test("returns empty array for non-existent directory", async () => {
      const hooks = await discoverHooks("/nonexistent/path");
      expect(hooks).toEqual([]);
    });

    test("creates multiple entries for hook with multiple triggers", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/multi-event.ts`,
        `export const TRIGGER = ["session.start", "prompt.submit"] as const;
console.log("multi");
`,
      );
      const hooks = await discoverHooks(`${testShakaHome}/system/hooks`);
      const multiEventHooks = hooks.filter((h) => h.filename === "multi-event.ts");
      expect(multiEventHooks).toHaveLength(2);
      expect(multiEventHooks.map((h) => h.event).sort()).toEqual([
        "prompt.submit",
        "session.start",
      ]);
    });

    test("discovers hooks with matchers", async () => {
      await Bun.write(
        `${testShakaHome}/system/hooks/security-validator.ts`,
        `export const TRIGGER = ["tool.before"] as const;
export const MATCHER = ["Bash", "Edit", "Write"] as const;
console.log("security");
`,
      );
      const hooks = await discoverHooks(`${testShakaHome}/system/hooks`);
      const securityHooks = hooks.filter((h) => h.filename === "security-validator.ts");
      expect(securityHooks).toHaveLength(1);
      expect(securityHooks[0]?.event).toBe("tool.before");
      expect(securityHooks[0]?.matchers).toEqual(["Bash", "Edit", "Write"]);
    });
  });

  describe("discoverAllHooks", () => {
    test("discovers hooks from system/hooks/", async () => {
      const hooks = await discoverAllHooks(testShakaHome);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.event).toBe("session.start");
    });

    test("discovers hooks from customizations/hooks/", async () => {
      await mkdir(`${testShakaHome}/customizations/hooks`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/customizations/hooks/custom-hook.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;`,
      );

      const hooks = await discoverAllHooks(testShakaHome);
      expect(hooks).toHaveLength(2);
      expect(hooks.map((h) => h.event).sort()).toEqual(["prompt.submit", "session.start"]);
    });

    test("appends hooks with unique filenames from customizations/", async () => {
      await mkdir(`${testShakaHome}/customizations/hooks`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/customizations/hooks/extra.ts`,
        `export const TRIGGER = ["session.start"] as const;`,
      );

      const hooks = await discoverAllHooks(testShakaHome);
      const sessionStartHooks = hooks.filter((h) => h.event === "session.start");
      expect(sessionStartHooks).toHaveLength(2);
    });

    test("customization hook overrides system hook with same filename", async () => {
      await mkdir(`${testShakaHome}/customizations/hooks`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/customizations/hooks/session-start.ts`,
        `export const TRIGGER = ["prompt.submit"] as const;`,
      );

      const hooks = await discoverAllHooks(testShakaHome);
      // System session-start.ts (session.start) replaced by custom (prompt.submit)
      expect(hooks).toHaveLength(1);
      expect(hooks[0]?.event).toBe("prompt.submit");
      expect(hooks[0]?.path).toContain(join("customizations", "hooks"));
    });

    test("works when customizations/hooks/ does not exist", async () => {
      const hooks = await discoverAllHooks(testShakaHome);
      // Should still find system hooks without error
      expect(hooks).toHaveLength(1);
    });

    test("works when system/hooks/ does not exist", async () => {
      const emptyHome = join(tmpdir(), "shaka-test-empty-home");
      await rm(emptyHome, { recursive: true, force: true });
      await mkdir(emptyHome, { recursive: true });

      const hooks = await discoverAllHooks(emptyHome);
      expect(hooks).toEqual([]);

      await rm(emptyHome, { recursive: true, force: true });
    });
  });
});
