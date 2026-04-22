/**
 * Provider-agnostic agent execution for workflow steps.
 *
 * Unlike inference.ts which disables tools and hooks (pure text inference),
 * this module runs the AI CLI with tools enabled and hooks active —
 * the agent can read/write files, run commands, etc.
 *
 * Claude/Codex: prompt piped via stdin to avoid ARG_MAX limits.
 * opencode: prompt passed as positional argument (stdin not supported for `run`).
 */

import { spawn } from "node:child_process";
import {
  type DetectedProviders,
  type ProviderName,
  detectInstalledProviders,
} from "../services/provider-detection";

export interface AgentExecutionOptions {
  readonly prompt: string;
  readonly timeout?: number;
  /** Working directory forwarded to the provider CLI subprocess. */
  readonly cwd?: string;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The provider that executed the step, or null when none were available. */
  readonly provider: ProviderName | null;
  /** True iff the internal timeout fired before the subprocess exited. */
  readonly timedOut: boolean;
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
  if (detected.claude) return runClaude(options);
  if (detected.opencode) return runOpencode(options);
  if (detected.codex) return runCodex(options);

  return {
    exitCode: 1,
    stdout: "",
    stderr: "No agent provider available. Install claude, opencode, or codex CLI.",
    provider: null,
    timedOut: false,
  };
}

function runClaude(opts: AgentExecutionOptions): Promise<AgentExecutionResult> {
  return spawnWithStdin("claude", "claude", ["-p"], opts.prompt, opts);
}

function runOpencode(opts: AgentExecutionOptions): Promise<AgentExecutionResult> {
  // `--` terminates option parsing so prompts starting with `-` (e.g. the
  // Autoresearch SKILL.md's leading `---` frontmatter) aren't misread as
  // flags. No `--agent` flag: let opencode pick its default.
  return spawnWithStdin("opencode", "opencode", ["run", "--", opts.prompt], "", opts);
}

/**
 * Run via Codex CLI — --full-auto enables autonomous tool use for workflow steps.
 *
 * When `SHAKA_CODEX_BYPASS_SANDBOX=1` is set, swap --full-auto (which is
 * `--sandbox workspace-write` under the hood) for `--dangerously-bypass-
 * approvals-and-sandbox`. This is the opt-in for environments that are ALREADY
 * externally sandboxed (Docker CI, VMs) where codex's internal Landlock-based
 * sandbox can't coexist with the outer layer and ends up silently blocking all
 * file writes. Codex's own help documents the flag's intent: "Intended solely
 * for running in environments that are externally sandboxed." Never set the
 * env var on a real user machine.
 */
function runCodex(opts: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const bypass = process.env.SHAKA_CODEX_BYPASS_SANDBOX === "1";
  const sandboxFlag = bypass ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto";
  // `-` tells `codex exec` to read the prompt from stdin.
  return spawnWithStdin("codex", "codex", ["exec", sandboxFlag, "-"], opts.prompt, opts);
}

/** Spawn a CLI process, optionally piping stdin. */
function spawnWithStdin(
  provider: ProviderName,
  command: string,
  args: string[],
  stdin: string,
  opts: AgentExecutionOptions,
): Promise<AgentExecutionResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });

    const timer = opts.timeout
      ? setTimeout(() => {
          if (!settled) {
            timedOut = true;
            proc.kill("SIGTERM");
            stderr = stderr
              ? `${stderr}\nTimeout after ${opts.timeout}ms`
              : `Timeout after ${opts.timeout}ms`;
            killTimer = setTimeout(() => {
              if (!settled) proc.kill("SIGKILL");
            }, 500);
            killTimer.unref?.();
          }
        }, opts.timeout)
      : undefined;

    proc.stdin.on("error", () => {
      // The provider may exit before consuming stdin; process close/error still decides the result.
    });
    try {
      if (stdin) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();
    } catch {
      // Keep the runner alive if the pipe closes between spawn and write.
    }
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve({ exitCode: timedOut ? 1 : (code ?? 1), stdout, stderr, provider, timedOut });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
          provider,
          timedOut: false,
        });
      }
    });
  });
}
