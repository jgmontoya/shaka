import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PiProviderConfigurer } from "../../../../src/providers/pi/configurer";

interface CapturedHandlers {
  tool_call?: (event: unknown, ctx: unknown) => Promise<unknown>;
}

interface RegisteredTool {
  name?: string;
  execute?: (toolCallId: unknown, args: Record<string, unknown>) => Promise<unknown>;
}

describe("PiProviderConfigurer", () => {
  // Per-test temp roots — never share a fixed path under $HOME because
  // (a) `rm -rf` on a real-home path can wipe a developer's local data if
  // it accidentally exists, and (b) parallel test runs would race each
  // other through shared state.
  let testPiHome: string;
  let testShakaHome: string;
  let testRoot: string;
  /**
   * Build a configurer that never shells out to the real `pi` CLI. The
   * default smoke-load runner runs whenever `Bun.which("pi")` returns a
   * path — true on any developer machine with Pi installed — which would
   * otherwise leak real CLI behavior into these filesystem-only tests.
   */
  const noopSmokeLoad = async () => ({ exitCode: 0, stderr: "" });
  function createConfigurer(
    overrides: { piHome?: string; skillsDir?: string } = {},
  ): PiProviderConfigurer {
    return new PiProviderConfigurer({
      piHome: testPiHome,
      runSmokeLoad: noopSmokeLoad,
      ...overrides,
    });
  }

  async function loadInstalledExtension(
    extensionPath: string,
  ): Promise<{ handlers: CapturedHandlers; tools: RegisteredTool[] }> {
    const handlers: CapturedHandlers = {};
    const tools: RegisteredTool[] = [];
    const mod = await import(`${pathToFileURL(extensionPath).href}?t=${Date.now()}`);
    mod.default({
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
        (handlers as Record<string, unknown>)[name] = handler;
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    });
    return { handlers, tools };
  }

  function shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function restoreEnv(savedEnv: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "shaka-pi-configurer-"));
    testPiHome = join(testRoot, "pi", "agent");
    testShakaHome = join(testRoot, "shaka");
    await mkdir(testPiHome, { recursive: true });
    await mkdir(`${testShakaHome}/system/hooks`, { recursive: true });
    await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
    await mkdir(`${testShakaHome}/system/skills`, { recursive: true });
    await mkdir(`${testShakaHome}/skills`, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  describe("identity", () => {
    test("name is 'pi'", () => {
      const configurer = createConfigurer();
      expect(configurer.name).toBe("pi");
    });

    test("label is 'Pi'", () => {
      const configurer = createConfigurer();
      expect(configurer.label).toBe("Pi");
    });

    test("skillsDir defaults to <piHome>/skills", () => {
      const configurer = createConfigurer();
      expect(configurer.skillsDir).toBe(join(testPiHome, "skills"));
    });

    test("skillsDir can be overridden", () => {
      const configurer = new PiProviderConfigurer({
        piHome: testPiHome,
        skillsDir: "/custom/skills",
      });
      expect(configurer.skillsDir).toBe("/custom/skills");
    });
  });

  describe("install", () => {
    test("writes the Shaka extension to <piHome>/extensions/shaka.ts", async () => {
      const configurer = createConfigurer();

      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      const extensionPath = join(testPiHome, "extensions", "shaka.ts");
      const extensionContent = await Bun.file(extensionPath).text();
      expect(extensionContent).toContain("SHAKA_GENERATED_EXTENSION");
    });

    test("installed extension embeds install-time shakaHome", async () => {
      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });
      expect(result.ok).toBe(true);

      const extensionContent = await Bun.file(join(testPiHome, "extensions", "shaka.ts")).text();
      expect(extensionContent).toContain(
        `const INSTALLED_SHAKA_HOME = ${JSON.stringify(testShakaHome)};`,
      );
    });

    test.skipIf(process.platform === "win32")(
      "installed extension forwards install-time shakaHome to hook and tool subprocesses",
      async () => {
        const configurer = createConfigurer();
        const result = await configurer.install({
          shakaHome: testShakaHome,
          permissionMode: "apply",
        });
        expect(result.ok).toBe(true);

        const extensionPath = join(testPiHome, "extensions", "shaka.ts");
        const shakaBin = join(testRoot, "shaka-env-stub");
        const envLog = join(testRoot, "shaka-env.log");
        await Bun.write(
          shakaBin,
          [
            "#!/bin/sh",
            `printf '%s %s SHAKA_HOME=%s\\n' "$1" "$2" "$SHAKA_HOME" >> ${shellEscape(envLog)}`,
            "cat >/dev/null",
            "exit 0",
            "",
          ].join("\n"),
        );
        await chmod(shakaBin, 0o755);

        const savedEnv = { ...process.env };
        try {
          process.env.SHAKA_BIN = shakaBin;
          delete process.env.SHAKA_HOME;
          delete process.env.XDG_CONFIG_HOME;
          process.env.HOME = join(testRoot, "ambient-home");

          const { handlers, tools } = await loadInstalledExtension(extensionPath);
          await handlers.tool_call?.(
            { toolName: "bash", input: {} },
            { sessionManager: { id: "s" } },
          );

          const memorySearch = tools.find((tool) => tool.name === "memory-search");
          expect(memorySearch).toBeDefined();
          await memorySearch?.execute?.("call-1", { query: "anything" });

          const log = await Bun.file(envLog).text();
          expect(log).toContain(`hook tool.before SHAKA_HOME=${testShakaHome}`);
          expect(log).toContain(`tool memory-search SHAKA_HOME=${testShakaHome}`);
        } finally {
          restoreEnv(savedEnv);
        }
      },
    );

    test("translates each system agent into a shaka-agent-<name>/SKILL.md", async () => {
      // Pi has no native agent registry; the MVP path (pi.md Phase 5) is to
      // present each Shaka agent as a skill so it shows up in Pi's slash UI
      // alongside other resources.
      await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\ndescription: System design specialist\n---\nBody.\n",
      );

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      const skillPath = `${testPiHome}/skills/shaka-agent-Architect/SKILL.md`;
      const content = await Bun.file(skillPath).text();
      expect(content).toContain("description: System design specialist");
      expect(content).toContain("Body.");
    });

    test("symlinks each installed third-party skill with the shaka- prefix", async () => {
      await mkdir(`${testShakaHome}/skills/my-custom-skill`, { recursive: true });
      await Bun.write(`${testShakaHome}/skills/my-custom-skill/SKILL.md`, "# my-custom-skill\n");

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/skills/shaka-my-custom-skill/SKILL.md`).exists()).toBe(
        true,
      );
    });

    test("install refuses to overwrite a non-Shaka extensions/shaka.ts (preserves user file)", async () => {
      // Asymmetric data-loss vector: install writes shaka.ts
      // unconditionally, but uninstall only removes files carrying the
      // SHAKA_GENERATED_EXTENSION marker. A user who happened to name
      // their own Pi extension `shaka.ts` would have it clobbered on
      // install and never restored on uninstall.
      const userContent =
        "// my own extension, not Shaka-generated\nexport default function () {}\n";
      await mkdir(`${testPiHome}/extensions`, { recursive: true });
      await Bun.write(`${testPiHome}/extensions/shaka.ts`, userContent);

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      // User's file is untouched.
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).text()).toBe(userContent);
    });

    test("install rolls back the extension and skills when a later step throws", async () => {
      // Atomicity: install writes the extension first, then runs symlink
      // and agent steps. If a later step throws, the extension and any
      // earlier shaka-* artifacts must be cleaned up — otherwise the
      // user is left with a half-installed Pi integration that doctor
      // will flag as broken state.
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\n---\nBody.\n",
      );

      // Force `installAgentSkills` to throw by pre-creating the target as
      // a regular file — mkdir(path, {recursive:true}) throws EEXIST when
      // the path exists as a non-directory.
      await mkdir(`${testPiHome}/skills`, { recursive: true });
      await Bun.write(`${testPiHome}/skills/shaka-agent-Architect`, "blocker");

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      // No Shaka artifacts left behind.
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
      expect(await Bun.file(`${testPiHome}/skills/shaka-be-creative`).exists()).toBe(false);
    });

    test("is idempotent — re-running install leaves the same state", async () => {
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");

      const configurer = createConfigurer();
      const first = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });
      const second = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/skills/shaka-be-creative/SKILL.md`).exists()).toBe(true);
    });

    test("symlinks each system skill with the shaka- prefix", async () => {
      // Two system skills present
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");
      await mkdir(`${testShakaHome}/system/skills/tdd`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/tdd/SKILL.md`, "# tdd\n");

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      // Pi auto-loads ~/.agents/skills/ regardless of PI_CODING_AGENT_DIR
      // (Exp 47), so every Shaka-managed skill carries a shaka- prefix to
      // avoid collision with ambient user skills.
      expect(await Bun.file(`${testPiHome}/skills/shaka-be-creative/SKILL.md`).exists()).toBe(true);
      expect(await Bun.file(`${testPiHome}/skills/shaka-tdd/SKILL.md`).exists()).toBe(true);
    });
  });

  describe("install smoke-load gate", () => {
    test("aborts install AND removes the extension file when smoke-load reports failure", async () => {
      // Pi reports load failures clearly on stderr (Exp 44). The gate runs
      // `pi -p` against the freshly written extension and short-circuits if
      // it sees `Failed to load extension`, leaving the user without a
      // half-installed broken extension.
      const configurer = new PiProviderConfigurer({
        piHome: testPiHome,
        runSmokeLoad: async () => ({
          exitCode: 0,
          stderr: `Error: Failed to load extension "${testPiHome}/extensions/shaka.ts": Unexpected token`,
        }),
      });

      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to load extension");
      }
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
    });

    test("install succeeds when smoke-load reports clean load", async () => {
      const configurer = new PiProviderConfigurer({
        piHome: testPiHome,
        runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
      });

      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(true);
    });

    test("install fails when smoke-load exits non-zero (e.g., timeout) even without the failure marker", async () => {
      // `runProcessWithTimeout` reports timeouts and other runner failures
      // via exitCode !== 0. Without checking the exit code, install() would
      // succeed silently after a timeout/crash and leave a half-installed
      // extension whose load was never actually verified.
      const configurer = new PiProviderConfigurer({
        piHome: testPiHome,
        runSmokeLoad: async () => ({
          exitCode: 1,
          stderr: "Pi smoke-load timed out after 30000ms",
        }),
      });

      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toMatch(/timed out|exit/i);
      }
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
    });

    test("smoke-load escalates SIGTERM → SIGKILL so a SIGTERM-ignoring pi can't linger", async () => {
      // Sibling-shape with opencode runShakaTool (round-5), spawnCLI
      // (round-9), runAgentStep (original). Without escalation, a `pi`
      // process that traps SIGTERM keeps running orphaned after the
      // installer thinks it's done.
      if (process.platform === "win32") return;
      const { runProcessWithTimeout } = await import("../../../../src/providers/pi/configurer");
      const proc = Bun.spawn(
        [
          process.argv[0] ?? "bun",
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const start = performance.now();
      const result = await runProcessWithTimeout(proc, 100);
      const elapsed = performance.now() - start;

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/timed out/i);
      // Resolved within timeout + grace + slop. Without SIGKILL escalation,
      // the SIGTERM-trapping subprocess would hold the test forever (or
      // until process exit), and `await proc.exited` inside the helper
      // would never resolve.
      expect(elapsed).toBeLessThan(2000);
      // Confirm the process actually died (SIGKILL escapes the trap).
      // proc.exited is a Promise<exitCode>; awaiting it should resolve
      // promptly now that we asked for the kill chain.
      const exitCode = await proc.exited;
      expect(typeof exitCode).toBe("number");
    });

    test("smoke-load returns a timeout failure when pi hangs past the budget", async () => {
      // Hung `pi` processes (filesystem stalls, deadlock, etc.) used to
      // block `shaka init --pi` indefinitely with no user feedback.
      // `runProcessWithTimeout` races the process against a budget and
      // surfaces a clean error when the budget elapses, killing the child.
      const { runProcessWithTimeout } = await import("../../../../src/providers/pi/configurer");
      // The test's own bun runtime + a hanging JS snippet replaces the
      // POSIX-only `sleep` binary so runProcessWithTimeout is exercised
      // cross-platform. process.argv[0] is the bun binary path on every OS
      // bun supports.
      const proc = Bun.spawn([process.argv[0] ?? "bun", "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const start = performance.now();
      const result = await runProcessWithTimeout(proc, 100);
      const elapsed = performance.now() - start;

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/timed out/i);
      // Real upper bound is "well under the budget we'd be racing in prod";
      // be generous to absorb CI noise without missing genuine hangs.
      expect(elapsed).toBeLessThan(2000);
    });

    test("install rolls back the extension when smoke-load throws (not just when it returns an error)", async () => {
      // `smokeLoadExtension` calls into `runSmokeLoad`, which can throw
      // synchronously if `Bun.spawn` rejects (e.g., the `pi` binary
      // disappears between the `which` check and the spawn). Without a
      // catch around the smoke-load call, that throw bypasses the inline
      // `rm` and lands in the outer catch — leaving `extensions/shaka.ts`
      // on disk despite the install having failed.
      const configurer = new PiProviderConfigurer({
        piHome: testPiHome,
        runSmokeLoad: async () => {
          throw new Error("spawn ENOENT");
        },
      });

      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("spawn ENOENT");
      }
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
    });

    test("install proceeds when smoke-load returns clean (no error in stderr)", async () => {
      // The configurer is built via `createConfigurer()` which always
      // injects a no-op smoke-load runner. The "default skip when `pi`
      // isn't on PATH" path is integration-tested by CI environments
      // without `pi` installed; this unit test just pins that a clean
      // smoke-load return doesn't block install.
      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("installCommands", () => {
    test("writes a shaka- prefixed prompt template per command", async () => {
      const configurer = createConfigurer();

      await configurer.installCommands({
        commands: [
          {
            name: "commit",
            description: "Create a commit",
            body: "Stage and commit.\n\n$ARGUMENTS",
            sourcePath: "/system/commit.md",
          },
        ],
        manifest: { global: [], scoped: {} },
      });

      const promptPath = `${testPiHome}/prompts/shaka-commit.md`;
      expect(await Bun.file(promptPath).exists()).toBe(true);
      const content = await Bun.file(promptPath).text();
      expect(content).toContain("description: Create a commit");
      expect(content).toContain("Stage and commit.");
    });

    test("removes old commands listed in the manifest before writing new ones", async () => {
      const configurer = createConfigurer();

      // Pre-populate a Shaka-installed prompt that should be removed.
      await mkdir(`${testPiHome}/prompts`, { recursive: true });
      await Bun.write(
        `${testPiHome}/prompts/shaka-old-command.md`,
        "---\ndescription: stale\n---\nold body\n",
      );

      await configurer.installCommands({
        commands: [
          {
            name: "fresh",
            description: "Fresh command",
            body: "Body.\n\n$ARGUMENTS",
            sourcePath: "/system/fresh.md",
          },
        ],
        manifest: { global: ["old-command"], scoped: {} },
      });

      expect(await Bun.file(`${testPiHome}/prompts/shaka-old-command.md`).exists()).toBe(false);
      expect(await Bun.file(`${testPiHome}/prompts/shaka-fresh.md`).exists()).toBe(true);
    });
  });

  describe("uninstall", () => {
    test("removes the Shaka-generated extension file", async () => {
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const result = await configurer.uninstall({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
    });

    test("preserves a user's own extensions/shaka.ts (no Shaka marker)", async () => {
      // Pre-populate with a non-Shaka file at the same path.
      await mkdir(`${testPiHome}/extensions`, { recursive: true });
      const userContent =
        "// my own extension, not Shaka-generated\nexport default function () {}\n";
      await Bun.write(`${testPiHome}/extensions/shaka.ts`, userContent);

      const configurer = createConfigurer();
      const result = await configurer.uninstall({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      // User's file is untouched.
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).text()).toBe(userContent);
    });

    test("removes Shaka-installed prompt templates from <piHome>/prompts/", async () => {
      // installCommands writes prompts/shaka-*.md; uninstall must clean them
      // up too. Without this, `shaka uninstall` leaves Pi exposing Shaka
      // commands (visible in Pi's slash menu) after Shaka itself is gone.
      const configurer = createConfigurer();
      await configurer.installCommands({
        commands: [
          {
            name: "commit",
            description: "Create a commit",
            body: "Stage and commit.\n\n$ARGUMENTS",
            sourcePath: "/system/commit.md",
          },
        ],
        manifest: { global: [], scoped: {} },
      });
      // Pre-populate a non-Shaka prompt the user owns at the same dir, so we
      // can assert the cleanup is precisely scoped.
      await Bun.write(
        `${testPiHome}/prompts/my-personal-prompt.md`,
        "---\ndescription: mine\n---\nUser body.\n",
      );

      // Sanity: both files exist before uninstall.
      expect(await Bun.file(`${testPiHome}/prompts/shaka-commit.md`).exists()).toBe(true);

      const result = await configurer.uninstall({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });
      expect(result.ok).toBe(true);

      // Shaka prompt removed; user's prompt preserved.
      expect(await Bun.file(`${testPiHome}/prompts/shaka-commit.md`).exists()).toBe(false);
      expect(await Bun.file(`${testPiHome}/prompts/my-personal-prompt.md`).exists()).toBe(true);
    });

    test("removes translated agent skills (shaka-agent-<name>/ directories)", async () => {
      await mkdir(`${testShakaHome}/system/agents`, { recursive: true });
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\n---\nBody.\n",
      );
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Sanity: agent skill exists after install.
      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        true,
      );

      const result = await configurer.uninstall({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        false,
      );
    });

    test("removes shaka- prefixed skill symlinks while leaving user skills alone", async () => {
      await mkdir(`${testShakaHome}/system/skills/tdd`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/tdd/SKILL.md`, "# tdd\n");

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Drop a user skill alongside the Shaka-installed one.
      await mkdir(`${testPiHome}/skills/my-personal-skill`, { recursive: true });
      await Bun.write(`${testPiHome}/skills/my-personal-skill/SKILL.md`, "# my-personal-skill\n");

      const result = await configurer.uninstall({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(`${testPiHome}/skills/shaka-tdd/SKILL.md`).exists()).toBe(false);
      expect(await Bun.file(`${testPiHome}/skills/my-personal-skill/SKILL.md`).exists()).toBe(true);
    });
  });

  describe("checkInstallation", () => {
    test("hooks report ok after install writes the extension file", async () => {
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.hooks.ok).toBe(true);
    });

    test("agents report ok after install writes shaka-agent-<name>/SKILL.md", async () => {
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\ndescription: System design specialist\n---\nBody.\n",
      );

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.agents.ok).toBe(true);
    });

    test("install prunes stale shaka-agent-<name>/ directories whose source agent was removed", async () => {
      // Renaming or removing an agent in a future Shaka release would
      // otherwise leave the old `shaka-agent-OldName/` directory under Pi
      // forever — visible in Pi's slash menu, driving stale instructions —
      // and `checkAgentSkills` wouldn't notice (it only verifies current
      // agents exist). Reinstall must prune obsolete Shaka-prefixed agent
      // dirs to keep Pi's agent registry honest.
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\n---\nBody.\n",
      );
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });
      // Sanity: Architect is installed.
      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        true,
      );

      // Drop Architect, add a different agent — simulates a release where
      // the agent set changes.
      await rm(`${testShakaHome}/system/agents/Architect.md`);
      await Bun.write(
        `${testShakaHome}/system/agents/Reviewer.md`,
        "---\nname: Reviewer\n---\nBody.\n",
      );
      // Also pre-place a user-owned non-Shaka agent skill under skills/ to
      // confirm the prune is precisely scoped (only `shaka-agent-*`).
      await mkdir(`${testPiHome}/skills/my-personal-agent`, { recursive: true });
      await Bun.write(`${testPiHome}/skills/my-personal-agent/SKILL.md`, "# mine\n");

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        false,
      );
      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Reviewer/SKILL.md`).exists()).toBe(
        true,
      );
      // User's agent untouched.
      expect(await Bun.file(`${testPiHome}/skills/my-personal-agent/SKILL.md`).exists()).toBe(true);
    });

    test("install prunes stale shaka-agent-<name>/ directories when the source agents directory is removed", async () => {
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\n---\nBody.\n",
      );
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });
      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        true,
      );

      await rm(`${testShakaHome}/system/agents`, { recursive: true, force: true });

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      expect(await Bun.file(`${testPiHome}/skills/shaka-agent-Architect/SKILL.md`).exists()).toBe(
        false,
      );
    });

    test("install prunes only symlinks, never real shaka-<name>/ directories", async () => {
      // `installAssetSymlink` only ever creates symlinks. A real directory
      // sitting at a `shaka-<name>` path is by definition off-script —
      // either user-placed or left over from a prior abnormal state.
      // Mirrors `uninstallPrefixedSkills`'s "paranoia against an off-script
      // install state" guard so prune and uninstall agree on what's safe
      // to remove.
      await mkdir(`${testPiHome}/skills/shaka-orphan-realdir`, { recursive: true });
      await Bun.write(`${testPiHome}/skills/shaka-orphan-realdir/SKILL.md`, "# precious\n");

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Real directory is preserved — not in the expected set, but also
      // not a symlink, so prune leaves it alone.
      expect(await Bun.file(`${testPiHome}/skills/shaka-orphan-realdir/SKILL.md`).exists()).toBe(
        true,
      );
    });

    test("install fails fast when a skill name collides across system/skills and skills", async () => {
      // Both source trees flatten into a single `shaka-<name>` namespace under
      // Pi's skills dir. A name collision would silently shadow one source
      // with the other and leave `checkInstallation` reporting drift forever.
      // Surface the misconfiguration loudly instead — the user can either
      // rename their custom skill or move the override to `customizations/`.
      await mkdir(`${testShakaHome}/system/skills/shared-name`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/shared-name/SKILL.md`, "# system\n");
      await mkdir(`${testShakaHome}/skills/shared-name`, { recursive: true });
      await Bun.write(`${testShakaHome}/skills/shared-name/SKILL.md`, "# user\n");

      const configurer = createConfigurer();
      const result = await configurer.install({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("shared-name");
      }
      // Atomic install rolls back the extension on collision so no
      // half-installed state survives.
      expect(await Bun.file(`${testPiHome}/extensions/shaka.ts`).exists()).toBe(false);
    });

    test("install prunes stale shaka-<name>/ symlinks whose source skill was removed", async () => {
      // Same shape as the agent-skill prune above: removing a skill from
      // either source tree (`system/skills` or `skills`) must drop the
      // corresponding `shaka-<name>` link from Pi on the next install,
      // otherwise Pi keeps showing a skill that no longer exists upstream.
      // The prune has to look at the union of both source dirs because they
      // converge into one `skillsDir` — pruning per-source would have each
      // call delete the other's links.
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");
      await mkdir(`${testShakaHome}/skills/my-custom-skill`, { recursive: true });
      await Bun.write(`${testShakaHome}/skills/my-custom-skill/SKILL.md`, "# mine\n");

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });
      // Sanity: both shaka-* links exist.
      expect((await lstat(`${testPiHome}/skills/shaka-be-creative`)).isSymbolicLink()).toBe(true);
      expect((await lstat(`${testPiHome}/skills/shaka-my-custom-skill`)).isSymbolicLink()).toBe(
        true,
      );

      // Drop one skill from each source tree and pre-place a user-owned
      // skill (no `shaka-` prefix) so we can confirm the prune is precisely
      // scoped.
      await rm(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await rm(`${testShakaHome}/skills/my-custom-skill`, { recursive: true });
      await mkdir(`${testPiHome}/skills/my-personal-skill`, { recursive: true });
      await Bun.write(`${testPiHome}/skills/my-personal-skill/SKILL.md`, "# user\n");

      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Both shaka-* links pruned. lstat distinguishes "link gone" from
      // "link exists pointing at a deleted source" (Bun.file().exists()
      // follows symlinks and would falsely report a dead link as gone).
      await expect(lstat(`${testPiHome}/skills/shaka-be-creative`)).rejects.toThrow();
      await expect(lstat(`${testPiHome}/skills/shaka-my-custom-skill`)).rejects.toThrow();
      // User's skill untouched.
      expect(await Bun.file(`${testPiHome}/skills/my-personal-skill/SKILL.md`).exists()).toBe(true);
    });

    test("agents report not ok when an installed agent skill is missing", async () => {
      await Bun.write(
        `${testShakaHome}/system/agents/Architect.md`,
        "---\nname: Architect\ndescription: x\n---\nBody.\n",
      );

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Manually delete one of the installed agent-skill directories to
      // simulate post-install drift (manual rm, partial uninstall, etc.).
      await rm(`${testPiHome}/skills/shaka-agent-Architect`, {
        recursive: true,
        force: true,
      });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.agents.ok).toBe(false);
      expect(status.agents.issue).toContain("Architect");
    });

    test("skills report ok after install writes shaka-<name> symlinks for system skills", async () => {
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.skills.ok).toBe(true);
    });

    test("skills report not ok when a symlink points at the wrong source", async () => {
      // A user (or a half-finished partial uninstall) could replace a Shaka
      // symlink with one pointing elsewhere — `ln -sf /tmp/other`. Doctor
      // should surface the drift, not just check existence.
      await mkdir(`${testShakaHome}/system/skills/be-creative`, { recursive: true });
      await Bun.write(`${testShakaHome}/system/skills/be-creative/SKILL.md`, "# be-creative\n");
      await mkdir(`${testShakaHome}/decoy-target`, { recursive: true });

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      // Repoint the installed symlink at a decoy.
      const { unlink, symlink } = await import("node:fs/promises");
      await unlink(`${testPiHome}/skills/shaka-be-creative`);
      await symlink(
        `${testShakaHome}/decoy-target`,
        `${testPiHome}/skills/shaka-be-creative`,
        "junction",
      );

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.skills.ok).toBe(false);
      expect(status.skills.issue).toContain("be-creative");
    });

    test("installedSkills report ok after install writes shaka-<name> symlinks for third-party skills", async () => {
      await mkdir(`${testShakaHome}/skills/my-custom-skill`, { recursive: true });
      await Bun.write(`${testShakaHome}/skills/my-custom-skill/SKILL.md`, "# my-custom-skill\n");

      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      expect(status.installedSkills.ok).toBe(true);
    });

    test("commands report ok after a fresh install with no broken artifacts", async () => {
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      // Pi commands are written by `installCommands` (a separate
      // orchestration step). `install()` alone produces no command files,
      // so the contract is "no broken state" — same as the codex check.
      expect(status.commands.ok).toBe(true);
    });

    test("no field reports the legacy 'not implemented yet' placeholder", async () => {
      const configurer = createConfigurer();
      await configurer.install({ shakaHome: testShakaHome, permissionMode: "apply" });

      const status = await configurer.checkInstallation({
        shakaHome: testShakaHome,
        permissionMode: "apply",
      });

      // Regression guard: the v0.11 doctor reported every Pi field as
      // "Pi provider install not implemented yet" even though install
      // worked. This check fails fast if the placeholder leaks back in.
      for (const [_, component] of Object.entries(status)) {
        expect(component.issue ?? "").not.toContain("not implemented yet");
      }
    });
  });
});
