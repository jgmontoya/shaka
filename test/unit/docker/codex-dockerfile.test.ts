import { expect, test } from "bun:test";

test("codex Docker image installs the current Linux musl release assets", async () => {
  const dockerfile = await Bun.file("dockerfile-codex").text();

  expect(dockerfile).toContain('TRIPLE="aarch64-unknown-linux-musl"');
  expect(dockerfile).toContain('TRIPLE="x86_64-unknown-linux-musl"');
  expect(dockerfile).not.toContain("unknown-linux-gnu");
});
