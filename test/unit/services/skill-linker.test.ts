import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSkillToProviders, unlinkSkillFromProviders } from "../../../src/services/skill-linker";

describe("skill-linker", () => {
  const testShakaHome = join(tmpdir(), "shaka-test-linker-home");
  const testXdgConfigHome = join(tmpdir(), "shaka-test-linker-xdg");
  let originalXdgConfigHome: string | undefined;

  async function writeConfig(enabled: { claude: boolean; opencode: boolean }): Promise<void> {
    await writeFile(
      join(testShakaHome, "config.json"),
      JSON.stringify({
        version: "1",
        reasoning: { enabled: true },
        permissions: { managed: true },
        providers: {
          claude: { enabled: enabled.claude },
          opencode: { enabled: enabled.opencode },
        },
        assistant: { name: "Shaka" },
        principal: { name: "User" },
      }),
    );
  }

  beforeEach(async () => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = testXdgConfigHome;

    await rm(testShakaHome, { recursive: true, force: true });
    await rm(testXdgConfigHome, { recursive: true, force: true });

    // Create shaka home with config and a skill
    await mkdir(join(testShakaHome, "skills", "trello"), { recursive: true });
    await Bun.write(join(testShakaHome, "skills", "trello", "SKILL.md"), "# Trello");
  });

  afterEach(async () => {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    await rm(testShakaHome, { recursive: true, force: true });
    await rm(testXdgConfigHome, { recursive: true, force: true });
  });

  test("does nothing when config is missing", async () => {
    // No config.json → no providers to link to
    await linkSkillToProviders(testShakaHome, "trello");
    // Should not throw and not create any directories
  });

  test("does nothing when no providers are enabled", async () => {
    await writeConfig({ claude: false, opencode: false });

    await linkSkillToProviders(testShakaHome, "trello");
    // No errors, no symlinks created
  });

  test("unlinkSkillFromProviders does nothing when config is missing", async () => {
    await unlinkSkillFromProviders(testShakaHome, "trello");
    // Should not throw
  });

  test("links and unlinks skill for enabled provider", async () => {
    await writeConfig({ claude: false, opencode: true });

    await linkSkillToProviders(testShakaHome, "trello");

    const providerSkillDir = join(testXdgConfigHome, "opencode", "skills", "trello");
    expect(await Bun.file(join(providerSkillDir, "SKILL.md")).exists()).toBe(true);

    await unlinkSkillFromProviders(testShakaHome, "trello");
    expect(await Bun.file(providerSkillDir).exists()).toBe(false);
  });

  test("unlink removes provider links even when provider is disabled", async () => {
    await writeConfig({ claude: false, opencode: true });

    await linkSkillToProviders(testShakaHome, "trello");
    const providerSkillDir = join(testXdgConfigHome, "opencode", "skills", "trello");
    expect(await Bun.file(join(providerSkillDir, "SKILL.md")).exists()).toBe(true);

    // Simulate provider disabled after install
    await writeConfig({ claude: false, opencode: false });
    await unlinkSkillFromProviders(testShakaHome, "trello");

    expect(await Bun.file(providerSkillDir).exists()).toBe(false);
  });
});
