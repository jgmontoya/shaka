/**
 * CLI-level test for `shaka uninstall` flag handling. The point of testing
 * here (rather than in the service) is to lock in the CLI's *contract* with
 * the user — what flag combinations are accepted, what fails fast, what
 * silently ignores, etc.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logProviderStatus } from "../../../src/commands/uninstall";
import type { UninstallResult } from "../../../src/services/uninstall-service";
import { makeRunShaka } from "../../helpers/run-shaka";

const TEST_HOME = join(tmpdir(), `shaka-uninstall-cli-${process.pid}`);
const runShaka = makeRunShaka(TEST_HOME);

function captureConsole(fn: () => void): string {
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return captured.join("\n");
}

beforeEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("shaka uninstall — CLI flag contract", () => {
  test("unscoped uninstall prompt treats config.json as personal data", () => {
    const result = runShaka(["uninstall"], "\n");
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain(`${TEST_HOME}/config.json`);
    expect(output).toContain(`Your data is still at ${TEST_HOME}/`);
  });

  test("scoped uninstall does not print the global 'Shaka uninstalled' success or rm -rf hint", async () => {
    // After `shaka uninstall --pi`, only Pi's integration was removed —
    // Shaka itself is intact. Printing "✅ Shaka uninstalled." plus a hint
    // to `rm -rf $shakaHome` would be both factually wrong and actively
    // dangerous (instructs the user to delete their whole install).
    // Minimal install footprint: uninstall only runs when Shaka data exists.
    await mkdir(`${TEST_HOME}/system`, { recursive: true });
    const result = runShaka(["uninstall", "--pi"]);
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain("✅ Shaka uninstalled.");
    expect(output).not.toMatch(/rm -rf .*shaka-uninstall-cli/);
  });

  test("scoped uninstall renders out-of-scope detected providers as skipped, not failed", () => {
    // The previous status renderer had only three states (`removed`,
    // `failed`, `not installed`). A scoped `--pi` uninstall left the
    // skipped providers reporting as `{detected: true, uninstalled: false}`
    // — semantically "we didn't touch this", which used to render as the
    // alarming `✗ failed`. Out-of-scope detected providers belong in their
    // own visual bucket.
    const providers: UninstallResult["providers"] = {
      claude: { detected: true, uninstalled: false },
      opencode: { detected: false, uninstalled: false },
      codex: { detected: true, uninstalled: false },
      pi: { detected: true, uninstalled: true },
    };
    const output = captureConsole(() => {
      logProviderStatus(providers, new Set(["pi"]));
    });
    expect(output).toMatch(/Pi:.*✓ removed/);
    // Out-of-scope detected providers don't get tagged as failures.
    expect(output).not.toMatch(/Claude.*✗ failed/);
    expect(output).not.toMatch(/Codex.*✗ failed/);
    expect(output).toMatch(/Claude.*skipped/i);
    expect(output).toMatch(/Codex.*skipped/i);
    // Not-installed still reads cleanly regardless of scope.
    expect(output).toMatch(/opencode.*not installed/i);
  });

  test("unscoped uninstall still flags detected-but-not-uninstalled providers as failed", () => {
    // Symmetric guard: when no scope is passed (full uninstall), a
    // provider that was attempted and failed must still surface as
    // ✗ failed — the new "skipped" bucket only applies when scope explicitly
    // excludes the provider.
    const providers: UninstallResult["providers"] = {
      claude: { detected: true, uninstalled: false },
      opencode: { detected: false, uninstalled: false },
      codex: { detected: false, uninstalled: false },
      pi: { detected: false, uninstalled: false },
    };
    const output = captureConsole(() => {
      logProviderStatus(providers, null);
    });
    expect(output).toMatch(/Claude.*✗ failed/);
  });

  test("rejects --<provider> combined with --delete-data instead of silently ignoring", () => {
    // Per-provider scope means "remove Shaka from this provider, leave the
    // rest of the install alone." `--delete-data` is destructive at the
    // whole-install level. Combining them is contradictory; the previous
    // CLI silently force-falsed deleteUserData, which surprised users by
    // ignoring an explicit destructive flag.
    const result = runShaka(["uninstall", "--pi", "--delete-data"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase() + result.stdout.toLowerCase()).toMatch(
      /per-provider|--delete-data/,
    );
  });
});
