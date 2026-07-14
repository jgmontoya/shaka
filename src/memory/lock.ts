import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_POLL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 5 * 1000;

const OWNER_FILE = "owner.json";

export interface DirectoryLockOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly heartbeatMs?: number;
}

export class DirectoryLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Timed out waiting for lock: ${lockPath}`);
    this.name = "DirectoryLockTimeoutError";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
}

function heartbeatPath(lockPath: string, token: string): string {
  return join(lockPath, `heartbeat-${token}`);
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(lockPath, OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number") return null;
    return { token: parsed.token, pid: parsed.pid };
  } catch {
    return null;
  }
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
  const owner = await readOwner(lockPath);
  const target = owner ? heartbeatPath(lockPath, owner.token) : lockPath;
  const targetStat = await stat(target).catch(() => null);
  return targetStat ? Date.now() - targetStat.mtimeMs : null;
}

async function reclaimIfStale(lockPath: string, staleMs: number): Promise<void> {
  const ageMs = await lockAgeMs(lockPath);
  if (ageMs === null || ageMs <= staleMs) return;

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch {
    return;
  }
  await rm(stalePath, { recursive: true, force: true });
}

async function releaseIfOwned(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) return;
  await rm(lockPath, { recursive: true, force: true });
}

export async function withDirectoryLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: DirectoryLockOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_HEARTBEAT_MS, staleMs / 3);
  const token = randomUUID();

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await reclaimIfStale(lockPath, staleMs);
      if (Date.now() >= deadline) throw new DirectoryLockTimeoutError(lockPath);
      await Bun.sleep(pollMs);
    }
  }

  try {
    await Bun.write(join(lockPath, OWNER_FILE), JSON.stringify({ token, pid: process.pid }));
    await Bun.write(heartbeatPath(lockPath, token), String(Date.now()));
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }

  const heartbeat = setInterval(() => {
    void readOwner(lockPath).then((owner) => {
      if (owner?.token !== token) {
        clearInterval(heartbeat);
        return;
      }
      void Bun.write(heartbeatPath(lockPath, token), String(Date.now())).catch(() => {});
    });
  }, heartbeatMs);

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await releaseIfOwned(lockPath, token);
  }
}
