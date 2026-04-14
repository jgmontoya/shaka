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
import { detectInstalledProviders } from "./services/provider-detection";

export interface InferenceOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
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

// ---------------------------------------------------------------------------
// CLI-Based Inference
// ---------------------------------------------------------------------------

/**
 * Call Claude CLI for inference.
 *
 * Uses spawn (not Bun.$) because Bun.$ drops empty string arguments.
 * --setting-sources "" disables hooks (prevents recursion).
 * --tools "" disables tool use (pure text inference).
 * Prompt is piped via stdin to avoid argument length limits.
 */
async function callClaudeCLI(options: InferenceOptions): Promise<InferenceResult> {
  const args = ["--setting-sources", "", "--tools", ""];
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
  const args = ["run", "--agent", "shaka/inference", prompt];
  // opencode expects provider/model format (e.g., "anthropic/claude-haiku-4-5")
  // Skip bare aliases like "haiku" which are Claude CLI-specific
  if (options.model?.includes("/")) args.push("--model", options.model);
  const result = await Bun.$`opencode ${args}`.quiet().nothrow();

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: `OpenCode CLI error: ${result.stderr.toString()}`,
      provider: "opencode-cli",
    };
  }

  const text = result.stdout.toString().trim();
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
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  const providers = await detectInstalledProviders();

  if (providers.claude) {
    const result = await callClaudeCLI(options);
    if (result.success) return result;
  }

  if (providers.opencode) {
    const result = await callOpenCodeCLI(options);
    if (result.success) return result;
  }

  // Codex last — gpt-5.4 default is expensive for summarization tasks
  if (providers.codex) {
    const result = await callCodexCLI(options);
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
export async function hasInferenceProvider(): Promise<boolean> {
  const providers = await detectInstalledProviders();
  return providers.claude || providers.opencode || providers.codex;
}
