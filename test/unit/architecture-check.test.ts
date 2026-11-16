import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const checkerPath = join(repoRoot, "scripts/architecture-check.ts");

describe("architecture check", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "shaka-test-architecture-")));
    await Bun.write(join(root, "src/providers/codex/inference.ts"), 'export const run = "codex";');
    await Bun.write(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "preserve", moduleResolution: "bundler" } }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function check(command = [process.execPath, checkerPath]) {
    const proc = Bun.spawn(command, {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("rejects concrete provider imports with the source line and resolved target", async () => {
    await Bun.write(
      join(root, "src/services/task.ts"),
      '\nimport { run } from "../providers/codex/inference";\n',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/services/task.ts:2");
    expect(result.stdout).toContain("src/providers/codex/inference.ts");
  });

  test("guards new provider directories without a provider-name allowlist", async () => {
    await Bun.write(
      join(root, "src/providers/future/inference.ts"),
      'export const run = "future";',
    );
    await Bun.write(
      join(root, "src/task.ts"),
      'import { run } from "./providers/future/inference";',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/task.ts:1");
    expect(result.stdout).toContain("src/providers/future/inference.ts");
  });

  test("rejects dependencies between concrete providers", async () => {
    await Bun.write(
      join(root, "src/providers/pi/inference.ts"),
      'export { run } from "../codex/inference";',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "ERROR cross-provider-dependency: src/providers/pi/inference.ts:1",
    );
    expect(result.stdout).toContain("src/providers/codex/inference.ts");
  });

  test("guards new adapters on either side of a cross-provider dependency", async () => {
    await Bun.write(
      join(root, "src/providers/future/inference.ts"),
      'export const run = "future";',
    );
    await Bun.write(
      join(root, "src/providers/future/bridge.ts"),
      'export { run } from "../codex/inference";',
    );
    await Bun.write(
      join(root, "src/providers/codex/bridge.ts"),
      'export { run } from "../future/inference";',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    for (const provider of ["future", "codex"]) {
      expect(result.stdout).toContain(
        `ERROR cross-provider-dependency: src/providers/${provider}/bridge.ts:1`,
      );
    }
  });

  test("resolves aliased dynamic imports across provider boundaries", async () => {
    await Bun.write(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "preserve",
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "@providers/*": ["src/providers/*"] },
        },
      }),
    );
    await Bun.write(
      join(root, "src/providers/pi/inference.ts"),
      'export const load = () => import("@providers/codex/inference");',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "ERROR cross-provider-dependency: src/providers/pi/inference.ts:1",
    );
    expect(result.stdout).toContain(
      "@providers/codex/inference resolves to src/providers/codex/inference.ts",
    );
  });

  test("rejects named, star, and namespace re-exports from concrete providers", async () => {
    for (const [name, declaration] of Object.entries({
      named: 'export { run } from "./providers/codex/inference";',
      star: 'export * from "./providers/codex/inference";',
      namespace: 'export * as codex from "./providers/codex/inference";',
    })) {
      await Bun.write(join(root, `src/${name}.ts`), declaration);
    }

    const result = await check();
    expect(result.exitCode).toBe(1);
    for (const name of ["named", "star", "namespace"]) {
      expect(result.stdout).toContain(`ERROR concrete-provider-dependency: src/${name}.ts:1`);
    }
  });

  test("rejects literal dynamic imports inside functions", async () => {
    await Bun.write(
      join(root, "src/task.ts"),
      [
        'export async function load() { return import("./providers/codex/inference"); }',
        "export const lazy = () => import(`./providers/codex/inference`);",
      ].join("\n"),
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/task.ts:1");
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/task.ts:2");
  });

  test("rejects type dependencies and import-equals declarations", async () => {
    await Bun.write(
      join(root, "src/types.ts"),
      [
        'import type { run } from "./providers/codex/inference";',
        'export type Run = typeof import("./providers/codex/inference").run;',
        'import codex = require("./providers/codex/inference");',
        'export type { run } from "./providers/codex/inference";',
      ].join("\n"),
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    for (const line of [1, 2, 3, 4]) {
      expect(result.stdout).toContain(`ERROR concrete-provider-dependency: src/types.ts:${line}`);
    }
  });

  test("rejects adapter parser re-exports from the shared inference module", async () => {
    await Bun.write(
      join(root, "src/providers/opencode/inference.ts"),
      'export const parseOpencodeJsonStream = "parser";',
    );
    await Bun.write(
      join(root, "src/inference.ts"),
      'export { parseOpencodeJsonStream } from "./providers/opencode/inference";',
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/inference.ts:1");
  });

  test("resolves tsconfig aliases before classifying dependencies", async () => {
    await Bun.write(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "preserve",
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "@providers/*": ["src/providers/*"] },
        },
      }),
    );
    await Bun.write(join(root, "src/task.ts"), 'import { run } from "@providers/codex/inference";');

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "@providers/codex/inference resolves to src/providers/codex/inference.ts",
    );
  });

  test("normalizes relative paths and JavaScript extensions for each concrete provider", async () => {
    for (const provider of ["claude", "codex", "opencode", "pi"]) {
      await Bun.write(
        join(root, `src/providers/${provider}/inference.ts`),
        'export const run = "ok";',
      );
      await Bun.write(
        join(root, `src/services/nested/${provider}.ts`),
        `import "../../providers/../providers/${provider}/inference.js";`,
      );
    }

    const result = await check();
    expect(result.exitCode).toBe(1);
    for (const provider of ["claude", "codex", "opencode", "pi"]) {
      expect(result.stdout).toContain(`src/services/nested/${provider}.ts:1`);
      expect(result.stdout).toContain(`resolves to src/providers/${provider}/inference.ts`);
    }
  });

  test("allows generic interfaces, registry wiring, and concrete adapter internals", async () => {
    await Bun.write(join(root, "src/providers/types.ts"), 'export type Provider = "codex";');
    await Bun.write(
      join(root, "src/providers/registry.ts"),
      'export { run } from "./codex/inference";',
    );
    await Bun.write(join(root, "src/providers/pi/health.ts"), 'export const run = "pi";');
    await Bun.write(
      join(root, "src/providers/pi/inference.ts"),
      'import type { Provider } from "../types"; export { run } from "./health";',
    );
    await Bun.write(
      join(root, "src/task.ts"),
      'import { run } from "./providers/registry"; import type { Provider } from "./providers/types";',
    );

    const result = await check();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("ERROR");
  });

  test("ignores comment and string lookalikes and dependencies outside production source", async () => {
    await Bun.write(
      join(root, "src/task.ts"),
      [
        '// import { run } from "./providers/codex/inference";',
        "const example = 'export * from \"./providers/codex/inference\"';",
        'const documentation = `import("./providers/codex/inference")`;',
        'const loader = { import: (name: string) => name }; loader.import("./providers/codex/inference");',
      ].join("\n"),
    );
    for (const path of ["test/task.test.ts", "defaults/system/hooks/task.ts"]) {
      await Bun.write(join(root, path), 'export * from "../src/providers/codex/inference";');
    }

    const result = await check();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no findings");
  });

  test("keeps heuristic warnings advisory", async () => {
    await Bun.write(
      join(root, "src/providers/pi/timeout.ts"),
      'export const signals = ["SIGTERM", "SIGKILL"];',
    );

    const result = await check();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WARN duplicate-process-timeout-chain");
    expect(result.stdout).not.toContain("ERROR");
  });

  test("fails visibly when the compiler configuration cannot be read", async () => {
    await Bun.write(join(root, "tsconfig.json"), '{ "compilerOptions": ');

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid tsconfig.json:");
  });

  test("fails visibly when the compiler configuration is missing", async () => {
    await rm(join(root, "tsconfig.json"));

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid tsconfig.json:");
  });

  test("identifies invalid compiler options as a configuration failure", async () => {
    await Bun.write(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "unknown" } }),
    );

    const result = await check();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid tsconfig.json:");
  });

  test("the canonical check rejects a dependency that passes TypeScript and lint", async () => {
    for (const path of [
      "package.json",
      "tsconfig.json",
      "biome.json",
      "scripts/architecture-check.ts",
    ]) {
      await Bun.write(join(root, path), Bun.file(join(repoRoot, path)));
    }
    await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");
    await Bun.write(
      join(root, "src/providers/codex/inference.ts"),
      'export const run = "codex";\n',
    );
    await Bun.write(
      join(root, "src/task.ts"),
      'import { run } from "./providers/codex/inference";\n\nexport const result = run;\n',
    );

    const result = await check([process.execPath, "run", "check"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("ERROR concrete-provider-dependency: src/task.ts:1");
  }, 15_000);
});
