export interface SmokeLoadResult {
  exitCode: number;
  stderr: string;
}

/**
 * Run Pi against the freshly written extension to verify it loads.
 * Implementations can short-circuit when Pi is not installed locally.
 */
export type SmokeLoadRunner = (piHome: string) => Promise<SmokeLoadResult>;

/** Smoke-load budget. Generous enough for slow CI but tight enough that a
 * real hang surfaces during install instead of after the user gives up.
 */
const SMOKE_LOAD_TIMEOUT_MS = 30_000;

/**
 * Race a spawned process against a wall-clock budget. On timeout the child
 * is killed and a synthetic non-zero result is returned so callers can
 * distinguish "load failed" from "load hung."
 */
export async function runProcessWithTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<SmokeLoadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SmokeLoadResult>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 500);
      killTimer.unref?.();
      resolve({ exitCode: 1, stderr: `Pi smoke-load timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
  const completion = (async (): Promise<SmokeLoadResult> => {
    try {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      const exitCode = await proc.exited;
      return { exitCode, stderr };
    } finally {
      if (killTimer) clearTimeout(killTimer);
    }
  })();
  try {
    return await Promise.race([completion, timeout]);
  } finally {
    completion.catch(() => {});
    if (timer) clearTimeout(timer);
  }
}

export async function defaultSmokeLoadRunner(piHome: string): Promise<SmokeLoadResult> {
  const piBin = Bun.which("pi");
  if (!piBin) {
    return { exitCode: 0, stderr: "" };
  }
  const proc = Bun.spawn(
    [
      piBin,
      "--offline",
      "-p",
      "--no-tools",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
    ],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: piHome, PI_TELEMETRY: "0" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  return runProcessWithTimeout(proc, SMOKE_LOAD_TIMEOUT_MS);
}
