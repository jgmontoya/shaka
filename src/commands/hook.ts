/**
 * `shaka hook <event>` - dispatch a Pi lifecycle event to matching Shaka hooks.
 *
 * The Pi extension sends one JSON object on stdin and consumes this command's
 * stdout, stderr, and exit status. The dispatcher keeps discovery and execution
 * in the CLI so every provider uses the same system/customization override rules.
 */

import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import {
  type DiscoveredHook,
  HOOK_EVENTS,
  type HookEvent,
  discoverAllHooks,
} from "../providers/hook-discovery";

const COMMAND_TIMEOUT_MS = 25_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

export interface HookDispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HookDispatchRequest {
  event: string;
  rawInput: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type HookProcessResult =
  | {
      state: "completed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      state: "output-limit" | "spawn-error" | "timed-out" | "signaled";
      stderr: string;
    };

type HookProcessRunner = (
  hookPath: string,
  rawInput: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<HookProcessResult>;

interface HookDispatchDependencies {
  discoverHooks: (shakaHome: string) => Promise<DiscoveredHook[]>;
  now: () => number;
  runProcess: HookProcessRunner;
  timeoutMs: number;
}

interface HookCommandOptions {
  now?: () => number;
  timeoutMs?: number;
}

type StdinReadResult =
  | {
      state: "completed";
      rawInput: string;
    }
  | {
      state: "failed";
      message: string;
    };

interface BufferedStream {
  done: Promise<void>;
  limitExceeded: Promise<HookProcessResult>;
  cancel: () => Promise<void>;
  text: () => string;
}

interface CapturedOutput {
  chunks: string[];
  bytes: number;
  separator: string;
  stream: "stdout" | "stderr";
}

const UTF8_ENCODER = new TextEncoder();

function appendCapturedOutput(capture: CapturedOutput, output: string): string | undefined {
  if (!output) return;
  const separator = capture.chunks.length === 0 ? "" : capture.separator;
  const additionalBytes = UTF8_ENCODER.encode(separator + output).byteLength;
  if (capture.bytes + additionalBytes > MAX_CAPTURE_BYTES) {
    return `Combined hook ${capture.stream} exceeded ${MAX_CAPTURE_BYTES}-byte capture limit`;
  }
  capture.chunks.push(output);
  capture.bytes += additionalBytes;
}

async function readCommandStdin(timeoutMs: number): Promise<StdinReadResult> {
  let stream: ReturnType<typeof Bun.stdin.stream>;
  try {
    stream = Bun.stdin.stream();
  } catch (error) {
    return {
      state: "failed",
      message: `failed to read stdin: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const reader = stream.getReader();

  const decoder = new TextDecoder();
  const read = (async () => {
    let rawInput = "";
    while (true) {
      const next = await reader.read();
      if (next.done) return rawInput + decoder.decode();
      rawInput += decoder.decode(next.value, { stream: true });
    }
  })();
  const completed = read.then(
    (rawInput): StdinReadResult => ({ state: "completed", rawInput }),
    (error): StdinReadResult => ({
      state: "failed",
      message: `failed to read stdin: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });

  try {
    const result = await Promise.race([completed, timedOut]);
    if (result !== "timed-out") return result;

    await reader.cancel();
    await Promise.allSettled([read]);
    return {
      state: "failed",
      message: "command deadline expired while reading stdin",
    };
  } catch (error) {
    return {
      state: "failed",
      message: `failed to read stdin: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bufferStream(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
): BufferedStream {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let settled = false;
  let cancelPromise: Promise<void> | undefined;
  let resolveLimit: (result: HookProcessResult) => void = () => {};
  const limitExceeded = new Promise<HookProcessResult>((resolve) => {
    resolveLimit = resolve;
  });
  const cancel = async () => {
    if (settled) return;
    cancelPromise ??= reader.cancel().catch(() => {});
    await cancelPromise;
  };

  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytesRead += next.value.byteLength;
        if (bytesRead > MAX_CAPTURE_BYTES) {
          resolveLimit({
            state: "output-limit",
            stderr: `Hook ${name} exceeded ${MAX_CAPTURE_BYTES}-byte capture limit`,
          });
          await cancel();
          break;
        }
        chunks.push(decoder.decode(next.value, { stream: true }));
      }
    } catch {
      // Cancellation is the expected timeout cleanup path.
    } finally {
      chunks.push(decoder.decode());
      settled = true;
    }
  })();

  return {
    done,
    limitExceeded,
    cancel,
    text: () => chunks.join(""),
  };
}

async function runHookProcess(
  hookPath: string,
  rawInput: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<HookProcessResult> {
  const spawn = () =>
    Bun.spawn(["bun", hookPath], {
      cwd: options.cwd,
      env: options.env,
      stdin: new Blob([rawInput]),
      stdout: "pipe",
      stderr: "pipe",
    });

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn();
  } catch (error) {
    return {
      state: "spawn-error",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  const stdout = bufferStream(child.stdout, "stdout");
  const stderr = bufferStream(child.stderr, "stderr");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), options.timeoutMs);
    timer.unref?.();
  });
  const completed = Promise.all([child.exited, stdout.done, stderr.done]).then(
    () => "completed" as const,
  );
  const stopAndSettle = async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled([child.exited, stdout.cancel(), stderr.cancel()]);
    await Promise.allSettled([stdout.done, stderr.done]);
  };

  try {
    const state = await Promise.race([
      completed,
      timedOut,
      stdout.limitExceeded,
      stderr.limitExceeded,
    ]);
    if (state === "timed-out") {
      await stopAndSettle();
      return {
        state: "timed-out",
        stderr: `Hook timed out after ${options.timeoutMs}ms`,
      };
    }
    if (typeof state !== "string") {
      await stopAndSettle();
      return state;
    }

    if (child.signalCode !== null) {
      return {
        state: "signaled",
        stderr: `Hook terminated by signal ${child.signalCode}`,
      };
    }

    return {
      state: "completed",
      exitCode: child.exitCode ?? 1,
      stdout: stdout.text(),
      stderr: stderr.text(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.includes(value as HookEvent);
}

function validateCommonPayload(record: Record<string, unknown>): void {
  if (typeof record.session_id !== "string" || !record.session_id.trim()) {
    throw new Error("session_id must be a non-empty string");
  }
  if (record.provider !== "pi") {
    throw new Error('provider must equal "pi"');
  }
}

function validatePromptPayload(record: Record<string, unknown>): void {
  if (typeof record.prompt !== "string") {
    throw new Error("prompt must be a string");
  }
}

function validateToolPayload(record: Record<string, unknown>): void {
  if (typeof record.tool_name !== "string" || !record.tool_name.trim()) {
    throw new Error("tool_name must be a non-empty string");
  }
  const inputIsObject =
    typeof record.tool_input === "object" &&
    record.tool_input !== null &&
    !Array.isArray(record.tool_input);
  if (typeof record.tool_input !== "string" && !inputIsObject) {
    throw new Error("tool_input must be a string or object");
  }
}

function validateToolAfterPayload(record: Record<string, unknown>): void {
  validateToolPayload(record);
  if (!Object.hasOwn(record, "tool_response")) {
    throw new Error("tool_response is required");
  }
  if (Object.hasOwn(record, "is_error") && typeof record.is_error !== "boolean") {
    throw new Error("is_error must be a boolean");
  }
}

function validateSessionEndPayload(record: Record<string, unknown>): void {
  if (typeof record.transcript_path !== "string" && record.transcript_path !== null) {
    throw new Error("transcript_path must be a string or null");
  }
}

const EVENT_PAYLOAD_VALIDATORS: Record<HookEvent, (record: Record<string, unknown>) => void> = {
  "session.start": () => {},
  "prompt.submit": validatePromptPayload,
  "tool.before": validateToolPayload,
  "tool.after": validateToolAfterPayload,
  "session.end": validateSessionEndPayload,
};

function parsePiPayload(event: HookEvent, rawInput: string): Record<string, unknown> {
  if (!rawInput.trim()) throw new Error("stdin must contain a JSON object");

  const payload: unknown = JSON.parse(rawInput);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("stdin must decode to a JSON object");
  }

  const record = payload as Record<string, unknown>;
  validateCommonPayload(record);
  EVENT_PAYLOAD_VALIDATORS[event](record);
  return record;
}

function hookMatchesPayload(
  hook: DiscoveredHook,
  event: HookEvent,
  payload: Record<string, unknown>,
): boolean {
  if (event !== "tool.before" && event !== "tool.after") return true;
  if (!hook.matchers || hook.matchers.length === 0) return true;
  return hook.matchers.includes(payload.tool_name as string);
}

function compareHooks(left: DiscoveredHook, right: DiscoveredHook): number {
  if (left.filename < right.filename) return -1;
  if (left.filename > right.filename) return 1;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function formatFailure(event: string, message: string): HookDispatchResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `shaka hook ${event}: ${message}`,
  };
}

async function executeHooks(
  event: HookEvent,
  request: HookDispatchRequest,
  hooks: DiscoveredHook[],
  dependencies: HookDispatchDependencies,
  deadline: number,
): Promise<HookDispatchResult> {
  const stdout: CapturedOutput = {
    chunks: [],
    bytes: 0,
    separator: "\n\n",
    stream: "stdout",
  };
  const stderr: CapturedOutput = {
    chunks: [],
    bytes: 0,
    separator: "",
    stream: "stderr",
  };
  let exitCode = 0;

  for (const hook of hooks) {
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) {
      return formatFailure(event, "command deadline expired before hook execution");
    }
    const result = await dependencies.runProcess(hook.path, request.rawInput, {
      cwd: request.cwd,
      env: request.env,
      timeoutMs: remainingMs,
    });
    if (result.state !== "completed") {
      return formatFailure(event, result.stderr);
    }

    const output = result.stdout.trim();
    const outputError = appendCapturedOutput(stdout, output);
    if (outputError) return formatFailure(event, outputError);
    const errorOutputError = appendCapturedOutput(stderr, result.stderr);
    if (errorOutputError) return formatFailure(event, errorOutputError);
    if (result.exitCode === 2) {
      return {
        exitCode: 2,
        stdout: stdout.chunks.join(stdout.separator),
        stderr: stderr.chunks.join(stderr.separator),
      };
    }
    if (result.exitCode !== 0) exitCode = 1;
  }

  return {
    exitCode,
    stdout: stdout.chunks.join(stdout.separator),
    stderr: stderr.chunks.join(stderr.separator),
  };
}

export async function dispatchHook(
  request: HookDispatchRequest,
  overrides: Partial<HookDispatchDependencies> = {},
): Promise<HookDispatchResult> {
  const dependencies: HookDispatchDependencies = {
    discoverHooks: discoverAllHooks,
    now: () => performance.now(),
    runProcess: runHookProcess,
    timeoutMs: COMMAND_TIMEOUT_MS,
    ...overrides,
  };
  const deadline = dependencies.now() + dependencies.timeoutMs;

  try {
    if (!isHookEvent(request.event)) {
      return formatFailure(request.event, `unknown event "${request.event}"`);
    }
    const payload = parsePiPayload(request.event, request.rawInput);

    const shakaHome = resolveShakaHome({
      SHAKA_HOME: request.env.SHAKA_HOME,
      XDG_CONFIG_HOME: request.env.XDG_CONFIG_HOME,
      HOME: request.env.HOME,
      USERPROFILE: request.env.USERPROFILE,
    });
    const hooks = await dependencies.discoverHooks(shakaHome);
    if (dependencies.now() >= deadline) {
      return formatFailure(request.event, "command deadline expired during hook discovery");
    }

    const selected = hooks
      .filter(
        (hook) => hook.event === request.event && hookMatchesPayload(hook, request.event, payload),
      )
      .sort(compareHooks);
    return executeHooks(request.event, request, selected, dependencies, deadline);
  } catch (error) {
    return formatFailure(request.event, error instanceof Error ? error.message : String(error));
  }
}

export function createHookCommand(options: HookCommandOptions = {}): Command {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("hook command timeoutMs must be a positive finite number");
  }
  const now = options.now ?? (() => performance.now());

  return new Command("hook")
    .description("Run Shaka hooks for a Pi lifecycle event")
    .argument("<event>", "Hook event")
    .action(async (event: string) => {
      const deadline = now() + timeoutMs;
      const stdin = await readCommandStdin(timeoutMs);
      const remainingMs = deadline - now();
      let result: HookDispatchResult;
      if (stdin.state === "failed") {
        result = formatFailure(event, stdin.message);
      } else if (remainingMs <= 0) {
        result = formatFailure(event, "command deadline expired while reading stdin");
      } else {
        result = await dispatchHook(
          {
            event,
            rawInput: stdin.rawInput,
            cwd: process.cwd(),
            env: process.env,
          },
          { timeoutMs: remainingMs },
        );
      }
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
