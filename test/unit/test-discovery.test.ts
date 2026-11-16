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
      'import { test } from "bun:test";\n' +
        'test("included test runs", async () => {\n' +
        '  await Bun.write(new URL("./included.ran", import.meta.url), "included");\n' +
        "});\n",
    );
    await Bun.write(
      join(fixtureRoot, "experiments", "excluded.test.ts"),
      'import { test } from "bun:test";\n' +
        'test("outside test does not run", async () => {\n' +
        '  await Bun.write(new URL("./excluded.ran", import.meta.url), "excluded");\n' +
        "});\n",
    );

    const subprocess = Bun.spawn([process.execPath, "test"], {
      cwd: fixtureRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode, output).toBe(0);
    expect(await Bun.file(join(fixtureRoot, "test/included.ran")).exists(), output).toBe(true);
    expect(await Bun.file(join(fixtureRoot, "experiments/excluded.ran")).exists(), output).toBe(
      false,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}, 10_000);
