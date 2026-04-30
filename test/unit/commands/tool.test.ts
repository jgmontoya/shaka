/**
 * `shaka tool <name>` subcommand — runs a Shaka system or customizations tool
 * with JSON args on stdin, prints the tool's result to stdout. The same
 * subcommand backs the Pi extension and opencode plugin tool bridges, so
 * provider-side code is one subprocess spawn instead of duplicated tool
 * resolution + execution logic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunShaka } from "../../helpers/run-shaka";

const TEST_HOME = join(tmpdir(), `shaka-tool-cli-${process.pid}`);
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const runShaka = makeRunShaka(TEST_HOME);

beforeEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(TEST_HOME, { recursive: true });
  // The system/ symlink is what discoverToolsWithOverrides walks; point it at
  // the repo's defaults/system so the real tools are discoverable. The
  // "junction" hint is ignored on POSIX and produces a Windows junction
  // (the only directory-link type Windows allows without elevation).
  await symlink(join(REPO_ROOT, "defaults", "system"), join(TEST_HOME, "system"), "junction");
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("shaka tool", () => {
  test("exits non-zero with an actionable message when the tool name is unknown", () => {
    const result = runShaka(["tool", "no-such-tool"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("no-such-tool");
  });

  test("exits non-zero with a clean error (no stack trace) when stdin is malformed JSON", () => {
    // The bridge is consumed by the Pi extension and the opencode plugin —
    // both surface stderr to the user. A raw V8 stack trace from an
    // unhandled `JSON.parse` SyntaxError pollutes that surface and obscures
    // the real cause. Mirrors the structured-error contract that
    // `src/mcp/server.ts` already enforces.
    const result = runShaka(["tool", "memory-search"], "{not json");
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(result.stderr).not.toMatch(/SyntaxError/);
    expect(result.stderr.toLowerCase()).toMatch(/json|memory-search/);
  });

  test("exits non-zero with a clean error when stdin is valid JSON but not an object", () => {
    // Tool args are typed as `Record<string, unknown>`. A bare array or
    // primitive would slip past the type cast and reach `tool.execute` with
    // the wrong shape; reject up front with a readable message.
    const result = runShaka(["tool", "memory-search"], "[1, 2, 3]");
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toMatch(/at .*\.(?:js|ts):\d+/);
    expect(result.stderr.toLowerCase()).toMatch(/object|memory-search/);
  });

  test("runs memory-search end-to-end with JSON args on stdin", () => {
    // Empty SHAKA_HOME memory dir → memory-search runs cleanly and produces
    // non-empty stdout. Don't assert exact wording — that's the tool's
    // contract, not the bridge's.
    const result = runShaka(["tool", "memory-search"], JSON.stringify({ query: "anything" }));
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
