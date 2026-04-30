/**
 * Pure-parser tests for the interactive provider-selection prompt in
 * `shaka init`. The parser is the testable seam — the surrounding
 * `promptProviderSelection` does only stdin I/O and console output.
 */

import { describe, expect, test } from "bun:test";
import { parseProviderSelection } from "../../../src/commands/init";
import type { ProviderName } from "../../../src/providers/types";

const ALL: ProviderName[] = ["claude", "opencode", "codex", "pi"];

describe("parseProviderSelection", () => {
  test("a single index returns just that provider (preserves existing single-select)", () => {
    const result = parseProviderSelection("1", ALL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers).toEqual(["claude"]);
  });

  test("comma-separated indices return that subset, in input order", () => {
    // Headline new behavior — `1,3` means "claude AND codex but not the
    // others." Order follows the user's input so they can predict the
    // installation sequence.
    const result = parseProviderSelection("1,3", ALL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers).toEqual(["claude", "codex"]);
  });

  test("the 'All' sentinel (one past the last provider) expands to every available provider", () => {
    // The menu always renders an extra `N+1. All` option after the
    // providers, so the sentinel index is `available.length + 1`.
    // Preserves the original single-select 'All' shortcut.
    const result = parseProviderSelection(String(ALL.length + 1), ALL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers).toEqual(ALL);
  });

  test("duplicate indices in the input collapse to a unique provider list", () => {
    // Sloppy input like `1,1,3` shouldn't install claude twice. Dedup
    // preserves first-occurrence order.
    const result = parseProviderSelection("1,1,3", ALL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providers).toEqual(["claude", "codex"]);
  });

  test("tolerates optional whitespace around commas (`1, 2,4`)", () => {
    // Real users type with a thumbprint of natural punctuation. `1, 2,4`,
    // `1 ,2 , 4`, and `1,2,4` must all mean the same thing — anything else
    // is the parser leaking shell discipline into a UX prompt.
    const compact = parseProviderSelection("1,2,4", ALL);
    const spaced = parseProviderSelection("1, 2,4", ALL);
    const messy = parseProviderSelection("  1 ,2 , 4  ", ALL);
    expect(compact.ok).toBe(true);
    expect(spaced.ok).toBe(true);
    expect(messy.ok).toBe(true);
    if (compact.ok && spaced.ok && messy.ok) {
      const expected: ProviderName[] = ["claude", "opencode", "pi"];
      expect(compact.providers).toEqual(expected);
      expect(spaced.providers).toEqual(expected);
      expect(messy.providers).toEqual(expected);
    }
  });

  test("any out-of-range or non-numeric token poisons the whole input", () => {
    // All-or-nothing on validity — partial acceptance would silently install
    // less than the user typed, which is worse than asking them to retype.
    expect(parseProviderSelection("99", ALL).ok).toBe(false);
    expect(parseProviderSelection("", ALL).ok).toBe(false);
    expect(parseProviderSelection("1,99", ALL).ok).toBe(false);
    expect(parseProviderSelection("abc", ALL).ok).toBe(false);
  });

  test("rejects numeric-prefix tokens like '1x' (Number.parseInt foot-gun)", () => {
    // `Number.parseInt("1x", 10)` returns 1, which would otherwise pass
    // through as a valid index and silently install the wrong provider set.
    expect(parseProviderSelection("1x", ALL).ok).toBe(false);
    expect(parseProviderSelection("1, 2x", ALL).ok).toBe(false);
  });

  test("validates remaining tokens after the 'All' shortcut", () => {
    // Without re-validation, `All,99` would early-return success on the
    // shortcut and silently drop the trailing junk token.
    const allIndex = String(ALL.length + 1);
    expect(parseProviderSelection(`${allIndex},99`, ALL).ok).toBe(false);
    expect(parseProviderSelection(`${allIndex},abc`, ALL).ok).toBe(false);
    // Sanity: combining `All` with a valid duplicate is still accepted.
    const combined = parseProviderSelection(`${allIndex},1`, ALL);
    expect(combined.ok).toBe(true);
    if (combined.ok) expect(combined.providers).toEqual([...ALL]);
  });
});
