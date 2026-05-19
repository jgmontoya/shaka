/**
 * Integration test for the generated Pi extension at `defaults/pi/extension.ts`.
 *
 * Loads the extension via Bun's import (the production destination uses jiti,
 * which transparently handles TypeScript the same way), captures the registered
 * handlers via a stub `pi` API, and exercises them against a stub `shaka` binary
 * on a private SHAKA_BIN path. Verifies the load-bearing contract:
 *
 *   - `tool_call` → returns `{ block: true, reason }` when the spawned hook
 *     exits with code 2 (Exp 49 verified live).
 *   - `tool_call` → no return when the hook exits 0 (allow path).
 *   - Every handler short-circuits when `SHAKA_PI_SUBAGENT=true` is set —
 *     the recursion guard for Shaka-spawned Pi inference and subagent runs.
 *
 * The stub `shaka` is a real shell script on disk so we test the actual
 * spawn/stdin/exit-code wiring, not a substituted abstraction.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(
  tmpdir(),
  `shaka-pi-extension-load-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const BIN_DIR = join(ROOT, "bin");
const SHAKA_BIN = join(BIN_DIR, "shaka");
const STDIN_LOG = join(ROOT, "stdin.log");
const ARGV_LOG = join(ROOT, "argv.log");
let importCounter = 0;
let eventsLogCounter = 0;

const savedEnv = { ...process.env };

interface CapturedHandlers {
  before_agent_start?: (event: unknown, ctx: unknown) => Promise<unknown>;
  tool_call?: (event: unknown, ctx: unknown) => Promise<unknown>;
  tool_result?: (event: unknown, ctx: unknown) => Promise<unknown>;
  agent_end?: (event: unknown, ctx: unknown) => unknown;
  session_shutdown?: (event: unknown, ctx: unknown) => unknown;
}

interface RegisteredTool {
  name?: string;
  description?: string;
  parameters?: unknown;
  execute?: (toolCallId: unknown, args: Record<string, unknown>) => Promise<unknown>;
}

interface LoadedExtension {
  handlers: CapturedHandlers;
  tools: RegisteredTool[];
}

interface PiExtensionModule {
  default: (pi: unknown) => void;
  resolveExtensionShakaHome: (env: {
    SHAKA_HOME?: string;
    XDG_CONFIG_HOME?: string;
    HOME?: string;
    USERPROFILE?: string;
  }) => string;
}

async function importExtension(): Promise<PiExtensionModule> {
  // Cache-bust so the next test sees a fresh module instance (handlers are
  // captured per-load so the module-level `sessionStartFired` Set + timer Map
  // don't leak state across tests).
  const cacheBust = `${Date.now()}-${++importCounter}`;
  const url = new URL(`../../../../defaults/pi/extension.ts?t=${cacheBust}`, import.meta.url);
  return (await import(url.href)) as PiExtensionModule;
}

async function loadExtension(): Promise<LoadedExtension> {
  const handlers: CapturedHandlers = {};
  const tools: RegisteredTool[] = [];
  const stubPi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers as Record<string, unknown>)[name] = handler;
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  const mod = await importExtension();
  mod.default(stubPi);
  return { handlers, tools };
}

async function writeStubShaka(exitCode: number, stderr = "blocked: dangerous"): Promise<void> {
  await Bun.write(
    SHAKA_BIN,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > ${shellEscape(ARGV_LOG)}`,
      `cat > ${shellEscape(STDIN_LOG)}`,
      `printf '%s' ${shellEscape(stderr)} >&2`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  await chmod(SHAKA_BIN, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nextEventsLog(): string {
  eventsLogCounter += 1;
  return join(ROOT, `events-${eventsLogCounter}.log`);
}

function hookEventCount(text: string, eventName: string): number {
  const escaped = eventName.replaceAll(".", "\\.");
  return (text.match(new RegExp(`hook ${escaped}`, "g")) ?? []).length;
}

async function readEventLogWhen(
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs = 750,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let last = "";
  while (performance.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) {
      last = await file.text();
      if (predicate(last)) return last;
    }
    await Bun.sleep(10);
  }
  throw new Error(`event log ${path} did not reach expected state within ${timeoutMs}ms: ${last}`);
}

beforeAll(async () => {
  await mkdir(BIN_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  // Stub-shaka logs are append-only under the shared ROOT. Without a per-test
  // wipe, an assertion like "the bridge fired" can pass on a regression
  // because a previous test's log content satisfies the substring check.
  await rm(STDIN_LOG, { force: true });
  await rm(ARGV_LOG, { force: true });
  process.env.SHAKA_BIN = SHAKA_BIN;
  delete process.env.SHAKA_PI_SUBAGENT;
});

afterEach(() => {
  // Restore env after each test so we don't leak SHAKA_BIN / SHAKA_PI_SUBAGENT
  // into other test suites running in the same process.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.skipIf(process.platform === "win32")("Pi extension — generated extension contract", () => {
  test("default Shaka home follows USERPROFILE when HOME is absent", async () => {
    const mod = await importExtension();
    const userProfile = join(ROOT, "windows-profile");

    expect(mod.resolveExtensionShakaHome({ USERPROFILE: userProfile })).toBe(
      join(userProfile, ".config", "shaka"),
    );
  });

  test("tool_call returns { block: true, reason } when shaka hook exits 2", async () => {
    await writeStubShaka(2, "dangerous bash blocked by policy");
    const { handlers } = await loadExtension();

    const result = await handlers.tool_call?.(
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /" } },
      { sessionManager: { id: "sess-1" } },
    );

    expect(result).toEqual({ block: true, reason: "dangerous bash blocked by policy" });
  });

  test("tool_call passes through silently when shaka hook exits 0", async () => {
    await writeStubShaka(0, "");
    const { handlers } = await loadExtension();

    const result = await handlers.tool_call?.(
      { type: "tool_call", toolName: "read", toolCallId: "c1", input: { path: "/etc/hosts" } },
      { sessionManager: { id: "sess-1" } },
    );

    expect(result).toBeUndefined();
  });

  test("every guarded handler early-returns when SHAKA_PI_SUBAGENT=true", async () => {
    await writeStubShaka(2, "would block but should not be called");
    process.env.SHAKA_PI_SUBAGENT = "true";
    const { handlers } = await loadExtension();

    const toolCall = await handlers.tool_call?.(
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "ls" } },
      { sessionManager: { id: "sess-1" } },
    );
    const beforeAgent = await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "hi", systemPrompt: "" },
      { sessionManager: { id: "sess-1" } },
    );
    const toolResult = await handlers.tool_result?.(
      { type: "tool_result", toolName: "bash", toolCallId: "c1", input: {}, content: [] },
      { sessionManager: { id: "sess-1" } },
    );

    expect(toolCall).toBeUndefined();
    expect(beforeAgent).toBeUndefined();
    expect(toolResult).toBeUndefined();
    expect(await Bun.file(ARGV_LOG).exists()).toBe(false);
    expect(await Bun.file(STDIN_LOG).exists()).toBe(false);
  });

  test("registers Shaka tools (memory-search, inference) so the model can call them", async () => {
    await writeStubShaka(0, "");
    const { tools } = await loadExtension();

    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("memory-search");
    expect(names).toContain("inference");
  });

  test("registered tool execute() shells to `shaka tool <name>` and returns its stdout", async () => {
    // Stub `shaka` echoes its argv prefix + the JSON it received on stdin.
    // The extension is expected to spawn `shaka tool <name>` with the args
    // JSON piped to stdin and surface stdout as the tool's result.
    await Bun.write(
      SHAKA_BIN,
      [
        "#!/bin/sh",
        'if [ "$1" = "tool" ]; then',
        '  TOOL_NAME="$2"',
        "  ARGS=$(cat)",
        '  printf \'{"tool":"%s","args":%s}\' "$TOOL_NAME" "$ARGS"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { tools } = await loadExtension();
    const memorySearch = tools.find((t) => t.name === "memory-search");
    expect(memorySearch).toBeDefined();

    // Pi expects `{ content: [{ type: "text", text }] }` — a plain string
    // crashes Pi's tool-result renderer (it calls `.filter()` on `content`).
    // Verified empirically in Exp 52.
    const result = (await memorySearch?.execute?.("call-1", { query: "anything" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('"tool":"memory-search"');
    expect(result.content[0]?.text).toContain('"query":"anything"');
  });

  test("registered tool execute() decodes multibyte UTF-8 split across stdout chunks", async () => {
    await Bun.write(
      SHAKA_BIN,
      [
        "#!/usr/bin/env bun",
        "await Bun.stdin.text();",
        'if (process.argv[2] === "tool") {',
        "  process.stdout.write(new Uint8Array([0xe2]));",
        "  await Bun.sleep(20);",
        "  process.stdout.write(new Uint8Array([0x82, 0xac]));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { tools } = await loadExtension();
    const memorySearch = tools.find((t) => t.name === "memory-search");
    expect(memorySearch).toBeDefined();

    const result = (await memorySearch?.execute?.("call-1", { query: "anything" })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0]?.text).toBe("€");
  });

  test("registered tool execute() reads SHAKA_HOME at call time", async () => {
    const envLog = join(ROOT, "shaka-home.log");
    await rm(envLog, { force: true });
    await Bun.write(
      SHAKA_BIN,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$SHAKA_HOME" >> ${shellEscape(envLog)}`,
        "printf 'ok'",
        "exit 0",
        "",
      ].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const firstHome = join(ROOT, "home-one");
    const secondHome = join(ROOT, "home-two");
    process.env.SHAKA_HOME = firstHome;
    const { tools } = await loadExtension();
    const memorySearch = tools.find((t) => t.name === "memory-search");
    expect(memorySearch).toBeDefined();

    await memorySearch?.execute?.("call-1", { query: "first" });
    process.env.SHAKA_HOME = secondHome;
    await memorySearch?.execute?.("call-2", { query: "second" });

    expect((await Bun.file(envLog).text()).trim().split("\n")).toEqual([firstHome, secondHome]);
  });

  test("tool_call hook receives normalized tool name (Bash, not bash)", async () => {
    await writeStubShaka(0, "");
    const { handlers } = await loadExtension();

    await handlers.tool_call?.(
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "ls" } },
      { sessionManager: { id: "sess-1" } },
    );

    const stdin = await Bun.file(STDIN_LOG).text();
    expect(stdin).toContain('"tool_name":"Bash"');
    expect(stdin).toContain('"provider":"pi"');
  });

  test("two sessions both without an id each fire session.start (sessionStartFired doesn't suppress the second)", async () => {
    // sessionId() falls back to "unknown" when Pi doesn't provide an id.
    // Without releasing that key (or skipping the fallback entirely), the
    // first id-less session permanently registers "unknown" in the set
    // and every later id-less session in the same Pi host skips
    // session.start. Pin the contract.
    const eventsLog = nextEventsLog();
    await Bun.write(
      SHAKA_BIN,
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellEscape(eventsLog)}`, "exit 0", ""].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { handlers } = await loadExtension();
    const ctxNoId = { sessionManager: {} }; // no .id

    // First id-less session.
    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "p1", systemPrompt: "" },
      ctxNoId,
    );
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctxNoId);

    // Second id-less session — must re-fire session.start.
    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "p2", systemPrompt: "" },
      ctxNoId,
    );

    const events = await readEventLogWhen(
      eventsLog,
      (text) => hookEventCount(text, "session.start") >= 2,
    );
    const sessionStartCount = hookEventCount(events, "session.start");
    expect(sessionStartCount).toBe(2);
  });

  test("session.start retries on the next turn when the first attempt hits the internal-failure path", async () => {
    // runHook returns { exitCode: 2, stderr: "..." } when spawnSync can't
    // launch the shaka binary (the fail-closed path added in round-3).
    // The session.start fire is recorded BEFORE we know whether the hook
    // actually ran, so once the binary becomes reachable on a later turn
    // we never retry. Pin the contract: a failed session.start must NOT
    // prevent later turns from re-attempting it.
    const sid = "sess-retry";
    const ctx = { sessionManager: { id: sid } };
    process.env.SHAKA_BIN = join(ROOT, "definitely-not-a-binary");
    const { handlers } = await loadExtension();

    // First turn — shaka binary missing, session.start hook fails closed.
    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "first turn", systemPrompt: "" },
      ctx,
    );

    // Second turn — install an appending stub so we can count which
    // events actually shelled out (the default stub overwrites per call).
    const eventsLog = nextEventsLog();
    await Bun.write(
      SHAKA_BIN,
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellEscape(eventsLog)}`, "exit 0", ""].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);
    process.env.SHAKA_BIN = SHAKA_BIN;
    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "second turn", systemPrompt: "" },
      ctx,
    );

    const events = await readEventLogWhen(
      eventsLog,
      (text) => text.includes("hook session.start") && text.includes("hook prompt.submit"),
    );
    expect(events).toContain("hook session.start");
    expect(events).toContain("hook prompt.submit");
  });

  test("session.end fires once when idle end is followed by session shutdown", async () => {
    const eventsLog = nextEventsLog();
    await Bun.write(
      SHAKA_BIN,
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellEscape(eventsLog)}`, "exit 0", ""].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { handlers } = await loadExtension();
    const ctx = { sessionManager: { id: "sess-end-once", path: "/tmp/transcript.jsonl" } };

    handlers.agent_end?.({ type: "agent_end" }, ctx);
    await Bun.sleep(3_200);
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctx);
    await Bun.sleep(100);

    const events = await readEventLogWhen(
      eventsLog,
      (text) => hookEventCount(text, "session.end") >= 1,
    );
    const sessionEndCount = hookEventCount(events, "session.end");
    expect(sessionEndCount).toBe(1);
  });

  test("two id-less session shutdowns each fire session.end", async () => {
    const eventsLog = nextEventsLog();
    await Bun.write(
      SHAKA_BIN,
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellEscape(eventsLog)}`, "exit 0", ""].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { handlers } = await loadExtension();
    const ctxNoId = { sessionManager: { path: "/tmp/transcript.jsonl" } };

    handlers.session_shutdown?.({ type: "session_shutdown" }, ctxNoId);
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctxNoId);
    await Bun.sleep(100);

    const events = await readEventLogWhen(
      eventsLog,
      (text) => hookEventCount(text, "session.end") >= 2,
    );
    const sessionEndCount = hookEventCount(events, "session.end");
    expect(sessionEndCount).toBe(2);
  });

  test("new turn cancels a pending idle session.end timer", async () => {
    const eventsLog = nextEventsLog();
    await Bun.write(
      SHAKA_BIN,
      ["#!/bin/sh", `printf '%s\\n' "$*" >> ${shellEscape(eventsLog)}`, "exit 0", ""].join("\n"),
    );
    await chmod(SHAKA_BIN, 0o755);

    const { handlers } = await loadExtension();
    const ctx = { sessionManager: { id: "sess-continued", path: "/tmp/transcript.jsonl" } };

    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "first", systemPrompt: "" },
      ctx,
    );
    handlers.agent_end?.({ type: "agent_end" }, ctx);
    await handlers.before_agent_start?.(
      { type: "before_agent_start", prompt: "second", systemPrompt: "" },
      ctx,
    );
    await Bun.sleep(3_200);
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctx);
    await Bun.sleep(100);

    const events = await readEventLogWhen(
      eventsLog,
      (text) => hookEventCount(text, "session.end") >= 1,
    );
    const sessionEndCount = hookEventCount(events, "session.end");
    expect(sessionEndCount).toBe(1);
  });

  test("tool_call fails CLOSED when shaka binary can't be spawned", async () => {
    // The `tool.before` hook is the only safety layer for Pi's built-in
    // tools. If `spawnSync(shakaBin(), ...)` fails to launch (missing binary,
    // permission, signal-killed, timeout), runHook MUST surface that as a
    // block, not as "exit 1 → allow." Otherwise a misconfigured SHAKA_BIN
    // silently disables the gate.
    process.env.SHAKA_BIN = join(ROOT, "definitely-not-a-binary");
    const { handlers } = await loadExtension();

    const result = await handlers.tool_call?.(
      { type: "tool_call", toolName: "bash", toolCallId: "c1", input: { command: "rm -rf /" } },
      { sessionManager: { id: "sess-1" } },
    );

    expect(result).toMatchObject({ block: true });
  });
});
