/**
 * Provider-agnostic inference tool
 * @version 1.2.0
 *
 * Uses CLI tools that handle their own authentication:
 * 1. Claude CLI (claude -p) — if installed
 * 2. OpenCode CLI (opencode run) — if installed, handles local models too
 *
 * No API keys needed — CLIs manage auth. Install one and inference works.
 */

import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSummarizationModel } from "./domain/config";
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
 *   - Iterate providers in priority order: claude, opencode, codex.
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
  const defaultOrder: ProviderName[] = ["claude", "opencode", "codex"];
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
  const args = ["run", "--pure", "--format", "json", "--agent", "shaka/inference", prompt];
  // opencode expects provider/model format (e.g., "anthropic/claude-haiku-4-5")
  // Skip bare aliases like "haiku" which are Claude CLI-specific
  if (options.model?.includes("/")) args.push("--model", options.model);

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
  // Bun.$.env() REPLACES env (does not merge), so spread process.env first
  // to preserve PATH and other inherited vars.
  const result = await Bun.$`opencode ${args}`
    .env({ ...process.env, SHAKA_OPENCODE_SUBAGENT: "true" })
    .quiet()
    .nothrow();

  const { sessionId, text } = parseOpencodeJsonStream(result.stdout.toString());

  // Fire-and-forget cleanup: `opencode run` persists a session on every
  // invocation (no upstream --ephemeral; issue #4489). We delegate deletion
  // to opencode's own `session delete` subcommand rather than reaching into
  // its sqlite DB — safer against schema drift. --pure skips plugin loading
  // (recursion safety + speed). No await: the ~1.2s subprocess runs off
  // the caller's critical path. If it fails the session becomes an orphan,
  // same outcome as pre-fix.
  if (sessionId) {
    Bun.spawn(["opencode", "--pure", "session", "delete", sessionId], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `OpenCode CLI error: ${result.stderr.toString()}`,
      provider: "opencode-cli",
    };
  }

  return parseResponse(text, options.expectJson, "opencode-cli");
}

/**
 * Call Codex CLI for inference.
 *
 * Uses `codex exec` with:
 * - `--disable codex_hooks` to prevent hook recursion
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
      "codex_hooks",
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

// ---------------------------------------------------------------------------
// Process Management
// ---------------------------------------------------------------------------

function spawnCLI(
  command: string,
  args: string[],
  stdin: string,
  timeout?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    if (timeout) {
      setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGTERM");
          resolve({ code: 1, stdout, stderr: `Timeout after ${timeout}ms` });
        }
      }, timeout);
    }

    proc.stdin.write(stdin);
    proc.stdin.end();
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        resolve({ code: 1, stdout: "", stderr: err.message });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the newline-delimited JSON event stream emitted by
 * `opencode run --format json`. Returns the session ID from the first
 * `step_start` event (for cleanup) and — in future cycles — the
 * concatenated response text. Malformed lines are skipped silently;
 * the parser is best-effort and never throws.
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

function parseResponse(text: string, expectJson?: boolean, provider?: string): InferenceResult {
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
 * 3. Codex CLI — most expensive (gpt-5.4 default), tried last
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
    }
    if (result.success) return result;
  }

  return {
    success: false,
    error: "No inference provider available. Install claude, opencode, or codex CLI.",
  };
}

/**
 * Check if any inference CLI is available.
 */
export async function hasInferenceProvider(
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<boolean> {
  return detected.claude || detected.opencode || detected.codex;
}
