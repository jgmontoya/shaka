/**
 * Provider-agnostic inference tool
 * @version 1.2.0
 *
 * Uses CLI tools that handle their own authentication:
 * 1. Claude CLI (claude -p) — if installed
 * 2. OpenCode CLI (opencode run) — if installed, handles local models too
 * 3. Codex CLI (codex exec) — if installed
 * 4. Pi CLI (pi -p) — if installed
 *
 * No API keys needed — CLIs manage auth. Install one and inference works.
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSummarizationModel } from "./domain/config";
import { DEFAULT_PI_MODEL, piProviderForModel } from "./providers/pi/defaults";
import { detectProviderError } from "./providers/pi/error-detect";
import { getProviderNames } from "./providers/registry";
import type { ProviderName } from "./providers/types";
import { type DetectedProviders, detectInstalledProviders } from "./services/provider-detection";

export interface InferenceOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  /**
   * Optional provider hint for session-context callers (session-end worker,
   * rollups, maintenance, knowledge compilation). When set and the provider
   * is installed, it's dispatched FIRST — other installed providers remain
   * as fallbacks. This matters because the provider that originated a
   * session is the authoritative dispatch target for its own summarization
   * work, regardless of what's first in the installed-priority list.
   * Omit for generic, session-free callers (compile, review, format-reminder).
   */
  provider?: ProviderName;
  timeout?: number;
  expectJson?: boolean;
}

export interface InferenceResult {
  success: boolean;
  text?: string;
  parsed?: unknown;
  error?: string;
  provider?: string;
}

export interface InferenceAttempt {
  readonly provider: ProviderName;
  readonly model: string | undefined;
}

/**
 * Compute the ordered list of (provider, model) attempts for an inference call.
 *
 * Pure function — takes `detected` as an injected parameter so the resolution
 * logic is trivially testable without mocking CLI probing. Model-resolution
 * belongs here (not in callers like format-reminder) because this is the only
 * layer that knows which backend inference() will actually dispatch to —
 * the hook-host provider and the dispatch-winner can differ when multiple
 * CLIs are installed.
 *
 * Semantics:
 *   - Iterate providers in priority order: claude, opencode, codex, pi.
 *   - For each installed provider, emit one attempt.
 *   - If the caller passes an explicit `options.model`, it wins for every
 *     attempt — config is ignored entirely.
 *   - Otherwise, each attempt's model comes from
 *     getSummarizationModel(<provider>), which honors the per-provider
 *     config.json `summarization_model` and maps "auto" to undefined.
 */
export async function resolveInferenceAttempts(
  options: InferenceOptions,
  detected: DetectedProviders,
): Promise<InferenceAttempt[]> {
  const defaultOrder: ProviderName[] = ["claude", "opencode", "codex", "pi"];
  // If the caller hints a provider AND it's installed, it jumps to the head
  // of the list; the default order fills the remaining fallback slots.
  const hint = options.provider;
  const ordered: ProviderName[] =
    hint && detected[hint] ? [hint, ...defaultOrder.filter((p) => p !== hint)] : defaultOrder;

  const attempts: InferenceAttempt[] = [];
  for (const provider of ordered) {
    if (!detected[provider]) continue;
    const model =
      options.model !== undefined ? options.model : await getSummarizationModel(provider);
    attempts.push({ provider, model });
  }
  return attempts;
}

// ---------------------------------------------------------------------------
// CLI-Based Inference
// ---------------------------------------------------------------------------

/**
 * Call Claude CLI for inference.
 *
 * Uses spawn (not Bun.$) because Bun.$ drops empty string arguments.
 * --setting-sources "" disables hooks (prevents recursion).
 * --tools "" disables tool use (pure text inference).
 * --no-session-persistence keeps the hook-triggered classifier out of
 *   ~/.claude/projects/<cwd>/ so it doesn't clutter the session picker.
 *   Only works with --print (which we always pass via -p below).
 * Prompt is piped via stdin to avoid argument length limits.
 */
async function callClaudeCLI(options: InferenceOptions): Promise<InferenceResult> {
  const args = ["--setting-sources", "", "--tools", "", "--no-session-persistence"];
  if (options.model) args.push("--model", options.model);
  if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
  args.push("-p");

  const result = await spawnCLI("claude", args, options.userPrompt, options.timeout);

  if (result.code !== 0) {
    return {
      success: false,
      error: `Claude CLI error: ${result.stderr}`,
      provider: "claude-cli",
    };
  }

  return parseResponse(result.stdout.trim(), options.expectJson, "claude-cli");
}

async function callOpenCodeCLI(options: InferenceOptions): Promise<InferenceResult> {
  const prompt = options.systemPrompt
    ? `${options.systemPrompt}\n\n${options.userPrompt}`
    : options.userPrompt;

  // Use the "shaka/inference" agent which has all tools disabled ("*": "deny")
  // This prevents the LLM from writing files or running commands during inference.
  // The agent is installed by shaka via symlink: ~/.config/opencode/agents/shaka/ → source.
  // NOTE: Requires `shaka init` to have been run. This is intentional — inference is only
  // called from hooks, which already require shaka installation to function.
  //
  // --pure: skip loading external plugins in the child process (including our own
  // opencode plugin). Belt-and-suspenders with SHAKA_OPENCODE_SUBAGENT — the env
  // guard lets the plugin short-circuit, --pure prevents it from loading at all.
  // Also saves ~300ms of plugin-init overhead per classifier call. Requires
  // opencode ≥ 2026-03-27 (PR #19347); errors out on older versions.
  //
  // --format json: emit newline-delimited JSON events on stdout. First event is
  // step_start with the created session's ID (which we use to fire-and-forget a
  // cleanup subprocess after this call returns — see parseOpencodeJsonStream).
  const args = ["run", "--pure", "--format", "json", "--agent", "shaka/inference"];
  // opencode expects provider/model format (e.g., "anthropic/claude-haiku-4-5")
  // Skip bare aliases like "haiku" which are Claude CLI-specific
  if (options.model?.includes("/")) args.push("--model", options.model);
  args.push("--", prompt);

  // Mark this subprocess as a subagent so Shaka's hooks (format-reminder,
  // session-start) short-circuit via isSubagent(). This is load-bearing:
  // the opencode plugin wrapper (src/providers/opencode/configurer.ts)
  // caches the user's prompt via chat.message and passes it as { prompt }
  // to format-reminder inside experimental.chat.system.transform. Without
  // this env guard, format-reminder in the child opencode would receive a
  // valid prompt, call inference() for classification, spawn another
  // opencode run, cascade — exactly the recursion the generated plugin
  // enables. Session-end recursion is separately prevented by the same
  // guard  — opencode's own plugin-teardown-on-session-disposal also stops it,
  // but the env check is the belt; Exp 30 documented the suspenders.
  //
  const proc = Bun.spawn(["opencode", ...args], {
    env: { ...process.env, SHAKA_OPENCODE_SUBAGENT: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await collectOpenCodeProcess(proc, options.timeout);

  const { sessionId, text } = parseOpencodeJsonStream(result.stdout);

  // Fire-and-forget cleanup: `opencode run` persists a session on every
  // invocation (no upstream --ephemeral; issue #4489). We delegate deletion
  // to opencode's own `session delete` subcommand rather than reaching into
  // its sqlite DB — safer against schema drift. --pure skips plugin loading
  // (recursion safety + speed). No await: the ~1.2s subprocess runs off
  // the caller's critical path. If it fails the session becomes an orphan,
  // same outcome as pre-fix.
  if (sessionId) {
    Bun.spawn(["opencode", "--pure", "session", "delete", sessionId], {
      env: { ...process.env, SHAKA_OPENCODE_SUBAGENT: "true" },
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  }

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `OpenCode CLI error: ${result.stderr}`,
      provider: "opencode-cli",
    };
  }

  return parseResponse(text, options.expectJson, "opencode-cli");
}

async function collectOpenCodeProcess(
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">,
  timeout: number | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const stdoutDone = appendStreamText(proc.stdout, (chunk) => {
    stdout += chunk;
  });
  const stderrDone = appendStreamText(proc.stderr, (chunk) => {
    stderr += chunk;
  });
  const completed = Promise.all([stdoutDone, stderrDone, proc.exited]).then(
    ([finalStdout, finalStderr, exitCode]) => ({
      stdout: finalStdout,
      stderr: finalStderr,
      exitCode,
    }),
  );

  if (timeout === undefined) return completed;

  const finished = await Promise.race([completed, delay(timeout).then(() => null)]);
  if (finished !== null) return finished;

  proc.kill("SIGTERM");
  const drained = await Promise.race([completed, delay(100).then(() => null)]);
  if (drained === null) {
    proc.kill("SIGKILL");
  }
  return {
    stdout: drained?.stdout ?? stdout,
    stderr: appendLine(drained?.stderr ?? stderr, `Timeout after ${timeout}ms`),
    exitCode: 1,
  };
}

async function appendStreamText(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      append(chunk);
    }
  } catch {
    // Best effort: callers still get whatever was captured before the stream failed.
  }

  const tail = decoder.decode();
  text += tail;
  append(tail);
  return text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line;
}

/**
 * Call Codex CLI for inference.
 *
 * Uses `codex exec` with:
 * - `--disable hooks` to prevent hook recursion
 * - `--ephemeral` to skip transcript persistence
 * - `-c 'sandbox="read-only"'` for safe text-only inference
 * - `-o <file>` for clean output (no ANSI codes or spinner)
 *
 * Prompt goes as a positional argument (not stdin — differs from callClaudeCLI).
 * Uses spawnCLI (not Bun.$) because Bun.$ drops empty string arguments.
 */
async function callCodexCLI(options: InferenceOptions): Promise<InferenceResult> {
  const tmpOutput = join(tmpdir(), `.shaka-codex-inference-${process.pid}-${Date.now()}.txt`);
  try {
    const args = [
      "exec",
      "--disable",
      "hooks",
      "--ephemeral",
      "--skip-git-repo-check",
      "-c",
      'sandbox="read-only"',
    ];
    if (options.model) args.push("-m", options.model);
    // Codex exec has no --system-prompt flag; prepend to user prompt (same as opencode)
    const prompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.userPrompt}`
      : options.userPrompt;
    args.push("-o", tmpOutput, prompt);

    const result = await spawnCLI("codex", args, "", options.timeout);

    if (result.code !== 0) {
      return {
        success: false,
        error: `Codex CLI error: ${result.stderr}`,
        provider: "codex-cli",
      };
    }

    const outputFile = Bun.file(tmpOutput);
    if (!(await outputFile.exists())) {
      return { success: false, error: "Codex CLI produced no output file", provider: "codex-cli" };
    }
    const text = await outputFile.text();
    return parseResponse(text.trim(), options.expectJson, "codex-cli");
  } finally {
    await unlink(tmpOutput).catch(() => {});
  }
}

/**
 * Call Pi CLI for inference. Pi defaults to Google (Exp 42) and auto-loads
 * skills/prompts/context-files from ambient `~/.agents/` paths regardless of
 * `PI_CODING_AGENT_DIR` (Exp 47, 51), so pure text inference must opt out of
 * every discovery surface explicitly. Pi's default systemPrompt also embeds
 * Pi-self-doc references (Exp 45) — `--system-prompt` fully replaces it
 * rather than appending.
 *
 * Pi exits 0 even when the provider returns 4xx/5xx (Exp 43); the helper
 * scans stdout for the error shape and surfaces it as an inference failure.
 */
async function callPiCLI(options: InferenceOptions): Promise<InferenceResult> {
  // Pi defaults to google (Exp 42) and accepts other backends with explicit
  // `--provider`. The mapping isn't a naive prefix split (Exp 48: openai
  // models are served by Pi's `openai-codex` provider), so route through
  // `piProviderForModel`.
  const model = options.model ?? DEFAULT_PI_MODEL;
  const provider = piProviderForModel(model);
  if (!provider) {
    return {
      success: false,
      error: `Unsupported Pi model namespace: ${model}`,
      provider: "pi-cli",
    };
  }
  // Per-resource isolation set verified empirically (Exp 47 + 51).
  const args = [
    "-p",
    "--no-extensions",
    "--no-tools",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--offline",
    "--provider",
    provider,
    "--model",
    model,
  ];
  args.push("--system-prompt", options.systemPrompt ?? "");

  // SHAKA_PI_SUBAGENT short-circuits the generated extension's handlers as a
  // belt-and-braces guard against recursion if --no-extensions is ever
  // bypassed. PI_TELEMETRY=0 keeps Pi quiet during inference; PI_OFFLINE=1
  // suppresses Pi's startup network probes (model-list refresh, etc.).
  const env = {
    ...process.env,
    SHAKA_PI_SUBAGENT: "true",
    PI_TELEMETRY: "0",
    PI_OFFLINE: "1",
  };

  const result = await spawnCLI("pi", args, options.userPrompt, options.timeout, env);

  if (result.code !== 0) {
    return { success: false, error: `Pi CLI error: ${result.stderr}`, provider: "pi-cli" };
  }

  // Pi can exit 0 with the body of a provider error printed to stdout (Exp 43).
  const providerError = detectProviderError(result.stdout);
  if (providerError) {
    return {
      success: false,
      error: `Pi provider error (${providerError.code}): ${providerError.body}`,
      provider: "pi-cli",
    };
  }

  return parseResponse(result.stdout.trim(), options.expectJson, "pi-cli");
}

// ---------------------------------------------------------------------------
// Process Management
// ---------------------------------------------------------------------------

/**
 * SIGTERM → grace → SIGKILL → close. Mirrors runAgentStep's pattern
 * (src/domain/agent-execution.ts) — a CLI that traps SIGTERM keeps
 * running orphaned otherwise. `unref()` lets the process exit if
 * nothing else is pending; `cancel()` clears both timers when the
 * process completes normally so the event loop isn't held open.
 *
 * Returned `timedOut()` lets the caller distinguish a real exit from
 * a timeout-induced exit when shaping the resolved value.
 */
function armKillChain(
  proc: ReturnType<typeof spawn>,
  timeout: number | undefined,
  isSettled: () => boolean,
): { timedOut: () => boolean; cancel: () => void } {
  let timedOut = false;
  let exited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  proc.on("exit", () => {
    exited = true;
  });
  const hasExited = () => exited || proc.exitCode !== null || proc.signalCode !== null;
  if (timeout) {
    timer = setTimeout(() => {
      if (isSettled() || hasExited()) return;
      timedOut = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!isSettled() && !hasExited()) proc.kill("SIGKILL");
      }, 500);
      killTimer.unref?.();
    }, timeout);
    timer.unref?.();
  }
  return {
    timedOut: () => timedOut,
    cancel: () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    },
  };
}

function spawnCLI(
  command: string,
  args: string[],
  stdin: string,
  timeout?: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const killChain = armKillChain(proc, timeout, () => settled);

    proc.stdin.on("error", () => {
      // Child may exit before consuming stdin; the close/error handlers
      // below still decide the resolved value. Same pattern as
      // src/domain/agent-execution.ts (runAgentStep).
    });
    try {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } catch {
      // Pipe closed between spawn and write — close/error will resolve.
    }
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      killChain.cancel();
      if (killChain.timedOut()) {
        // Preserve any stderr the CLI emitted before the timeout fired —
        // it's the most useful signal for diagnosing slow / wedged calls.
        resolve({
          code: 1,
          stdout,
          stderr: stderr ? `${stderr}\nTimeout after ${timeout}ms` : `Timeout after ${timeout}ms`,
        });
      } else {
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      killChain.cancel();
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the newline-delimited JSON event stream emitted by
 * `opencode run --format json`. Returns the session ID from the first
 * `step_start` event (for cleanup) and the concatenated response text
 * from all `text` events in stream order. Malformed lines are skipped
 * silently; the parser is best-effort and never throws.
 */
export function parseOpencodeJsonStream(stdout: string): {
  sessionId: string | null;
  text: string;
} {
  const lines = stdout.split("\n");
  let sessionId: string | null = null;
  const textParts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (sessionId === null && evt.type === "step_start" && typeof evt.sessionID === "string") {
        sessionId = evt.sessionID;
      }
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        textParts.push(evt.part.text);
      }
    } catch {
      // skip malformed line
    }
  }
  return { sessionId, text: textParts.join("") };
}

export function parseResponse(
  text: string,
  expectJson?: boolean,
  provider?: string,
): InferenceResult {
  if (!expectJson) {
    return { success: true, text, provider };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return { success: true, text, parsed, provider };
    } catch {
      return { success: true, text, provider };
    }
  }

  return { success: true, text, provider };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Run inference using available CLI tools.
 *
 * Priority order (cheapest to most expensive):
 * 1. Claude CLI — cheapest with haiku default
 * 2. OpenCode CLI — local models or anthropic/haiku
 * 3. Codex CLI — gpt-5.4 default
 * 4. Pi CLI — provider comes from piProviderForModel(options.model ?? DEFAULT_PI_MODEL),
 *    tried last
 *
 * All handle their own authentication — no API keys needed.
 *
 * Model resolution: if the caller omits `options.model`, each attempt uses
 * the per-provider `summarization_model` from config (via
 * resolveInferenceAttempts). This keeps callers like format-reminder,
 * compile, and review zero-config — they just call inference() and get
 * the right model for whichever backend wins the dispatch race.
 */
export async function inference(
  options: InferenceOptions,
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<InferenceResult> {
  const attempts = await resolveInferenceAttempts(options, detected);
  let lastFailure: InferenceResult | null = null;

  for (const attempt of attempts) {
    const resolvedOptions = { ...options, model: attempt.model };
    let result: InferenceResult;
    switch (attempt.provider) {
      case "claude":
        result = await callClaudeCLI(resolvedOptions);
        break;
      case "opencode":
        result = await callOpenCodeCLI(resolvedOptions);
        break;
      case "codex":
        result = await callCodexCLI(resolvedOptions);
        break;
      case "pi":
        result = await callPiCLI(resolvedOptions);
        break;
    }
    if (result.success) return result;
    lastFailure = result;
  }

  return (
    lastFailure ?? {
      success: false,
      error: `No inference provider available. Install ${getProviderNames().join(", ")} CLI.`,
    }
  );
}

/**
 * Check if any inference CLI is available.
 */
export async function hasInferenceProvider(
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<boolean> {
  return detected.claude || detected.opencode || detected.codex || detected.pi;
}
