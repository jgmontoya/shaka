import { describe, expect, test } from "bun:test";
import { createInitCommand } from "../../../src/commands/init";
import { buildReinitArgs } from "../../../src/commands/update";
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
