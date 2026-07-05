import { describe, expect, test } from "bun:test";
import { createInitCommand } from "../../../src/commands/init";
import {
  buildReinitArgs,
  buildUpdatePlan,
  createUpdateCommand,
  type UpdateInfo,
} from "../../../src/commands/update";
import type { ShakaConfig } from "../../../src/domain/config";
import { getProviderNames } from "../../../src/providers/registry";

function makeConfig(enabled: {
  claude?: boolean;
  opencode?: boolean;
  codex?: boolean;
  pi?: boolean;
}): ShakaConfig {
  return {
    version: "0.12.0",
    reasoning: { enabled: true },
    permissions: { managed: true },
    providers: {
      claude: { enabled: enabled.claude ?? false },
      opencode: { enabled: enabled.opencode ?? false },
      ...(enabled.codex !== undefined && { codex: { enabled: enabled.codex } }),
      ...(enabled.pi !== undefined && { pi: { enabled: enabled.pi } }),
    },
    assistant: { name: "Shaka" },
    principal: { name: "User" },
  };
}

describe("buildReinitArgs", () => {
  test("replays every enabled provider, including codex and pi", () => {
    const args = buildReinitArgs(
      makeConfig({ claude: true, opencode: true, codex: true, pi: true }),
    );

    expect(args).not.toBeNull();
    expect(args).toContain("--defaults");
    expect(args).toContain("--claude");
    expect(args).toContain("--opencode");
    expect(args).toContain("--codex");
    expect(args).toContain("--pi");
  });

  test("omits disabled providers", () => {
    const args = buildReinitArgs(makeConfig({ codex: true, pi: true }));

    expect(args).toEqual(["--defaults", "--codex", "--pi"]);
  });

  test("handles configs from before codex/pi tracking", () => {
    const args = buildReinitArgs(makeConfig({ claude: true }));

    expect(args).toEqual(["--defaults", "--claude"]);
  });

  test("returns null when no providers are enabled", () => {
    expect(buildReinitArgs(makeConfig({}))).toBeNull();
    expect(buildReinitArgs(null)).toBeNull();
  });

  test("every registered provider can be replayed through init", () => {
    const initFlags = createInitCommand().options.map((option) => option.long);

    for (const name of getProviderNames()) {
      expect(initFlags).toContain(`--${name}`);
    }
  });
});

describe("buildUpdatePlan", () => {
  const minorUpdate: UpdateInfo = {
    localVersion: "0.12.0",
    latestTag: "v0.13.0",
    latestVersion: "0.13.0",
    isMajor: false,
  };

  test("shows the version delta and every enabled provider", () => {
    const plan = buildUpdatePlan(minorUpdate, makeConfig({ claude: true, codex: true, pi: true }));

    expect(plan).toContain("v0.12.0 → v0.13.0");
    expect(plan).toContain("git merge --ff-only v0.13.0");
    expect(plan).toContain("bun install");
    expect(plan).toContain("shaka init --defaults --claude --codex --pi");
  });

  test("states what is replaced and what is preserved", () => {
    const plan = buildUpdatePlan(minorUpdate, makeConfig({ claude: true }));

    expect(plan).toContain("system/");
    expect(plan).toContain("user/, memory/, customizations/, skills/, and config.json");
  });

  test("warns that re-initialization would be refused with no enabled providers", () => {
    const plan = buildUpdatePlan(minorUpdate, makeConfig({}));

    expect(plan).toContain("No providers enabled");
    expect(plan).not.toContain("shaka init --defaults");
  });

  test("notes that a major upgrade will ask for confirmation", () => {
    const majorUpdate: UpdateInfo = {
      localVersion: "0.12.0",
      latestTag: "v1.0.0",
      latestVersion: "1.0.0",
      isMajor: true,
    };

    const plan = buildUpdatePlan(majorUpdate, makeConfig({ claude: true }));

    expect(plan).toContain("Major version upgrade");
    expect(plan).toContain("--force");
  });

  test("never claims to have changed anything", () => {
    const plan = buildUpdatePlan(minorUpdate, makeConfig({ claude: true }));

    expect(plan).toContain("Dry run — no changes made");
  });
});

describe("update command options", () => {
  test("exposes --dry-run", () => {
    const flags = createUpdateCommand().options.map((option) => option.long);

    expect(flags).toContain("--dry-run");
  });
});
