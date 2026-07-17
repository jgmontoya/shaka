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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpencodeProviderConfigurer } from "../../../../src/providers/opencode/configurer";

let ROOT = "";
let SHAKA_HOME = "";
let OPENCODE_DIR = "";
let PLUGINS_DIR = "";
let STUB_PKG_DIR = "";
let BIN_DIR = "";
let SHAKA_BIN = "";
let STDIN_LOG = "";
let ARGV_LOG = "";
let ENV_LOG = "";

const savedEnv = { ...process.env };
let pluginImportCounter = 0;

interface PluginTool {
  description?: string;
  args?: Record<string, RecordedSchema>;
  execute?: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}

interface RecordedSchema {
  type: "string" | "number" | "boolean";
  required: boolean;
  enumValues?: string[];
  description?: string;
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
  // `tool()` is identity, matching opencode's helper. The schema functions
  // record each generated Zod chain so this test can compare semantic fields
  // without adding the provider SDK or Zod as production dependencies.
  await Bun.write(
    join(STUB_PKG_DIR, "index.js"),
    `const schema = (type, enumValues) => ({
  type,
  required: true,
  enumValues,
  optional() { this.required = false; return this; },
  describe(value) { this.description = value; return this; },
});
export const tool = (def) => def;
tool.schema = {
  string: () => schema("string"),
  number: () => schema("number"),
  boolean: () => schema("boolean"),
  enum: (values) => schema("string", values),
};
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
      'if [ "$1" = "tool" ]; then',
      `  printf '{"tool":"%s","args":%s}' "$2" "$(cat ${shellEscape(STDIN_LOG)})"`,
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(SHAKA_BIN, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function loadPlugin(options?: {
  toolTimeoutMs?: number;
  toolKillGraceMs?: number;
}): Promise<(ctx: { directory: string }) => Promise<PluginHooks>> {
  const configurer = new OpencodeProviderConfigurer({ opencodeConfigDir: OPENCODE_DIR });
  const result = await configurer.install({ shakaHome: SHAKA_HOME });
  if (!result.ok) throw result.error;
  const generatedPath = join(PLUGINS_DIR, "shaka.ts");
  if (options?.toolTimeoutMs !== undefined || options?.toolKillGraceMs !== undefined) {
    let content = await Bun.file(generatedPath).text();
    if (options.toolTimeoutMs !== undefined) {
      const next = content.replace(
        "const TOOL_TIMEOUT_MS = 60_000;",
        `const TOOL_TIMEOUT_MS = ${options.toolTimeoutMs};`,
      );
      if (next === content) throw new Error("Generated plugin TOOL_TIMEOUT_MS constant changed");
      content = next;
    }
    if (options.toolKillGraceMs !== undefined) {
      const next = content.replace(
        "const TOOL_KILL_GRACE_MS = 500;",
        `const TOOL_KILL_GRACE_MS = ${options.toolKillGraceMs};`,
      );
      if (next === content) {
        throw new Error("Generated plugin TOOL_KILL_GRACE_MS constant changed");
      }
      content = next;
    }
    await Bun.write(generatedPath, content);
  }
  // Bun caches file imports by path, not reliably by query string. Import a
  // fresh copy each time so module-level plugin state cannot leak across tests.
  const importPath = join(
    PLUGINS_DIR,
    `shaka-${process.pid}-${Date.now()}-${pluginImportCounter++}.ts`,
  );
  await copyFile(generatedPath, importPath);
  const mod = (await import(pathToFileURL(importPath).href)) as {
    ShakaPlugin: (ctx: { directory: string }) => Promise<PluginHooks>;
  };
  return mod.ShakaPlugin;
}

beforeEach(async () => {
  const testId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ROOT = join(tmpdir(), `shaka-opencode-plugin-load-${testId}`);
  SHAKA_HOME = join(ROOT, "shaka");
  OPENCODE_DIR = join(ROOT, "opencode");
  PLUGINS_DIR = join(OPENCODE_DIR, "plugins");
  STUB_PKG_DIR = join(OPENCODE_DIR, "node_modules", "@opencode-ai", "plugin");
  BIN_DIR = join(ROOT, "bin");
  SHAKA_BIN = join(BIN_DIR, "shaka");
  STDIN_LOG = join(ROOT, "stdin.log");
  ARGV_LOG = join(ROOT, "argv.log");
  ENV_LOG = join(ROOT, "env.log");
  pluginImportCounter = 0;

  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/hooks`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/tools`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/agents`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/system/skills`, { recursive: true });
  await mkdir(`${SHAKA_HOME}/skills`, { recursive: true });
  await Bun.write(
    `${SHAKA_HOME}/system/tools/memory-search.ts`,
    `export default {
      name: "memory-search",
      description: "Search past session summaries, learnings, and compiled project knowledge.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          category: { type: "string", description: "Learning category" },
          cwd: { type: "string", description: "Working directory" },
          all_projects: { type: "boolean", description: "Search every project" },
          type: {
            type: "string",
            enum: ["session", "learning", "knowledge"],
            description: "Result type",
          },
        },
        required: ["query"],
      },
      execute: async () => "ok",
    };`,
  );
  await Bun.write(
    `${SHAKA_HOME}/system/tools/inference.ts`,
    `export default {
      name: "inference",
      description: "Run AI inference using an available provider CLI.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "User prompt" },
          systemPrompt: { type: "string", description: "System prompt" },
          expectJson: { type: "boolean", description: "Parse JSON" },
        },
        required: ["prompt"],
      },
      execute: async () => "ok",
    };`,
  );
  await writeStubPluginPackage();
  // SHAKA_BIN is honored by the generated plugin's `runShakaTool` (set for
  // the same reason Pi's extension reads it — lets the test point at a stub
  // without relying on Bun.spawn's PATH resolution).
  process.env.SHAKA_BIN = SHAKA_BIN;
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(ROOT, { recursive: true, force: true });
});

// These tests mutate process.env and the generated plugin captures SHAKA_BIN
// at import time, so they must remain serial even if the suite runs concurrent.
describe.serial.skipIf(process.platform === "win32")(
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

      const inference = hooks.tool?.inference;
      expect(inference?.description).toContain("Run AI inference");
      expect(typeof inference?.execute).toBe("function");
      expect(memorySearch?.args?.query).toEqual(
        expect.objectContaining({ type: "string", required: true, description: "Search query" }),
      );
      expect(memorySearch?.args?.all_projects).toEqual(
        expect.objectContaining({ type: "boolean", required: false }),
      );
      expect(memorySearch?.args?.type).toEqual(
        expect.objectContaining({
          required: false,
          enumValues: ["session", "learning", "knowledge"],
        }),
      );
      expect(inference?.args?.expectJson).toEqual(
        expect.objectContaining({ type: "boolean", required: false }),
      );
    });

    test("uses a customization override in the generated registration", async () => {
      await mkdir(join(SHAKA_HOME, "customizations", "tools"), { recursive: true });
      await Bun.write(
        join(SHAKA_HOME, "customizations", "tools", "memory-search.ts"),
        `export default {
          name: "memory-search",
          description: "Customized memory search",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number", description: "Result limit" } },
            required: ["limit"],
          },
          execute: async () => "ok",
        };`,
      );

      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });
      const memorySearch = hooks.tool?.["memory-search"];

      expect(memorySearch?.description).toBe("Customized memory search");
      expect(memorySearch?.args).toEqual({
        limit: expect.objectContaining({
          type: "number",
          required: true,
          description: "Result limit",
        }),
      });
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

    test("inference execute() shells to `shaka tool inference` with JSON args on stdin", async () => {
      await writeStubShaka();
      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });
      const inference = hooks.tool?.inference;

      const result = await inference?.execute?.({ prompt: "summarize", model: "auto" }, {});

      expect(typeof result).toBe("string");
      expect(result).toContain('"tool":"inference"');
      expect(result).toContain('"prompt":"summarize"');
      expect(result).toContain('"model":"auto"');

      const argv = await Bun.file(ARGV_LOG).text();
      expect(argv.trim()).toBe("tool inference");
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

    test("tool execute returns after the timeout grace window when a descendant keeps stdio open", async () => {
      await Bun.write(
        SHAKA_BIN,
        [
          "#!/bin/sh",
          'if [ "$1" = "tool" ]; then',
          "  (sleep 1) &",
          "  printf 'started\\n'",
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      );
      await chmod(SHAKA_BIN, 0o755);

      const ShakaPlugin = await loadPlugin({ toolTimeoutMs: 30, toolKillGraceMs: 20 });
      const hooks = await ShakaPlugin({ directory: ROOT });
      const started = performance.now();

      const result = await hooks.tool?.["memory-search"]?.execute?.({ query: "anything" }, {});

      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(500);
      expect(result).toBe("Error: shaka tool memory-search timed out after 30ms");
    });

    test("tool.execute.after only runs post-tool hooks whose matcher includes the tool", async () => {
      const hookLog = join(ROOT, "post-tool.log");
      await Bun.write(
        join(SHAKA_HOME, "system", "hooks", "post-tool.ts"),
        [
          'import { appendFile } from "node:fs/promises";',
          'import { pathToFileURL } from "node:url";',
          'export const TRIGGER = ["tool.after"] as const;',
          'export const MATCHER = ["Bash"] as const;',
          'if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {',
          "  const input = JSON.parse(await Bun.stdin.text());",
          `  await appendFile(${JSON.stringify(hookLog)}, \`\${input.tool_name}\\n\`);`,
          "}",
          "",
        ].join("\n"),
      );

      const ShakaPlugin = await loadPlugin();
      const hooks = await ShakaPlugin({ directory: ROOT });
      const afterHook = hooks["tool.execute.after"];
      expect(typeof afterHook).toBe("function");

      await (afterHook as Function)(
        { tool: "read", sessionID: "session-1", callID: "call-1" },
        { args: { filePath: "README.md" } },
      );
      expect(await Bun.file(hookLog).exists()).toBe(false);

      await (afterHook as Function)(
        { tool: "bash", sessionID: "session-1", callID: "call-2" },
        { args: { command: "echo ok" } },
      );
      expect(await Bun.file(hookLog).text()).toBe("Bash\n");
    });
  },
);
