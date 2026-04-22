import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSetupInteractive } from "../../../src/services/setup-session";

const STUB = resolve(__dirname, "../../fixtures/stub-setup-provider.sh");

test("runSetupInteractive hands stdio to a real subprocess and leaves artifacts on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shaka-setup-session-"));
  try {
    // Inject a spawn that redirects any argv to the stub fixture. The orchestrator
    // still exercises the real Bun.spawn + stdio:inherit + await exited path.
    const spawn: typeof Bun.spawn = ((_argv: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
      Bun.spawn([STUB], opts)) as typeof Bun.spawn;

    const result = await runSetupInteractive(dir, "test objective", "claude", "skill", { spawn });

    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("claude");
    expect(await Bun.file(join(dir, "autoresearch.md")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "autoresearch.sh")).exists()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
