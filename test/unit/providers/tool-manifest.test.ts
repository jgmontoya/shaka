import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_RESERVED_TOOL_NAMES } from "../../../src/providers/opencode/reserved-tool-names";
import { PI_RESERVED_TOOL_NAMES } from "../../../src/providers/pi/reserved-tool-names";
import { buildToolManifests } from "../../../src/providers/tool-manifest";

describe("buildToolManifests", () => {
  test("builds deterministic serializable manifests from canonical system tools", async () => {
    const shakaHome = join(import.meta.dir, "..", "..", "..", "defaults");

    const manifests = await buildToolManifests(shakaHome);

    expect(manifests.map((tool) => tool.name)).toEqual(["inference", "memory-search"]);
    expect(manifests.every((tool) => !("execute" in tool))).toBe(true);

    const memorySearch = manifests.find((tool) => tool.name === "memory-search");
    expect(memorySearch?.inputSchema.properties.all_projects).toEqual({
      type: "boolean",
      description: "Search memory from every project instead of the current project",
    });
    expect(memorySearch?.inputSchema.properties.type?.enum).toEqual([
      "session",
      "learning",
      "knowledge",
    ]);

    const inference = manifests.find((tool) => tool.name === "inference");
    expect(inference?.inputSchema.properties.expectJson?.type).toBe("boolean");
    expect(inference?.description).toBe(
      "Run AI inference using an available provider CLI. Useful for tasks requiring a separate AI model call.",
    );
  });

  test("rejects an intended tool that cannot be imported", async () => {
    const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const toolsDir = join(shakaHome, "system", "tools");
    await mkdir(toolsDir, { recursive: true });
    await Bun.write(join(toolsDir, "broken.ts"), "this is not valid TypeScript");

    try {
      await expect(buildToolManifests(shakaHome)).rejects.toThrow(
        /broken\.ts.*(?:import|load)|(?:import|load).*broken\.ts/i,
      );
    } finally {
      await rm(shakaHome, { recursive: true, force: true });
    }
  });

  test("rejects duplicate tool names within one discovery tier", async () => {
    const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const toolsDir = join(shakaHome, "system", "tools");
    await mkdir(toolsDir, { recursive: true });
    const toolSource = (description: string) => `export default {
      name: "duplicate",
      description: ${JSON.stringify(description)},
      inputSchema: { type: "object", properties: {} },
      execute: async () => "ok",
    };`;
    await Bun.write(join(toolsDir, "first.ts"), toolSource("first"));
    await Bun.write(join(toolsDir, "second.ts"), toolSource("second"));

    try {
      await expect(buildToolManifests(shakaHome)).rejects.toThrow(
        /duplicate.*first\.ts.*second\.ts/i,
      );
    } finally {
      await rm(shakaHome, { recursive: true, force: true });
    }
  });

  test("rejects schema properties outside the shared native profile", async () => {
    const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const toolsDir = join(shakaHome, "system", "tools");
    await mkdir(toolsDir, { recursive: true });
    await Bun.write(
      join(toolsDir, "unsupported.ts"),
      `export default {
        description: "Unsupported schema",
        inputSchema: {
          type: "object",
          properties: { values: { type: "array" } },
        },
        execute: async () => "ok",
      };`,
    );

    try {
      await expect(buildToolManifests(shakaHome)).rejects.toThrow(
        /unsupported.*properties\.values\.type.*array/i,
      );
    } finally {
      await rm(shakaHome, { recursive: true, force: true });
    }
  });

  test("rejects collisions with provider built-in tools", async () => {
    const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const toolsDir = join(shakaHome, "system", "tools");
    await mkdir(toolsDir, { recursive: true });
    await Bun.write(
      join(toolsDir, "read.ts"),
      `export default {
        description: "Replace Pi read",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "ok",
      };`,
    );

    try {
      await expect(buildToolManifests(shakaHome)).rejects.toThrow(/read.*Pi.*built-in/i);
    } finally {
      await rm(shakaHome, { recursive: true, force: true });
    }
  });

  test("rejects opencode collisions and unsafe native names in customization tools", async () => {
    for (const [name, expected] of [
      ["glob", /glob.*opencode.*built-in/i],
      ["unsafe tool", /unsafe tool.*represented safely/i],
    ] as const) {
      const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
      const systemDir = join(shakaHome, "system", "tools");
      const customDir = join(shakaHome, "customizations", "tools");
      await mkdir(systemDir, { recursive: true });
      await mkdir(customDir, { recursive: true });
      await Bun.write(
        join(systemDir, "safe.ts"),
        `export default {
          description: "Safe",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "ok",
        };`,
      );
      await Bun.write(
        join(customDir, "custom.ts"),
        `export default {
          name: ${JSON.stringify(name)},
          description: "Custom",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "ok",
        };`,
      );
      try {
        await expect(buildToolManifests(shakaHome)).rejects.toThrow(expected);
      } finally {
        await rm(shakaHome, { recursive: true, force: true });
      }
    }
  });

  test("uses a customization definition as the resolved manifest contract", async () => {
    const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const systemDir = join(shakaHome, "system", "tools");
    const customDir = join(shakaHome, "customizations", "tools");
    await mkdir(systemDir, { recursive: true });
    await mkdir(customDir, { recursive: true });
    const toolSource = (description: string, property: string) => `export default {
      name: "shared-tool",
      description: ${JSON.stringify(description)},
      inputSchema: {
        type: "object",
        properties: { ${JSON.stringify(property)}: { type: "string" } },
      },
      execute: async () => "ok",
    };`;
    await Bun.write(join(systemDir, "shared.ts"), toolSource("system", "systemValue"));
    await Bun.write(join(customDir, "shared.ts"), toolSource("custom", "customValue"));

    try {
      const manifests = await buildToolManifests(shakaHome);
      expect(manifests).toEqual([
        {
          name: "shared-tool",
          description: "custom",
          inputSchema: {
            type: "object",
            properties: { customValue: { type: "string" } },
          },
        },
      ]);
    } finally {
      await rm(shakaHome, { recursive: true, force: true });
    }
  });

  test("rejects a missing system tools directory and invalid intended exports", async () => {
    const missingHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    try {
      await expect(buildToolManifests(missingHome)).rejects.toThrow(/system.*tools/i);
    } finally {
      await rm(missingHome, { recursive: true, force: true });
    }

    const invalidHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
    const toolsDir = join(invalidHome, "system", "tools");
    await mkdir(toolsDir, { recursive: true });
    await Bun.write(join(toolsDir, "invalid.ts"), "export default { description: 'invalid' };");
    try {
      await expect(buildToolManifests(invalidHome)).rejects.toThrow(
        /invalid.*default.*invalid\.ts/i,
      );
    } finally {
      await rm(invalidHome, { recursive: true, force: true });
    }
  });

  test("rejects invalid named tool exports and files without intended exports", async () => {
    for (const [filename, source, expected] of [
      [
        "named.ts",
        "export const brokenTool = { description: 'invalid' };",
        /brokenTool.*named\.ts/,
      ],
      ["helper.ts", "export const helper = 1;", /helper\.ts.*no valid tool export/],
    ] as const) {
      const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
      const toolsDir = join(shakaHome, "system", "tools");
      await mkdir(toolsDir, { recursive: true });
      await Bun.write(join(toolsDir, filename), source);
      try {
        await expect(buildToolManifests(shakaHome)).rejects.toThrow(expected);
      } finally {
        await rm(shakaHome, { recursive: true, force: true });
      }
    }
  });

  test("rejects malformed and non-JSON schema values with schema paths", async () => {
    const cases = [
      {
        name: "missing-properties",
        schema: `{ type: "object" }`,
        expected: /inputSchema\.properties/,
      },
      {
        name: "unknown-keyword",
        schema: `{ type: "object", properties: {}, additionalProperties: false }`,
        expected: /additionalProperties.*unsupported keyword/,
      },
      {
        name: "invalid-required",
        schema: `{ type: "object", properties: { value: { type: "string" } }, required: ["missing"] }`,
        expected: /required.*unknown property.*missing/,
      },
      {
        name: "invalid-enum",
        schema: `{ type: "object", properties: { value: { type: "boolean", enum: ["yes"] } } }`,
        expected: /properties\.value\.enum.*string property/,
      },
      {
        name: "sparse-enum",
        schema: `{ type: "object", properties: { value: { type: "string", enum: Array(1) } } }`,
        expected: /enum\[0\].*sparse.*not JSON serializable/,
      },
      {
        name: "undefined-value",
        schema: `{ type: "object", properties: { value: { type: "string", description: undefined } } }`,
        expected: /description.*undefined.*not JSON serializable/,
      },
      {
        name: "cyclic-value",
        schema: `(() => {
          const schema: Record<string, unknown> = { type: "object", properties: {} };
          (schema.properties as Record<string, unknown>).value = schema;
          return schema;
        })()`,
        expected: /cyclic.*not JSON serializable/,
      },
    ];

    for (const testCase of cases) {
      const shakaHome = await mkdtemp(join(tmpdir(), "shaka-tool-manifest-"));
      const toolsDir = join(shakaHome, "system", "tools");
      await mkdir(toolsDir, { recursive: true });
      await Bun.write(
        join(toolsDir, `${testCase.name}.ts`),
        `export default {
          description: ${JSON.stringify(testCase.name)},
          inputSchema: ${testCase.schema},
          execute: async () => "ok",
        };`,
      );
      try {
        await expect(buildToolManifests(shakaHome)).rejects.toThrow(testCase.expected);
      } finally {
        await rm(shakaHome, { recursive: true, force: true });
      }
    }
  });

  test("pins the native provider built-in namespaces", () => {
    expect([...PI_RESERVED_TOOL_NAMES]).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    expect([...OPENCODE_RESERVED_TOOL_NAMES]).toEqual([
      "invalid",
      "question",
      "bash",
      "read",
      "glob",
      "grep",
      "edit",
      "write",
      "task",
      "webfetch",
      "todowrite",
      "websearch",
      "codesearch",
      "skill",
      "apply_patch",
      "lsp",
      "plan",
      "plan_enter",
      "plan_exit",
    ]);
  });
});
