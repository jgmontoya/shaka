import { test, expect } from "bun:test";

// Invariants for the opencode session-cleanup wiring in callOpenCodeCLI.
// Each classifier call creates a session in opencode's sqlite DB (no
// upstream --ephemeral on opencode run, issue #4489 still open). To keep
// the user's session picker clean, we:
//   1. Ask opencode for structured output (--format json) so we can
//      extract the created session's ID from its event stream.
//   2. Fire-and-forget `opencode --pure session delete <sid>` in the
//      background, off the user's critical path.
//
// Source-regex invariants are the pragmatic tool — a behaviorally
// complete test would need to spawn real opencode and race the cleanup,
// which is too slow/brittle for a unit test. The parser itself is
// tested as a pure function in inference.test.ts.

test("callOpenCodeCLI requests JSON output via --format json", async () => {
  const src = await Bun.file("src/inference.ts").text();
  expect(src).toMatch(/callOpenCodeCLI[\s\S]*?"--format"[\s\S]*?"json"/);
});

test("callOpenCodeCLI fires-and-forgets opencode session delete with --pure", async () => {
  // Regex asserts three aspects of the cleanup invariant in one shot:
  //   1. Bun.spawn (not awaited Bun.$) → fire-and-forget shape
  //   2. --pure in the cleanup args → recursion safety + speed
  //   3. "session", "delete" → native subcommand, not direct sqlite
  // If any of the three regresses, the shape that protects the user
  // from cluttered sessions AND from plugin recursion is broken.
  const src = await Bun.file("src/inference.ts").text();
  expect(src).toMatch(
    /callOpenCodeCLI[\s\S]*?Bun\.spawn[\s\S]*?"--pure"[\s\S]*?"session"[\s\S]*?"delete"/,
  );
});
