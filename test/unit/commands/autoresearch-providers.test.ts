import { describe, expect, test } from "bun:test";
import { resolveProviders } from "../../../src/commands/autoresearch";
import type { DetectedProviders } from "../../../src/services/provider-detection";

const none: DetectedProviders = { claude: false, opencode: false, codex: false, pi: false };
const claudeOnly: DetectedProviders = { claude: true, opencode: false, codex: false, pi: false };
const claudeAndOpencode: DetectedProviders = {
  claude: true,
  opencode: true,
  codex: false,
  pi: false,
};

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
      pi: false,
    });
  });

  test("forced-provider check runs before the no-providers-installed guard", () => {
    // Documents precedence: when nothing is installed AND a provider is
    // forced, the user sees the specific "X is not installed" message
    // rather than the generic "no providers available." The former is more
    // actionable (names the missing binary) and should win.
    expect(() => resolveProviders(none, "claude")).toThrow(/claude.*not installed/i);
  });

  test("returns the detected set when only Pi is installed", () => {
    // Pi-only environments must reach the loop just like every other
    // single-provider environment. Earlier the no-providers guard omitted
    // `pi` from its disjunction, so Pi-only users hit "no agent providers
    // available" even though the error message named pi as an option.
    const piOnly: DetectedProviders = { claude: false, opencode: false, codex: false, pi: true };
    expect(resolveProviders(piOnly, undefined)).toEqual(piOnly);
  });
});
