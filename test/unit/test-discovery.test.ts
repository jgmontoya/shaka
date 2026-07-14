import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(dirname(import.meta.path), "../..");

test("repository test configuration excludes tests outside test/", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "shaka-test-discovery-"));

  try {
    const configuration = Bun.file(join(repositoryRoot, "bunfig.toml"));
    expect(await configuration.exists()).toBe(true);

    await mkdir(join(fixtureRoot, "test"));
    await mkdir(join(fixtureRoot, "experiments"));
    await Bun.write(join(fixtureRoot, "bunfig.toml"), configuration);
    await Bun.write(
      join(fixtureRoot, "test", "included.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'test("included test runs", () => expect(true).toBe(true));\n',
    );
    await Bun.write(
      join(fixtureRoot, "experiments", "excluded.test.ts"),
      'import { test } from "bun:test";\n' +
        'test("outside test does not run", () => { throw new Error("outside test ran"); });\n',
    );

    const subprocess = Bun.spawn(["bun", "test"], {
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode, output).toBe(0);
    expect(output).toContain("included test runs");
    expect(output).not.toContain("outside test ran");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
