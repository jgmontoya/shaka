import { expect, test } from "bun:test";

test("codex Docker image installs the complete official standalone package", async () => {
  const dockerfile = await Bun.file("dockerfile-codex").text();

  expect(dockerfile).toContain("https://chatgpt.com/codex/install.sh");
  expect(dockerfile).toContain("CODEX_NON_INTERACTIVE=1");
  expect(dockerfile).not.toContain("releases/latest/download/codex-");
});
