import { test, expect } from "bun:test";

// Invariant: every provider inference backend must contain its host
// runtime's hooks/plugins so calling inference() from inside a hook cannot
// recurse into itself. For opencode, this is load-bearing — the opencode
// plugin wrapper passes { prompt } to format-reminder via chat.message →
// transform, which would otherwise call inference() → spawn opencode run →
// recurse. For Claude and Codex, it's enforced via CLI flags.
//
// The text-based match is crude but durable — it fails loudly at review
// time if a new provider is added without a containment flag.
test("every inference CLI call contains its host runtime", async () => {
  const claude = await Bun.file("src/providers/claude/inference.ts").text();
  const codex = await Bun.file("src/providers/codex/inference.ts").text();
  const opencode = await Bun.file("src/providers/opencode/inference.ts").text();

  // Claude: disables hooks + tools via CLI flags
  expect(claude).toContain('"--setting-sources"');
  expect(claude).toContain('"--tools"');

  // Codex: disables hooks via CLI flag
  expect(codex).toMatch(/"--disable"[\s\S]*?"hooks"/);
  expect(codex).not.toContain("codex_hooks");

  // Opencode: injects SHAKA_OPENCODE_SUBAGENT=true into child env (no CLI flag exists)
  expect(opencode).toMatch(/SHAKA_OPENCODE_SUBAGENT[\s\S]*?true/);
});

// Invariant: opencode inference calls pass --pure so the child process does
// not load external plugins — including shaka's own opencode plugin. This is
// belt-and-suspenders with SHAKA_OPENCODE_SUBAGENT: the env guard lets the
// plugin short-circuit, --pure prevents it from loading at all. Also cuts
// ~300ms of plugin-init overhead from every classifier call.
test("callOpenCodeCLI disables external plugins via --pure", async () => {
  const src = await Bun.file("src/providers/opencode/inference.ts").text();
  expect(src).toContain('"--pure"');
});

test("callOpenCodeCLI uses opencode's frontmatter agent name for inference", async () => {
  const src = await Bun.file("src/providers/opencode/inference.ts").text();
  expect(src).toMatch(/"--agent"[\s\S]*?OPENCODE_INFERENCE_AGENT/);
  expect(src).not.toContain('"shaka/inference"');
});

test("callOpenCodeCLI terminates options before passing the prompt", async () => {
  const src = await Bun.file("src/providers/opencode/inference.ts").text();
  expect(src).toMatch(/args\.push\("--", prompt\)/);
});

// Invariant: claude inference calls pass --no-session-persistence so the
// child process does not leave entries under ~/.claude/projects/<cwd>/.
// Sibling to codex's --ephemeral: hook-triggered classifier calls must
// not pollute the user's session picker. Flag only works with --print,
// which callClaudeCLI already uses (-p).
test("callClaudeCLI disables session persistence via --no-session-persistence", async () => {
  const src = await Bun.file("src/providers/claude/inference.ts").text();
  expect(src).toContain('"--no-session-persistence"');
});
