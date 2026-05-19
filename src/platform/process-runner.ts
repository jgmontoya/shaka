import { spawn } from "node:child_process";

export interface ProcessInvocation {
  readonly command: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly killGraceMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessResult>;

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line;
}

/**
 * Run one subprocess and capture UTF-8 stdout/stderr.
 *
 * The runner waits for process close, not only exit, so normal shutdown output
 * is captured before the result resolves. Timed-out processes resolve after
 * the SIGKILL grace window even if descendants keep stdio open.
 */
export function runProcess(invocation: ProcessInvocation): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const args = [...(invocation.args ?? [])];
    const killGraceMs = invocation.killGraceMs ?? 500;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const proc = spawn(invocation.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: invocation.cwd,
      env: invocation.env ? { ...process.env, ...invocation.env } : process.env,
    });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    const timer =
      invocation.timeout !== undefined
        ? setTimeout(() => {
            if (!settled && !exited) {
              timedOut = true;
              proc.kill("SIGTERM");
              killTimer = setTimeout(() => {
                if (!settled) {
                  proc.kill("SIGKILL");
                  finish(1, true);
                }
              }, killGraceMs);
              killTimer.unref?.();
            }
          }, invocation.timeout)
        : undefined;
    timer?.unref?.();

    const finish = (exitCode: number, timedOutResult: boolean) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve({
          exitCode,
          stdout,
          stderr: timedOutResult
            ? appendLine(stderr, `Timeout after ${invocation.timeout}ms`)
            : stderr,
          timedOut: timedOutResult,
        });
      }
    };

    proc.on("exit", () => {
      exited = true;
    });

    proc.stdin.on("error", () => {
      // The child may exit before consuming stdin. close/error decides result.
    });
    try {
      if (invocation.stdin) {
        proc.stdin.write(invocation.stdin);
      }
      proc.stdin.end();
    } catch {
      // Keep the runner alive if the pipe closes between spawn and write.
    }

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("close", (code) => {
      finish(timedOut ? 1 : (code ?? 1), timedOut);
    });

    proc.on("error", (err) => {
      stdout = "";
      stderr = err.message;
      finish(1, false);
    });
  });
}
