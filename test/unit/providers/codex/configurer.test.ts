import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProviderConfigurer } from "../../../../src/providers/codex/configurer";

describe("CodexProviderConfigurer", () => {
  // Per-test temp roots — never share a fixed path under $HOME because
  // (a) `rm -rf` on a real-home path can wipe a developer's local data if
  // it accidentally exists, and (b) parallel test runs would race.
  let testCodexHome: string;
  let testShakaHome: string;
  let testSkillsDir: string;
  let testRoot: string | undefined;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "shaka-codex-configurer-"));
    testCodexHome = join(testRoot, "codex");
    testShakaHome = join(testRoot, "shaka");
    testSkillsDir = join(testRoot, "agents", "skills");
    await mkdir(testCodexHome, { recursive: true });
    await mkdir(testSkillsDir, { recursive: true });
    await mkdir(`${testShakaHome}/system/hooks`, { recursive: true });
    await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
    await mkdir(`${testShakaHome}/system/skills`, { recursive: true });
    await mkdir(`${testShakaHome}/skills`, { recursive: true });
  });

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, { recursive: true, force: true });
      testRoot = undefined;
    }
  });

  /**
   * Build a configurer with isolation defaults baked in. Every test that
   * runs install/uninstall against the configurer should use this so the
   * default skillsDir (~/.agents/skills) doesn't reach the host filesystem.
   * Identity-only tests (`name`, `label`) can use the bare constructor.
   */
  type ConfigurerOptions = ConstructorParameters<typeof CodexProviderConfigurer>[0];
  function makeConfigurer(overrides: Partial<ConfigurerOptions> = {}): CodexProviderConfigurer {
    return new CodexProviderConfigurer({
      codexHome: testCodexHome,
      skillsDir: testSkillsDir,
      runCommand: async () => ({ exitCode: 0, stderr: "" }),
      ...overrides,
    });
  }

  function requireTestRoot(): string {
    if (!testRoot) throw new Error("testRoot not initialized");
    return testRoot;
  }

  describe("name", () => {
    test("returns codex", async () => {
      const configurer = new CodexProviderConfigurer({ codexHome: testCodexHome });
      expect(configurer.name).toBe("codex");
    });
  });

  describe("label", () => {
    test("returns Codex", async () => {
      const configurer = new CodexProviderConfigurer({ codexHome: testCodexHome });
      expect(configurer.label).toBe("Codex");
    });
  });

  describe("skillsDir", () => {
    test("defaults to ~/.agents/skills", async () => {
      const configurer = new CodexProviderConfigurer();
      expect(configurer.skillsDir).toBe(join(homedir(), ".agents", "skills"));
    });
  });

  describe("isInstalled", () => {
    test("returns boolean based on Bun.which", async () => {
      const configurer = new CodexProviderConfigurer({ codexHome: testCodexHome });
      // Just verify it returns a boolean — actual result depends on environment
      expect(typeof configurer.isInstalled()).toBe("boolean");
    });
  });

  describe("install", () => {
    test("enables hooks feature flag via runCommand", async () => {
      const capturedCalls: string[][] = [];
      const mockRunCommand = async (args: string[]) => {
        capturedCalls.push(args);
        return { exitCode: 0, stderr: "" };
      };

      const configurer = makeConfigurer({ runCommand: mockRunCommand });
      await configurer.install({ shakaHome: testShakaHome });

      expect(capturedCalls).toContainEqual(["codex", "features", "enable", "hooks"]);
    });

    test("returns ok result", async () => {
      const configurer = makeConfigurer();
      const result = await configurer.install({ shakaHome: testShakaHome });
      expect(result.ok).toBe(true);
    });

    test("fails without writing hooks when the hooks feature flag cannot be enabled", async () => {
      const configurer = makeConfigurer({
        runCommand: async () => ({ exitCode: 1, stderr: "feature flag unavailable" }),
      });

      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("codex features enable hooks failed");
        expect(result.error.message).toContain("feature flag unavailable");
      }
      expect(await Bun.file(join(testCodexHome, "hooks.json")).exists()).toBe(false);
      expect(await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).exists()).toBe(false);
    });

    test("generates wrapper script at codexHome/shaka-hook-wrapper.ts", async () => {
      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const wrapperPath = join(testCodexHome, "shaka-hook-wrapper.ts");
      const wrapperFile = Bun.file(wrapperPath);
      expect(await wrapperFile.exists()).toBe(true);

      const content = await wrapperFile.text();
      // Wrapper should read stdin, detect subagent, and spawn child
      expect(content).toContain("Bun.stdin.text()");
      expect(content).toContain("SHAKA_CODEX_SUBAGENT");
      expect(content).toContain("transcript_path");
      expect(content).toContain("Bun.spawn");
    });

    test("writes hooks.json with entries for discovered hooks", async () => {
      // Create a test hook in the test shakaHome
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-start.ts"),
        `export const TRIGGER = ["session.start"] as const;\nconsole.log("test");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksPath = join(testCodexHome, "hooks.json");
      const hooksFile = Bun.file(hooksPath);
      expect(await hooksFile.exists()).toBe(true);

      const hooksJson = await hooksFile.json();
      expect(hooksJson.hooks).toBeDefined();
      expect(hooksJson.hooks.SessionStart).toBeDefined();
      expect(hooksJson.hooks.SessionStart.length).toBeGreaterThan(0);
    });

    test("hooks.json entries point to wrapper with correct event names", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-start.ts"),
        `export const TRIGGER = ["session.start"] as const;\nconsole.log("test");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      const wrapperPath = join(testCodexHome, "shaka-hook-wrapper.ts");
      const sessionStartEntry = hooksJson.hooks.SessionStart[0];
      const command = sessionStartEntry.hooks[0].command;

      expect(command).toMatch(/^bun /);
      expect(command).toContain(wrapperPath);
      expect(command).toContain("SessionStart");
      expect(command).toContain("session-start.ts");
    });

    test("hook commands quote wrapperPath + hookPath so spaces in $HOME don't word-split", async () => {
      // Codex parses the `command` string through a shell. Spaces in
      // codexHome (or any hook path) would otherwise break the wrapper
      // invocation silently — same fix already in the Claude configurer.
      // Use a unique temp root so this doesn't race the sibling test in
      // `claude/configurer.test.ts` under parallel runs (both used to
      // point at `tmpdir()/shaka home with spaces`).
      const spacedRoot = await mkdtemp(join(tmpdir(), "shaka-codex-spaced-"));
      const spacedCodexHome = join(spacedRoot, "codex home with spaces");
      const spacedShaka = join(spacedRoot, "shaka home with spaces");
      try {
        await mkdir(`${spacedShaka}/system/hooks`, { recursive: true });
        await Bun.write(
          `${spacedShaka}/system/hooks/session-start.ts`,
          `export const TRIGGER = ["session.start"] as const;\nconsole.log("ok");\n`,
        );
        const configurer = new CodexProviderConfigurer({
          codexHome: spacedCodexHome,
          skillsDir: join(spacedRoot, "agents", "skills"),
          runCommand: async () => ({ exitCode: 0, stderr: "" }),
        });
        await configurer.install({ shakaHome: spacedShaka });

        const hooksJson = await Bun.file(join(spacedCodexHome, "hooks.json")).json();
        const cmd = hooksJson.hooks.SessionStart[0].hooks[0].command as string;

        // Wrapper + hook paths both wrapped in quotes so the spaces survive.
        expect(cmd).toMatch(/bun ["'][^"']*codex home with spaces[^"']*shaka-hook-wrapper\.ts["']/);
        expect(cmd).toMatch(/["'][^"']*shaka home with spaces[^"']*session-start\.ts["']/);
      } finally {
        await rm(spacedRoot, { recursive: true, force: true });
      }
    });

    test("generates debounce script when session.end hooks exist", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      // Debounce script should exist
      const debouncePath = join(testCodexHome, "shaka-session-debounce.ts");
      expect(await Bun.file(debouncePath).exists()).toBe(true);

      const content = await Bun.file(debouncePath).text();
      // Should read stdin
      expect(content).toContain("Bun.stdin.text()");
      // Should write marker file
      expect(content).toContain(".codex-pending-");
      // Should spawn a detached Bun worker without depending on a POSIX shell.
      expect(content).toContain(
        'Bun.spawn(["bun", workerPath, markerPath, String(timestamp), String(debounceMs)]',
      );
      expect(content).not.toContain('"sh", "-c"');
      // Should return continue: true
      expect(content).toContain('"continue": true');
    });

    test("generates debounce worker script when session.end hooks exist", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      // Worker script should exist
      const workerPath = join(testCodexHome, "shaka-debounce-worker.ts");
      expect(await Bun.file(workerPath).exists()).toBe(true);

      const content = await Bun.file(workerPath).text();
      // Should read marker path from argv
      expect(content).toContain("process.argv");
      // Should validate marker JSON
      expect(content).toContain("try");
      // Should check timestamp
      expect(content).toContain("timestamp");
      // Should reference session-end hook paths
      expect(content).toContain("session-end.ts");
      // Should spawn session-end worker
      expect(content).toContain("--worker");
      // Should delete marker after firing
      expect(content).toContain("unlink");
    });

    test("debounce worker derives hook temp-file names from path basename", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).text();
      expect(content).toContain('import { basename, join } from "node:path";');
      expect(content).toContain("basename(hookPath)");
      expect(content).not.toContain('hookPath.split("/")');
    });

    test("hooks.json registers debounce script under Stop event", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      // Stop event should now exist (registered by debounce)
      expect(hooksJson.hooks.Stop).toBeDefined();
      expect(hooksJson.hooks.Stop.length).toBe(1);
      const command = hooksJson.hooks.Stop[0].hooks[0].command;
      expect(command).toContain("shaka-session-debounce.ts");
    });

    test("hooks.json has no Stop entry when no session.end hooks exist", async () => {
      // Only create a session.start hook, no session.end
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-start-only.ts"),
        `export const TRIGGER = ["session.start"] as const;\nconsole.log("start");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      expect(hooksJson.hooks.Stop).toBeUndefined();
    });

    test("debounce script has session-end hook paths baked in", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const workerContent = await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).text();
      // Worker should have session-end.ts path baked in (JSON.stringify escapes backslashes on Windows)
      const expectedPath = join(testShakaHome, "system", "hooks", "session-end.ts");
      expect(
        workerContent.includes(expectedPath) ||
          workerContent.includes(expectedPath.replace(/\\/g, "\\\\")),
      ).toBe(true);
    });

    test("debounce script includes provider: codex in session-end payload", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const workerContent = await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).text();
      // Worker should include provider: "codex" in the session-end input
      expect(workerContent).toContain('"codex"');
      expect(workerContent).toContain("provider");
    });

    test("UserPromptSubmit wrapper deletes pending marker file", async () => {
      // Need both a prompt.submit and session.end hook
      await Bun.write(
        join(testShakaHome, "system", "hooks", "format-reminder.ts"),
        `export const TRIGGER = ["prompt.submit"] as const;\nconsole.log("reminder");\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const wrapperContent = await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).text();
      // Wrapper should delete pending marker on UserPromptSubmit
      expect(wrapperContent).toContain(".codex-pending-");
      expect(wrapperContent).toContain("UserPromptSubmit");
    });

    test("Codex debounce scripts encode session IDs before constructing marker paths", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "format-reminder.ts"),
        `export const TRIGGER = ["prompt.submit"] as const;\nconsole.log("reminder");\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const wrapperContent = await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).text();
      const debounceContent = await Bun.file(
        join(testCodexHome, "shaka-session-debounce.ts"),
      ).text();
      const workerContent = await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).text();

      expect(wrapperContent).toContain("safeSessionMarkerPath");
      expect(debounceContent).toContain("safeSessionMarkerPath");
      expect(workerContent).toContain("safeSessionFilePart");
      expect(wrapperContent).toContain("encodeURIComponent");
      expect(debounceContent).toContain("encodeURIComponent");
      expect(workerContent).toContain("encodeURIComponent");
    });

    test("hooks.json uses matchers for tool hooks", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "security-validator.ts"),
        `export const TRIGGER = ["tool.before"] as const;\nexport const MATCHER = ["Bash"] as const;\nconsole.log("validate");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      expect(hooksJson.hooks.PreToolUse).toBeDefined();
      const entry = hooksJson.hooks.PreToolUse[0];
      expect(entry.matcher).toBe("Bash");
    });

    test("installs agent symlinks", async () => {
      // Create an agent file
      await Bun.write(
        join(testShakaHome, "system", "agents", "architect.md"),
        "# Architect Agent\n",
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      // Agent symlink should exist: codexHome/agents/shaka -> shakaHome/system/agents
      const { lstat, readlink } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const linkPath = join(testCodexHome, "agents", "shaka");
      const stat = await lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await readlink(linkPath);
      expect(resolve(target)).toBe(resolve(join(testShakaHome, "system", "agents")));
    });

    test("hooks.json SessionStart entry has startup|resume matcher", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-start.ts"),
        `export const TRIGGER = ["session.start"] as const;\nconsole.log("test");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      const entry = hooksJson.hooks.SessionStart[0];
      expect(entry.matcher).toBe("startup|resume");
    });

    test("hooks.json UserPromptSubmit entry has no matcher", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "format-reminder.ts"),
        `export const TRIGGER = ["prompt.submit"] as const;\nconsole.log("reminder");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      expect(hooksJson.hooks.UserPromptSubmit).toBeDefined();
      const entry = hooksJson.hooks.UserPromptSubmit[0];
      // UserPromptSubmit should NOT have a matcher
      expect(entry.matcher).toBeUndefined();
    });

    test("wrapper script handles PreToolUse with verbatim passthrough", async () => {
      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).text();
      // Verify event branching for PreToolUse/PostToolUse passthrough
      expect(content).toContain('eventName === "PreToolUse"');
      expect(content).toContain('eventName === "PostToolUse"');
      // Verify exit code 2 passthrough
      expect(content).toContain("exitCode === 2");
      expect(content).toContain("process.exit(2)");
      // Verify SessionStart/UserPromptSubmit wrapping
      expect(content).toContain("hookSpecificOutput");
      expect(content).toContain("hookEventName");
      expect(content).toContain("additionalContext");
    });

    test("hooks.json handles multiple hooks across different events", async () => {
      // Create hooks for three different events
      // Use unique filenames to avoid module-cache collisions with other tests
      await Bun.write(
        join(testShakaHome, "system", "hooks", "multi-start.ts"),
        `export const TRIGGER = ["session.start"] as const;\nconsole.log("start");\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "hooks", "multi-reminder.ts"),
        `export const TRIGGER = ["prompt.submit"] as const;\nconsole.log("reminder");\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "hooks", "multi-validator.ts"),
        `export const TRIGGER = ["tool.before"] as const;\nexport const MATCHER = ["Bash", "Edit"] as const;\nconsole.log("validate");\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      expect(hooksJson.hooks.SessionStart).toBeDefined();
      expect(hooksJson.hooks.UserPromptSubmit).toBeDefined();
      expect(hooksJson.hooks.PreToolUse).toBeDefined();

      // PreToolUse should have two entries (one per matcher: Bash, Edit)
      expect(hooksJson.hooks.PreToolUse.length).toBe(2);
      const matchers = hooksJson.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher).sort();
      expect(matchers).toEqual(["Bash", "Edit"]);
    });

    test("install is idempotent (regenerates on every call)", async () => {
      const configurer = makeConfigurer();

      // Install twice
      await configurer.install({ shakaHome: testShakaHome });
      await configurer.install({ shakaHome: testShakaHome });

      // Should still have valid files
      expect(await Bun.file(join(testCodexHome, "hooks.json")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).exists()).toBe(true);

      // hooks.json should be valid JSON
      const hooksJson = await Bun.file(join(testCodexHome, "hooks.json")).json();
      expect(hooksJson.hooks).toBeDefined();
    });

    test("installs skill symlinks", async () => {
      // Create a skill directory with a SKILL.md
      const skillDir = join(testShakaHome, "system", "skills", "council");
      await mkdir(skillDir, { recursive: true });
      await Bun.write(join(skillDir, "SKILL.md"), "# council skill\n");

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      await configurer.install({ shakaHome: testShakaHome });

      // Skill symlink should exist: skillsDir/council -> shakaHome/system/skills/council
      const { lstat, readlink } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const linkPath = join(testSkillsDir, "council");
      const stat = await lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await readlink(linkPath);
      expect(resolve(target)).toBe(resolve(skillDir));
    });
  });

  describe("agent TOML generation", () => {
    test("install generates TOML files for non-hidden agents", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Architect.md"),
        `---\nname: Architect\ndescription: Elite system design specialist\npermissions:\n  allow:\n    - "Bash"\n    - "Read(*)"\n    - "Write(*)"\n    - "Edit(*)"\nmode: subagent\n---\n\n# Core Identity\nYou are an elite system architect.\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const tomlPath = join(testCodexHome, "agents", "Architect.toml");
      const tomlFile = Bun.file(tomlPath);
      expect(await tomlFile.exists()).toBe(true);

      const content = await tomlFile.text();
      expect(content).toContain('name = "Architect"');
      expect(content).toContain('description = "Elite system design specialist"');
      expect(content).toContain('sandbox_mode = "workspace-write"');
      expect(content).toContain("developer_instructions = '''");
      expect(content).toContain("# Core Identity");
      expect(content).toContain("You are an elite system architect.");
    });

    test("install skips agents with hidden: true", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "inference.md"),
        `---\nname: inference\ndescription: Internal inference agent\nhidden: true\npermissions:\n  deny:\n    - "Bash"\nmode: subagent\n---\n\nYou are a text-only inference assistant.\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const tomlPath = join(testCodexHome, "agents", "inference.toml");
      expect(await Bun.file(tomlPath).exists()).toBe(false);
    });

    test("install parses CRLF frontmatter in agent files", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "WindowsAgent.md"),
        [
          "---",
          "name: WindowsAgent",
          "description: Agent with CRLF frontmatter",
          "---",
          "",
          "Use Windows-authored line endings.",
          "",
        ].join("\r\n"),
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(join(testCodexHome, "agents", "WindowsAgent.toml")).text();
      expect(content).toContain('name = "WindowsAgent"');
      expect(content).toContain("Use Windows-authored line endings.");
    });

    test("install maps deny permissions to read-only sandbox", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "ReadOnly.md"),
        `---\nname: ReadOnly\ndescription: Read-only agent\npermissions:\n  deny:\n    - "Write(*)"\n    - "Edit(*)"\nmode: subagent\n---\n\nYou can only read.\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(join(testCodexHome, "agents", "ReadOnly.toml")).text();
      expect(content).toContain('sandbox_mode = "read-only"');
    });

    test("install tolerates malformed permission arrays in agent frontmatter", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "MalformedPermissions.md"),
        `---\nname: MalformedPermissions\ndescription: Agent with malformed permissions\npermissions:\n  allow: "Write(*)"\n---\n\nBuild carefully.\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(
        join(testCodexHome, "agents", "MalformedPermissions.toml"),
      ).text();
      expect(content).toContain('name = "MalformedPermissions"');
    });

    test("install uses the source filename, not frontmatter name, for TOML file paths", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "SafeSource.md"),
        `---\nname: ../../escape\ndescription: Path-like display name\npermissions:\n  allow:\n    - "Read(*)"\n---\n\nRead only.\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      expect(await Bun.file(join(testCodexHome, "agents", "SafeSource.toml")).exists()).toBe(true);
      expect(await Bun.file(join(requireTestRoot(), "escape.toml")).exists()).toBe(false);
    });

    test("install uses TOML literal strings for developer_instructions", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "TestAgent.md"),
        `---\nname: TestAgent\ndescription: Test agent with backslashes\npermissions:\n  allow:\n    - "Bash"\n---\n\nRegex pattern: \\d+\\.\\d+\nCode: \`const x = "hello"\`\n`,
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      const content = await Bun.file(join(testCodexHome, "agents", "TestAgent.toml")).text();
      expect(content).toContain("developer_instructions = '''");
      // Backslashes are preserved literally (no double-escaping)
      expect(content).toContain("\\d+\\.\\d+");
    });

    test("install generates TOML for multiple agents, skipping hidden", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Engineer.md"),
        `---\nname: Engineer\ndescription: Principal engineer\npermissions:\n  allow:\n    - "Write(*)"\n    - "Edit(*)"\n---\n\nBuild things.\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "agents", "Designer.md"),
        `---\nname: Designer\ndescription: UX designer\npermissions:\n  allow:\n    - "Read(*)"\n---\n\nDesign things.\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "agents", "inference.md"),
        "---\nname: inference\ndescription: Internal\nhidden: true\n---\n\nInternal only.\n",
      );

      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      expect(await Bun.file(join(testCodexHome, "agents", "Engineer.toml")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "agents", "Designer.toml")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "agents", "inference.toml")).exists()).toBe(false);
    });

    test("install fails before writing TOMLs when normalized agent filenames collide", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Data Scientist.md"),
        "---\nname: Data Scientist\ndescription: First agent\n---\n\nFirst.\n",
      );
      await Bun.write(
        join(testShakaHome, "system", "agents", "Data-Scientist.md"),
        "---\nname: Data-Scientist\ndescription: Second agent\n---\n\nSecond.\n",
      );

      const configurer = makeConfigurer();
      const result = await configurer.install({ shakaHome: testShakaHome });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Duplicate generated Codex agent filename");
        expect(result.error.message).toContain("Data-Scientist.toml");
      }
      expect(await Bun.file(join(testCodexHome, "agents", "Data-Scientist.toml")).exists()).toBe(
        false,
      );
    });

    test("install prunes stale generated TOMLs while preserving handwritten TOMLs", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Architect.md"),
        "---\nname: Architect\ndescription: System architect\n---\n\nArchitect things.\n",
      );
      const configurer = makeConfigurer();
      await configurer.install({ shakaHome: testShakaHome });

      await Bun.write(join(testCodexHome, "agents", "custom.toml"), 'name = "custom"\n');
      await rm(join(testShakaHome, "system", "agents", "Architect.md"));
      await Bun.write(
        join(testShakaHome, "system", "agents", "Engineer.md"),
        "---\nname: Engineer\ndescription: Principal engineer\n---\n\nEngineer things.\n",
      );

      await configurer.install({ shakaHome: testShakaHome });

      expect(await Bun.file(join(testCodexHome, "agents", "Architect.toml")).exists()).toBe(false);
      expect(await Bun.file(join(testCodexHome, "agents", "Engineer.toml")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "agents", "custom.toml")).exists()).toBe(true);
    });

    test("uninstall removes generated TOML files matching source agents", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Architect.md"),
        `---\nname: Architect\ndescription: System architect\npermissions:\n  allow:\n    - "Write(*)"\n---\n\nArchitect things.\n`,
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      await configurer.install({ shakaHome: testShakaHome });
      expect(await Bun.file(join(testCodexHome, "agents", "Architect.toml")).exists()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });
      expect(await Bun.file(join(testCodexHome, "agents", "Architect.toml")).exists()).toBe(false);
    });

    test("uninstall does not remove non-shaka TOML files", async () => {
      await mkdir(join(testCodexHome, "agents"), { recursive: true });
      await Bun.write(
        join(testCodexHome, "agents", "my-custom-agent.toml"),
        'name = "my-custom-agent"\n',
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      await configurer.uninstall({ shakaHome: testShakaHome });

      expect(await Bun.file(join(testCodexHome, "agents", "my-custom-agent.toml")).exists()).toBe(
        true,
      );
    });

    test("checkInstallation verifies TOML files exist for non-hidden agents", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Engineer.md"),
        `---\nname: Engineer\ndescription: Engineer\npermissions:\n  allow:\n    - "Write(*)"\n---\n\nBuild.\n`,
      );
      await Bun.write(
        join(testShakaHome, "system", "agents", "inference.md"),
        "---\nname: inference\ndescription: Internal\nhidden: true\n---\n\nInternal.\n",
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      await configurer.install({ shakaHome: testShakaHome });

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.agents.ok).toBe(true);
    });

    test("checkInstallation reports missing TOML files", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Engineer.md"),
        `---\nname: Engineer\ndescription: Engineer\npermissions:\n  allow:\n    - "Write(*)"\n---\n\nBuild.\n`,
      );

      // Set up valid hooks but NO TOML files
      await Bun.write(join(testCodexHome, "hooks.json"), JSON.stringify({ hooks: {} }));
      await Bun.write(join(testCodexHome, "shaka-hook-wrapper.ts"), "// wrapper");

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.agents.ok).toBe(false);
      expect(status.agents.issue).toContain("TOML");
    });

    test("checkInstallation reports stale generated TOML files", async () => {
      await Bun.write(
        join(testShakaHome, "system", "agents", "Architect.md"),
        "---\nname: Architect\ndescription: System architect\n---\n\nArchitect things.\n",
      );
      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      await configurer.install({ shakaHome: testShakaHome });
      await rm(join(testShakaHome, "system", "agents", "Architect.md"));

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.agents.ok).toBe(false);
      expect(status.agents.issue).toContain("stale");
      expect(status.agents.issue).toContain("Architect.toml");
    });

    test("checkInstallation reports missing global command skills", async () => {
      await mkdir(join(testShakaHome, "system", "commands"), { recursive: true });
      await Bun.write(
        join(testShakaHome, "system", "commands", "commit.md"),
        "---\ndescription: Create a commit\n---\nBody\n",
      );
      await Bun.write(
        join(testShakaHome, "commands-manifest.json"),
        JSON.stringify({ global: ["commit"], scoped: {} }),
      );
      await Bun.write(join(testCodexHome, "hooks.json"), JSON.stringify({ hooks: {} }));
      await Bun.write(join(testCodexHome, "shaka-hook-wrapper.ts"), "// wrapper");

      const configurer = makeConfigurer();

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(false);
      expect(status.commands.issue).toContain("not installed");
    });

    test("checkInstallation reports invalid command manifests as command issues", async () => {
      await Bun.write(
        join(testShakaHome, "commands-manifest.json"),
        JSON.stringify({ global: ["../escape"], scoped: {} }),
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(false);
      expect(status.commands.issue).toContain("Invalid command manifest");
    });

    test("checkInstallation ignores scoped-only commands", async () => {
      await mkdir(join(testShakaHome, "system", "commands"), { recursive: true });
      await Bun.write(
        join(testShakaHome, "system", "commands", "deploy.md"),
        "---\ndescription: Deploy\ncwd:\n  - /projects/app\n---\nBody\n",
      );
      await Bun.write(
        join(testShakaHome, "commands-manifest.json"),
        JSON.stringify({ global: [], scoped: { "/projects/app": ["deploy"] } }),
      );
      await Bun.write(join(testCodexHome, "hooks.json"), JSON.stringify({ hooks: {} }));
      await Bun.write(join(testCodexHome, "shaka-hook-wrapper.ts"), "// wrapper");

      const configurer = makeConfigurer();

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });

      expect(status.commands.ok).toBe(true);
    });
  });

  describe("installCommands (skeleton)", () => {
    test("does not throw", async () => {
      const configurer = new CodexProviderConfigurer({ codexHome: testCodexHome });
      // Should not throw even with empty inputs
      await configurer.installCommands({
        commands: [],
        manifest: { global: [], scoped: {} },
      });
    });
  });

  describe("uninstall", () => {
    test("removes hooks.json and wrapper script", async () => {
      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      // First install to create files
      await configurer.install({ shakaHome: testShakaHome });
      expect(await Bun.file(join(testCodexHome, "hooks.json")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).exists()).toBe(true);

      // Now uninstall
      const result = await configurer.uninstall({ shakaHome: testShakaHome });
      expect(result.ok).toBe(true);
      expect(await Bun.file(join(testCodexHome, "hooks.json")).exists()).toBe(false);
      expect(await Bun.file(join(testCodexHome, "shaka-hook-wrapper.ts")).exists()).toBe(false);
    });

    test("removes debounce scripts", async () => {
      await Bun.write(
        join(testShakaHome, "system", "hooks", "session-end.ts"),
        `export const TRIGGER = ["session.end"] as const;\nconsole.log("end");\n`,
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      await configurer.install({ shakaHome: testShakaHome });
      expect(await Bun.file(join(testCodexHome, "shaka-session-debounce.ts")).exists()).toBe(true);
      expect(await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).exists()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });
      expect(await Bun.file(join(testCodexHome, "shaka-session-debounce.ts")).exists()).toBe(false);
      expect(await Bun.file(join(testCodexHome, "shaka-debounce-worker.ts")).exists()).toBe(false);
    });

    test("removes agent symlinks", async () => {
      await Bun.write(join(testShakaHome, "system", "agents", "architect.md"), "# Architect\n");

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      await configurer.install({ shakaHome: testShakaHome });
      const { lstat } = await import("node:fs/promises");
      const agentLink = join(testCodexHome, "agents", "shaka");
      expect((await lstat(agentLink)).isSymbolicLink()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });
      let exists = true;
      try {
        await lstat(agentLink);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    test("removes skill symlinks", async () => {
      const skillDir = join(testShakaHome, "system", "skills", "council");
      await mkdir(skillDir, { recursive: true });
      await Bun.write(join(skillDir, "SKILL.md"), "# council\n");

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });

      await configurer.install({ shakaHome: testShakaHome });
      const { lstat } = await import("node:fs/promises");
      const skillLink = join(testSkillsDir, "council");
      expect((await lstat(skillLink)).isSymbolicLink()).toBe(true);

      await configurer.uninstall({ shakaHome: testShakaHome });
      let exists = true;
      try {
        await lstat(skillLink);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    test("returns ok result even when nothing to uninstall", async () => {
      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      const result = await configurer.uninstall({ shakaHome: testShakaHome });
      expect(result.ok).toBe(true);
    });
  });

  describe("checkInstallation", () => {
    test("reports missing hooks.json", async () => {
      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.hooks.ok).toBe(false);
      expect(status.hooks.issue).toContain("hooks.json");
    });

    test("reports invalid hooks.json", async () => {
      await Bun.write(join(testCodexHome, "hooks.json"), "not valid json");

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.hooks.ok).toBe(false);
      expect(status.hooks.issue).toContain("parse");
    });

    test("reports hooks.json missing hooks key", async () => {
      await Bun.write(join(testCodexHome, "hooks.json"), JSON.stringify({ other: true }));

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.hooks.ok).toBe(false);
      expect(status.hooks.issue).toContain("hooks");
    });

    test("reports missing wrapper script", async () => {
      // Write valid hooks.json but no wrapper
      await Bun.write(
        join(testCodexHome, "hooks.json"),
        JSON.stringify({ hooks: { SessionStart: [] } }),
      );

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.hooks.ok).toBe(false);
      expect(status.hooks.issue).toContain("wrapper");
    });

    test("returns all ok after successful install", async () => {
      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        skillsDir: testSkillsDir,
        runCommand: async () => ({ exitCode: 0, stderr: "" }),
      });
      await configurer.install({ shakaHome: testShakaHome });

      const status = await configurer.checkInstallation({ shakaHome: testShakaHome });
      expect(status.hooks.ok).toBe(true);
      expect(status.agents.ok).toBe(true);
      expect(status.skills.ok).toBe(true);
      expect(status.commands.ok).toBe(true);
      expect(status.installedSkills.ok).toBe(true);
    });
  });

  describe("registerMcpServer", () => {
    test("shells out to codex mcp add shaka", async () => {
      let capturedArgs: string[] = [];
      const mockRunCommand = async (args: string[]) => {
        capturedArgs = args;
        return { exitCode: 0, stderr: "" };
      };

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.registerMcpServer();
      expect(result.ok).toBe(true);
      expect(capturedArgs).toEqual(["codex", "mcp", "add", "shaka", "--", "shaka", "mcp", "serve"]);
    });

    test("returns error when command fails", async () => {
      const mockRunCommand = async (_args: string[]) => ({
        exitCode: 1,
        stderr: "mcp add failed",
      });

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.registerMcpServer();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("codex mcp add failed");
      }
    });
  });

  describe("unregisterMcpServer", () => {
    test("shells out to codex mcp remove shaka", async () => {
      let capturedArgs: string[] = [];
      const mockRunCommand = async (args: string[]) => {
        capturedArgs = args;
        return { exitCode: 0, stderr: "" };
      };

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.unregisterMcpServer();
      expect(result.ok).toBe(true);
      expect(capturedArgs).toEqual(["codex", "mcp", "remove", "shaka"]);
    });

    test("returns error when command fails", async () => {
      const mockRunCommand = async (_args: string[]) => ({
        exitCode: 1,
        stderr: "mcp remove failed",
      });

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.unregisterMcpServer();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("codex mcp remove failed");
      }
    });

    test("ignores not-found errors", async () => {
      const mockRunCommand = async (_args: string[]) => ({
        exitCode: 1,
        stderr: "server not found",
      });

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.unregisterMcpServer();
      expect(result.ok).toBe(true);
    });

    test("does not ignore unrelated not-found errors", async () => {
      const mockRunCommand = async (_args: string[]) => ({
        exitCode: 1,
        stderr: "config file not found",
      });

      const configurer = new CodexProviderConfigurer({
        codexHome: testCodexHome,
        runCommand: mockRunCommand,
      });
      const result = await configurer.unregisterMcpServer();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("codex mcp remove failed");
      }
    });
  });
});
