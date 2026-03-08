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
import { detectInstalledProviders } from "../services/provider-detection";

export interface AgentExecutionOptions {
  readonly prompt: string;
  readonly cwd?: string;
  readonly continueSession?: boolean;
  readonly timeout?: number;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentInvocation {
  readonly command: string;
  readonly args: string[];
  readonly stdin: string;
  readonly cwd?: string;
}

/** Run an agent step using the first available provider CLI. */
export async function runAgentStep(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const providers = detectInstalledProviders();

  if (providers.claude) {
    return runClaude(options);
  }

  if (providers.opencode) {
    return runOpencode(options);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: "No agent provider available. Install claude or opencode CLI.",
  };
}

export function buildAgentInvocation(
  provider: "claude" | "opencode",
  options: AgentExecutionOptions,
): AgentInvocation {
  if (provider === "claude") {
    const args = ["-p"];
    if (options.continueSession) {
      args.push("--continue");
    }
    return {
      command: "claude",
      args,
      stdin: options.prompt,
      cwd: options.cwd,
    };
  }

  const args = ["run", "--agent", "coder"];
  if (options.continueSession) {
    args.push("--continue");
  }
  args.push(options.prompt);

  return {
    command: "opencode",
    args,
    stdin: "",
    cwd: options.cwd,
  };
}

/** Run via Claude CLI — prompt piped via stdin after -p flag. */
function runClaude(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const invocation = buildAgentInvocation("claude", options);
  return spawnWithStdin(
    invocation.command,
    invocation.args,
    invocation.stdin,
    invocation.cwd,
    options.timeout,
  );
}

/** Run via opencode CLI — prompt passed as positional argument. */
function runOpencode(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const invocation = buildAgentInvocation("opencode", options);
  return spawnWithStdin(
    invocation.command,
    invocation.args,
    invocation.stdin,
    invocation.cwd,
    options.timeout,
  );
}

/** Spawn a CLI process, optionally piping stdin. */
function spawnWithStdin(
  command: string,
  args: string[],
  stdin: string,
  cwd?: string,
  timeout?: number,
): Promise<AgentExecutionResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

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
