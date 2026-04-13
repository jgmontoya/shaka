import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../../../src/providers/command-manifest";
import { installCommandsForProviders } from "../../../src/providers/command-orchestrator";
import type { CommandInstallConfig, ProviderConfigurer } from "../../../src/providers/types";

describe("command-orchestrator", () => {
  const testHome = join(tmpdir(), `shaka-test-orchestrator-${process.pid}`);

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await mkdir(join(testHome, "system", "commands"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  /** Create a mock provider that records installCommands calls. */
  function mockProvider(
    name: "claude" | "opencode" | "codex",
    fn?: (config: CommandInstallConfig) => Promise<void>,
  ): ProviderConfigurer & { calls: CommandInstallConfig[] } {
    const calls: CommandInstallConfig[] = [];
    return {
      name,
      label: name,
      skillsDir: "/tmp/test-skills",
      calls,
      isInstalled: () => true,
      install: async () => ({ ok: true as const, value: undefined }),
      installCommands: async (config: CommandInstallConfig) => {
        calls.push(config);
        if (fn) await fn(config);
      },
      uninstall: async () => ({ ok: true as const, value: undefined }),
      checkInstallation: async () => ({
        hooks: { ok: true },
        agents: { ok: true },
        skills: { ok: true },
        installedSkills: { ok: true },
        commands: { ok: true },
      }),
    };
  }

  test("calls installCommands on each provider with discovered commands", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Create a commit\n---\nBody",
    );

    const claude = mockProvider("claude");
    const opencode = mockProvider("opencode");

    await installCommandsForProviders(testHome, [claude, opencode]);

    expect(claude.calls).toHaveLength(1);
    expect(opencode.calls).toHaveLength(1);
    const claudeConfig = claude.calls[0]!;
    const opencodeConfig = opencode.calls[0]!;
    expect(claudeConfig.commands).toHaveLength(1);
    expect(claudeConfig.commands[0]!.name).toBe("commit");
    // Both providers receive the same commands
    expect(opencodeConfig.commands).toEqual(claudeConfig.commands);
  });

  test("provider failure does not block other providers", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      "---\ndescription: Deploy\n---\nBody",
    );

    const failing = mockProvider("claude", async () => {
      throw new Error("Claude install exploded");
    });
    const healthy = mockProvider("opencode");

    await installCommandsForProviders(testHome, [failing, healthy]);

    // Healthy provider still got called
    expect(healthy.calls).toHaveLength(1);
    expect(healthy.calls[0]!.commands[0]!.name).toBe("deploy");
  });

  test("manifest reflects discovery, not install results", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      "---\ndescription: Deploy\n---\nBody",
    );

    // Provider throws — but manifest should still contain the command
    const failing = mockProvider("claude", async () => {
      throw new Error("boom");
    });

    await installCommandsForProviders(testHome, [failing]);

    const manifest = await readManifest(testHome);
    expect(manifest.global).toContain("deploy");
  });

  test("manifest correctly partitions global and scoped commands", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      "---\ndescription: Deploy\ncwd:\n  - /projects/app\n  - /projects/api\n---\nBody",
    );

    const provider = mockProvider("claude");
    await installCommandsForProviders(testHome, [provider]);

    const manifest = await readManifest(testHome);
    expect(manifest.global).toEqual(["commit"]);
    expect(manifest.scoped["/projects/app"]).toContain("deploy");
    expect(manifest.scoped["/projects/api"]).toContain("deploy");
  });

  test("writes manifest even with empty providers list", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );

    await installCommandsForProviders(testHome, []);

    const manifest = await readManifest(testHome);
    expect(manifest.global).toContain("commit");
  });

  test("providers receive current manifest for pre-existing file detection", async () => {
    // Write a manifest as if a previous install happened
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: ["old-cmd"], scoped: {} }),
    );
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );

    const provider = mockProvider("claude");
    await installCommandsForProviders(testHome, [provider]);

    // Provider should receive the existing manifest for cleanup decisions
    expect(provider.calls[0]!.manifest.global).toContain("old-cmd");
  });
});
