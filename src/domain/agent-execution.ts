/**
 * Provider-agnostic agent execution for workflow steps.
 *
 * Unlike inference.ts which disables tools and hooks (pure text inference),
 * this module runs the AI CLI with tools enabled and hooks active —
 * the agent can read/write files, run commands, etc.
 *
 * Claude: prompt piped via stdin to avoid ARG_MAX limits.
 * opencode: prompt passed as positional argument (stdin not supported for `run`).
 */

import { spawn } from "node:child_process";
import { type DetectedProviders, detectInstalledProviders } from "../services/provider-detection";

export interface AgentExecutionOptions {
  readonly prompt: string;
  readonly timeout?: number;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run an agent step using the first available provider CLI.
 *
 * `detected` is injectable so tests can pass a fake provider set without
 * monkey-patching `Bun.which`. Production callers omit it and get live
 * detection via `detectInstalledProviders()`.
 */
export async function runAgentStep(
  options: AgentExecutionOptions,
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<AgentExecutionResult> {
  const providers = detected;

  if (providers.claude) {
    return runClaude(options.prompt, options.timeout);
  }

  if (providers.opencode) {
    return runOpencode(options.prompt, options.timeout);
  }

  if (providers.codex) {
    return runCodex(options.prompt, options.timeout);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: "No agent provider available. Install claude, opencode, or codex CLI.",
  };
}

/** Run via Claude CLI — prompt piped via stdin after -p flag. */
function runClaude(prompt: string, timeout?: number): Promise<AgentExecutionResult> {
  return spawnWithStdin("claude", ["-p"], prompt, timeout);
}

/** Run via opencode CLI — prompt passed as positional argument. */
function runOpencode(prompt: string, timeout?: number): Promise<AgentExecutionResult> {
  return spawnWithStdin("opencode", ["run", "--agent", "coder", prompt], "", timeout);
}

/** Run via Codex CLI — --full-auto enables autonomous tool use for workflow steps. */
function runCodex(prompt: string, timeout?: number): Promise<AgentExecutionResult> {
  return spawnWithStdin("codex", ["exec", "--full-auto", prompt], "", timeout);
}

/** Spawn a CLI process, optionally piping stdin. */
function spawnWithStdin(
  command: string,
  args: string[],
  stdin: string,
  timeout?: number,
): Promise<AgentExecutionResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = timeout
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            proc.kill("SIGTERM");
            resolve({ exitCode: 1, stdout, stderr: `Timeout after ${timeout}ms` });
          }
        }, timeout)
      : undefined;

    if (stdin) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ exitCode: 1, stdout: "", stderr: err.message });
      }
    });
  });
}
