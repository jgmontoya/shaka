import { afterEach, describe, expect, test } from "bun:test";
import { createAutoresearchCommand, withSigintAbort } from "../../../src/commands/autoresearch";

describe("autoresearch command surface", () => {
  test("top-level command is named 'autoresearch' with a description", () => {
    const cmd = createAutoresearchCommand();
    expect(cmd.name()).toBe("autoresearch");
    expect(cmd.description()).toBeTruthy();
  });

  test("exposes start | status | resume subcommands", () => {
    const cmd = createAutoresearchCommand();
    const names = cmd.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["resume", "start", "status"]);
  });
});

describe("withSigintAbort", () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  test("sets process.exitCode to 130 when SIGINT fires", async () => {
    process.exitCode = 0;
    const controller = new AbortController();

    await withSigintAbort(controller, "interrupted", async () => {
      process.emit("SIGINT");
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    expect(controller.signal.aborted).toBe(true);
    expect(process.exitCode).toBe(130);
  });

  test("leaves process.exitCode untouched when no SIGINT fires", async () => {
    process.exitCode = 0;
    const controller = new AbortController();

    await withSigintAbort(controller, "unused", async () => {
      // graceful completion — no signal
    });

    expect(controller.signal.aborted).toBe(false);
    expect(process.exitCode).toBe(0);
  });
});
