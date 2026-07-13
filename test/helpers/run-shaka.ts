/**
 * Shared `runShaka` factory for CLI-level tests.
 *
 * Spawns `bun src/index.ts <args...>` with a scoped `SHAKA_HOME` and
 * `NO_COLOR=1`, captures stdout/stderr/exit-code, and bounds the wait
 * with a timeout so a hung subprocess can't freeze the entire suite
 * (Bun's `node:child_process.spawnSync` has no default timeout).
 *
 * Use this for any test that exercises the CLI surface as a black box
 * — both `tool.test.ts` and `uninstall-cli.test.ts` go through here so
 * the spawn contract has a single point of change.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO_ROOT, "src", "index.ts");

export interface RunShakaResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function makeRunShaka(testHome: string) {
  return function runShaka(args: string[], stdin = ""): RunShakaResult {
    const testUserHome = join(testHome, ".user-home");
    const result = spawnSync("bun", [ENTRY, ...args], {
      input: stdin,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: testUserHome,
        USERPROFILE: testUserHome,
        XDG_CONFIG_HOME: join(testUserHome, ".config"),
        CLAUDE_CONFIG_DIR: join(testUserHome, ".claude"),
        CODEX_HOME: join(testUserHome, ".codex"),
        PI_CODING_AGENT_DIR: join(testUserHome, ".pi", "agent"),
        SHAKA_HOME: testHome,
        NO_COLOR: "1",
      },
      timeout: 30_000,
    });
    // Surface transport failures (timeouts, ENOENT, signal kills) to the
    // suite — masking them as `status: 1` makes a hung subprocess look
    // like a normal CLI failure and steals minutes of debugging.
    if (result.error) throw result.error;
    if (result.status === null) {
      throw new Error(`shaka subprocess terminated by signal: ${result.signal ?? "unknown"}`);
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status,
    };
  };
}
