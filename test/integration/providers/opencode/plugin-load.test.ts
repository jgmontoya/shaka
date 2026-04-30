/**
 * Integration test for the generated opencode plugin.
 *
 * Generates `~/.config/opencode/plugins/shaka.ts` via the configurer, then
 * loads the file through Bun's import resolver — same path opencode uses
 * at runtime. A stub `@opencode-ai/plugin` package is written to a per-test
 * `node_modules/` so resolution succeeds without pulling the real SDK
 * (~zod + effect + opencode-sdk) into Shaka's devDependencies. Exercises
 * the load-bearing contract:
 *
 *   - Plugin file exports `ShakaPlugin` and the function returns a Hooks
 *     object with our two custom tools (memory-search, inference).
 *   - Each tool's `args` is a `z.ZodRawShape` (flat record), not a JSON
 *     Schema — opencode crashes on JSON Schema with `n._zod.def` undefined
 *     (Exp 53 verified live).
 *   - `execute()` shells to `shaka tool <name>` with JSON args on stdin,
 *     surfaces stdout as a plain string (opencode's `ToolResult` accepts
 *     `string | { output, metadata }`).
 *
 * The stub `shaka` is a real shell script on disk so we test the actual
 * Bun.spawn / stdin / exit-code wiring, not a substituted abstraction.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeProviderConfigurer } from "../../../../src/providers/opencode/configurer";

const ROOT = join(
  tmpdir(),
  `shaka-opencode-plugin-load-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const SHAKA_HOME = join(ROOT, "shaka");
const OPENCODE_DIR = join(ROOT, "opencode");
const PLUGINS_DIR = join(OPENCODE_DIR, "plugins");
const STUB_PKG_DIR = join(OPENCODE_DIR, "node_modules", "@opencode-ai", "plugin");
const BIN_DIR = join(ROOT, "bin");
const SHAKA_BIN = join(BIN_DIR, "shaka");
const STDIN_LOG = join(ROOT, "stdin.log");
const ARGV_LOG = join(ROOT, "argv.log");
const ENV_LOG = join(ROOT, "env.log");

const savedEnv = { ...process.env };

interface PluginTool {
  description?: string;
  args?: Record<string, unknown>;
  execute?: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}

interface PluginHooks {
  tool?: Record<string, PluginTool>;
  [key: string]: unknown;
}

async function writeStubPluginPackage(): Promise<void> {
  await mkdir(STUB_PKG_DIR, { recursive: true });
  await Bun.write(
    join(STUB_PKG_DIR, "package.json"),
    JSON.stringify({ name: "@opencode-ai/plugin", type: "module", main: "index.js" }),
  );
  // Stub stands in for the real `@opencode-ai/plugin`: `tool()` is identity
  // (opencode's helper just forwards the input object too — see
  // `@opencode-ai/plugin/dist/tool.d.ts`); `tool.schema` is a Proxy that
  // accepts any zod chain (`.string().optional().describe(...)`,
  // `.enum([...]).optional()`) without throwing. We only care about loading
  // the plugin and inspecting its returned shape — argument validation lives
  // inside opencode's runtime and is exercised by Exp 53.
  await Bun.write(
    join(STUB_PKG_DIR, "index.js"),
    `const chainable = () => new Proxy(function noop() {}, {
  get: () => chainable,
  apply: () => chainable(),
});
export const tool = (def) => def;
tool.schema = new Proxy({}, { get: () => chainable });
`,
  );
}

async function writeStubShaka(): Promise<void> {
  await Bun.write(
    SHAKA_BIN,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" > ${shellEscape(ARGV_LOG)}`,
      `printf '%s\\n' "$SHAKA_HOME" > ${shellEscape(ENV_LOG)}`,
      `cat > ${shellEscape(STDIN_LOG)}`,
      `if [ "$1" = "tool" ]; then`,
      `  printf '{"tool":"%s","args":%s}' "$2" "$(cat ${shellEscape(STDIN_LOG)})"`,
      `  exit 0`,
      `fi`,
      `exit 1`,
      "",
    ].join("\n"),
  );
  await chmod(SHAKA_BIN, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function loadPlugin(): Promise<(ctx: { directory: string }) => Promise<PluginHooks>> {
  const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: OPENCODE_DIR });
  const result = await configurer.install({ shakaHome: SHAKA_HOME });
  if (!result.ok) throw result.error;
  // Cache-bust so each test gets a fresh module — keeps any module-level
  // state in the generated plugin from leaking across tests.
  const url = new URL(`file://${join(PLUGINS_DIR, "shaka.ts")}?t=${Date.now()}`);
  const mod = (await import(url.href)) as {
    ShakaPlugin: (ctx: { directory: string }) => Promise<PluginHooks>;
  };
  return mod.ShakaPlugin;
}

beforeAll(async () => {
  await mkdir(BIN_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(SHAKA_HOME, { recursive: true, force: true });
  await rm(OPENCODE_DIR, { recursive: true, force: true });
  await mkdir(`${SHAKA_HOME}/system/hooks`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/agents`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/skills`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/skills`, { recursive: true });
  await writeStubPluginPackage();
  // SHAKA_BIN is honored by the generated plugin's `runShakaTool` (set for
  // the same reason Pi's extension reads it — lets the test point at a stub
  // without relying on Bun.spawn's PATH resolution).
  process.env.SHAKA_BIN = SHAKA_BIN;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe.skipIf(process.platform === "win32")(
  "opencode plugin — generated plugin contract",
  () => {
    test("exports ShakaPlugin and returns a Hooks object", async () => {
      const ShakaPlugin = await loadPlugin();
      expect(typeof ShakaPlugin).toBe("function");
      const hooks = await ShakaPlugin({ directory: ROOT });
      expect(typeof hooks).toBe("object");
      expect(hooks).not.toBeNull();
    });

    test("exposes Shaka tools (memory-search, inference) on the Hooks `tool` field", async () => {
      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });

      const names = Object.keys(hooks.tool ?? {}).sort();
      expect(names).toEqual(["inference", "memory-search"]);

      const memorySearch = hooks.tool?.["memory-search"];
      expect(memorySearch?.description).toContain("Search past session");
      expect(typeof memorySearch?.execute).toBe("function");
      // Shape of `args` (zod vs JSON Schema) is asserted at the unit level
      // via substring on the generated source — the stub `tool.schema` Proxy
      // here can't distinguish the two without pulling in real zod.
    });

    test("memory-search execute() shells to `shaka tool memory-search` with JSON args on stdin", async () => {
      await writeStubShaka();
      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });
      const memorySearch = hooks.tool?.["memory-search"];

      const result = await memorySearch?.execute?.({ query: "anything" }, {});

      // opencode's ToolResult is `string | { output, metadata }` —
      // our generator returns the raw subprocess stdout as a string.
      expect(typeof result).toBe("string");
      expect(result).toContain('"tool":"memory-search"');
      expect(result).toContain('"query":"anything"');

      // The bridge must have shelled out with the canonical `shaka tool`
      // subcommand — same source-of-truth path as Pi and the MCP server.
      const argv = await Bun.file(ARGV_LOG).text();
      expect(argv.trim()).toBe("tool memory-search");
    });

    test("forwards the install-time SHAKA_HOME to the spawned `shaka tool` subprocess", async () => {
      // The plugin file is generated for one Shaka home, but the subprocess
      // inherits whatever env opencode happens to be running with. Without
      // an explicit forward, a non-default `shaka init` install would
      // generate a plugin pinned to home A, but every tool call would
      // re-resolve against the ambient env (often pointing at home B).
      await writeStubShaka();
      // Mutate ambient SHAKA_HOME so a missing forward would resolve to
      // the wrong path. The afterEach restore handles cleanup.
      process.env.SHAKA_HOME = join(ROOT, "ambient-not-installed-home");

      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });
      await hooks.tool?.["memory-search"]?.execute?.({ query: "anything" }, {});

      const seenShakaHome = (await Bun.file(ENV_LOG).text()).trim();
      expect(seenShakaHome).toBe(SHAKA_HOME);
    });
  },
);
