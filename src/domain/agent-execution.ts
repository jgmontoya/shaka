/**
 * Provider-agnostic agent execution for workflow steps.
 *
 * Unlike inference.ts which disables tools and hooks (pure text inference),
 * this module runs the AI CLI with tools enabled and hooks active —
 * the agent can read/write files, run commands, etc.
 *
 * Claude / Codex / Pi: prompt piped via stdin (avoids ARG_MAX and yargs
 * `-`-prefix hazards). Pi additionally pins provider/model and scans stdout
 * for exit-0-on-error responses (Pi quirk verified in Exp 43).
 * opencode: prompt passed as positional argument (stdin not supported for `run`).
 */

import { spawn } from "node:child_process";
import { DEFAULT_PI_MODEL, piProviderForModel } from "../providers/pi/defaults";
import { detectProviderError } from "../providers/pi/error-detect";
import { getProviderNames } from "../providers/registry";
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
  /** Optional Pi provider override. Must agree with piModel when set. */
  readonly piProvider?: string;
  /** Optional Pi model override. Provider is derived from the model namespace. */
  readonly piModel?: string;
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
  if (detected.pi) return runPi(options);

  return {
    exitCode: 1,
    stdout: "",
    stderr: `No agent provider available. Install ${getProviderNames().join(", ")} CLI.`,
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

/**
 * Run via Pi CLI in print mode. The runner pins provider/model because Pi
 * defaults to Google (Exp 42) and bare model patterns route nondeterministically
 * (Exp 43). Prompt comes via stdin to dodge the `-`-prefix yargs hazard
 * (`feedback_argv_prompts_need_double_dash.md`); Pi merges piped stdin into
 * its initial-prompt slot in print mode (Exp 42).
 *
 * Pi exits 0 even when the provider returns 4xx/5xx (Exp 43) — wrap the spawn
 * to surface those failures as runner errors via `detectProviderError`.
 */
async function runPi(opts: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const model = opts.piModel ?? DEFAULT_PI_MODEL;
  const provider = piProviderForModel(model);
  if (!provider) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unsupported Pi model namespace: ${model}`,
      provider: "pi",
      timedOut: false,
    };
  }
  if (opts.piProvider && !opts.piModel) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "piProvider requires piModel so Pi receives a matching provider/model pair",
      provider: "pi",
      timedOut: false,
    };
  }
  if (opts.piProvider && opts.piProvider !== provider) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Pi provider ${opts.piProvider} does not match model ${model}; expected ${provider}`,
      provider: "pi",
      timedOut: false,
    };
  }
  const args = ["-p", "--provider", provider, "--model", model];
  const result = await spawnWithStdin("pi", "pi", args, opts.prompt, opts);
  if (result.exitCode === 0) {
    const providerError = detectProviderError(result.stdout);
    if (providerError) {
      return {
        ...result,
        exitCode: providerError.code,
        stderr: result.stderr ? `${result.stderr}\n${providerError.body}` : providerError.body,
      };
    }
  }
  return result;
}

function appendTimeoutSentinel(stderr: string, timeoutMs: number | undefined): string {
  const sentinel = `Timeout after ${timeoutMs}ms`;
  return stderr ? `${stderr}\n${sentinel}` : sentinel;
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
    let exited = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    // `exit` fires when the child process terminates; `close` fires later when
    // stdio streams finish draining. Tracking `exited` separately prevents the
    // timeout from misclassifying a successful-but-draining process as a
    // timeout if the timer fires in that gap.
    proc.on("exit", () => {
      exited = true;
    });

    const timer = opts.timeout
      ? setTimeout(() => {
          if (!settled && !exited) {
            timedOut = true;
            proc.kill("SIGTERM");
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
        // Timeout sentinel is appended AFTER draining stderr so late
        // shutdown chunks land before it — keeps the tail chronological
        // for consumers that parse shutdown reasons.
        const finalStderr = timedOut ? appendTimeoutSentinel(stderr, opts.timeout) : stderr;
        resolve({
          exitCode: timedOut ? 1 : (code ?? 1),
          stdout,
          stderr: finalStderr,
          provider,
          timedOut,
        });
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
