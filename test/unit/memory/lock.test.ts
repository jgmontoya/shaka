import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryLockTimeoutError, withDirectoryLock } from "../../../src/memory/lock";

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

describe("withDirectoryLock", () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "shaka-lock-test-"));
    lockPath = join(testDir, "operation.lock");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("releases the lock when the operation throws", async () => {
    await expect(
      withDirectoryLock(lockPath, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    const result = await withDirectoryLock(lockPath, async () => "reacquired");

    expect(result).toBe("reacquired");
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("does not reclaim a live lock whose heartbeat is current", async () => {
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withDirectoryLock(
      lockPath,
      async () => {
        firstEntered();
        await release;
      },
      { heartbeatMs: 5, staleMs: 25, timeoutMs: 500, pollMs: 5 },
    );
    await entered;
    await Bun.sleep(50);

    let secondEntered = false;
    const second = withDirectoryLock(
      lockPath,
      async () => {
        secondEntered = true;
      },
      { heartbeatMs: 5, staleMs: 25, timeoutMs: 500, pollMs: 5 },
    );
    await Bun.sleep(40);

    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  test("times out without disturbing the current owner", async () => {
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withDirectoryLock(
      lockPath,
      async () => {
        firstEntered();
        await release;
      },
      { heartbeatMs: 10, staleMs: 1_000, timeoutMs: 500, pollMs: 5 },
    );
    await entered;

    await expect(
      withDirectoryLock(lockPath, async () => undefined, {
        staleMs: 1_000,
        timeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(DirectoryLockTimeoutError);
    expect((await stat(lockPath)).isDirectory()).toBe(true);

    releaseFirst();
    await first;
    expect(await pathExists(lockPath)).toBe(false);
  });
});
