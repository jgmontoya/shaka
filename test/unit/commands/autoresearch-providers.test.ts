import { describe, expect, test } from "bun:test";
import { resolveProviders } from "../../../src/commands/autoresearch";
import type { DetectedProviders } from "../../../src/services/provider-detection";

const none: DetectedProviders = { claude: false, opencode: false, codex: false };
const claudeOnly: DetectedProviders = { claude: true, opencode: false, codex: false };
const claudeAndOpencode: DetectedProviders = { claude: true, opencode: true, codex: false };

describe("resolveProviders", () => {
  test("throws an actionable error when no providers are installed", () => {
    expect(() => resolveProviders(none, undefined)).toThrow(/no agent providers available/i);
  });

  test("returns the detected set when at least one provider is available and no override", () => {
    expect(resolveProviders(claudeAndOpencode, undefined)).toEqual(claudeAndOpencode);
  });

  test("throws when --provider is forced but the named CLI is not installed", () => {
    expect(() => resolveProviders(claudeOnly, "opencode")).toThrow(/opencode.*not installed/i);
  });

  test("returns a single-provider set when --provider names an installed CLI", () => {
    expect(resolveProviders(claudeAndOpencode, "claude")).toEqual({
      claude: true,
      opencode: false,
      codex: false,
    });
  });
});
