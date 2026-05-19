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
  const src = await Bun.file("src/providers/opencode/inference.ts").text();
  expect(src).toMatch(/"--format",\s*"json"/);
});

test("callOpenCodeCLI fires-and-forgets opencode session delete with --pure", async () => {
  // Two assertions for one behavior (fire-and-forget native cleanup):
  //   1. The spawn has the exact argument shape — opencode, --pure, session,
  //      delete, and sessionId (the variable, not a literal). A looser regex
  //      would accept `Bun.spawn([..., "ses_abc"])` which regresses correctness.
  //   2. The spawned child is unref'ed. Without that, the caller's process stays
  //      alive until cleanup exits, even though we don't await .exited.
  const src = await Bun.file("src/providers/opencode/inference.ts").text();
  expect(src).toMatch(
    /Bun\.spawn\(\s*\[\s*"opencode",\s*"--pure",\s*"session",\s*"delete",\s*sessionId\s*\][\s\S]*?\)\.unref\(\)/,
  );
  expect(src).not.toMatch(/await\s+Bun\.spawn\(\s*\[\s*"opencode"/);
});
