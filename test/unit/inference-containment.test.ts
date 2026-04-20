import { test, expect } from "bun:test";

// Invariant: every CLI backend in src/inference.ts must contain its host
// runtime's hooks/plugins so calling inference() from inside a hook cannot
// recurse into itself. For opencode, this is load-bearing — the opencode
// plugin wrapper passes { prompt } to format-reminder via chat.message →
// transform, which would otherwise call inference() → spawn opencode run →
// recurse. For Claude and Codex, it's enforced via CLI flags.
//
// The text-based match is crude but durable — it fails loudly at review
// time if a new provider is added without a containment flag.
test("every inference CLI call contains its host runtime", async () => {
  const src = await Bun.file("src/inference.ts").text();

  // Claude: disables hooks + tools via CLI flags
  expect(src).toMatch(/callClaudeCLI[\s\S]*?--setting-sources/);
  expect(src).toMatch(/callClaudeCLI[\s\S]*?--tools/);

  // Codex: disables hooks via CLI flag
  expect(src).toMatch(/callCodexCLI[\s\S]*?--disable[\s\S]*?codex_hooks/);

  // Opencode: injects SHAKA_OPENCODE_SUBAGENT=true into child env (no CLI flag exists)
  expect(src).toMatch(/callOpenCodeCLI[\s\S]*?SHAKA_OPENCODE_SUBAGENT[\s\S]*?true/);
});

// Invariant: opencode inference calls pass --pure so the child process does
// not load external plugins — including shaka's own opencode plugin. This is
// belt-and-suspenders with SHAKA_OPENCODE_SUBAGENT: the env guard lets the
// plugin short-circuit, --pure prevents it from loading at all. Also cuts
// ~300ms of plugin-init overhead from every classifier call.
test("callOpenCodeCLI disables external plugins via --pure", async () => {
  const src = await Bun.file("src/inference.ts").text();
  expect(src).toMatch(/callOpenCodeCLI[\s\S]*?"--pure"/);
});
