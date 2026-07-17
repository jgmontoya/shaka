import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverToolsWithOverrides } from "../../../src/mcp/tool-discovery";
import { renderOpencodeToolSchema } from "../../../src/providers/opencode/tool-schema";
import { PiProviderConfigurer } from "../../../src/providers/pi/configurer";
import { buildToolManifests } from "../../../src/providers/tool-manifest";

interface RecordedSchema {
  type: "string" | "number" | "boolean";
  required: boolean;
  enumValues?: string[];
  description?: string;
  optional(): RecordedSchema;
  describe(value: string): RecordedSchema;
}

function recordedSchema(type: RecordedSchema["type"], enumValues?: string[]): RecordedSchema {
  return {
    type,
    required: true,
    enumValues,
    optional() {
      this.required = false;
      return this;
    },
    describe(value) {
      this.description = value;
      return this;
    },
  };
}

const recordingZ = {
  string: () => recordedSchema("string"),
  number: () => recordedSchema("number"),
  boolean: () => recordedSchema("boolean"),
  enum: (values: string[]) => recordedSchema("string", values),
};

function evaluateOpencodeSchema(source: string): Record<string, RecordedSchema> {
  return Function("z", `return (${source});`)(recordingZ) as Record<string, RecordedSchema>;
}

describe.skipIf(process.platform === "win32")("native tool schema parity", () => {
  let root: string;
  let shakaHome: string;
  let piHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "shaka-native-tool-parity-"));
    shakaHome = join(root, "shaka");
    piHome = join(root, "pi", "agent");
    await mkdir(shakaHome, { recursive: true });
    await mkdir(join(shakaHome, "skills"), { recursive: true });
    const shippedSystem = join(import.meta.dir, "..", "..", "..", "defaults", "system");
    await symlink(shippedSystem, join(shakaHome, "system"), "dir");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("MCP, Pi, and opencode preserve every shipped canonical schema field", async () => {
    const manifests = await buildToolManifests(shakaHome);
    const mcpTools = await discoverToolsWithOverrides(
      join(shakaHome, "system", "tools"),
      join(shakaHome, "customizations", "tools"),
    );

    expect(
      mcpTools
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual(manifests);

    const piConfigurer = new PiProviderConfigurer({
      piHome,
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });
    const installResult = await piConfigurer.install({ shakaHome });
    if (!installResult.ok) throw installResult.error;
    const registeredTools: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }> = [];
    const extension = await import(
      `${pathToFileURL(join(piHome, "extensions", "shaka.ts")).href}?t=${Date.now()}`
    );
    extension.default({
      on() {},
      registerTool(tool: (typeof registeredTools)[number]) {
        registeredTools.push(tool);
      },
    });

    for (const manifest of manifests) {
      const piTool = registeredTools.find((tool) => tool.name === manifest.name);
      expect(piTool).toEqual(
        expect.objectContaining({
          description: manifest.description,
          parameters: manifest.inputSchema,
        }),
      );

      const opencodeSchema = evaluateOpencodeSchema(renderOpencodeToolSchema(manifest.inputSchema));
      const required = new Set(manifest.inputSchema.required ?? []);
      for (const [propertyName, property] of Object.entries(manifest.inputSchema.properties)) {
        expect(opencodeSchema[propertyName]).toEqual(
          expect.objectContaining({
            type: property.type,
            required: required.has(propertyName),
            enumValues: property.enum,
            description: property.description,
          }),
        );
      }
    }
  });
});
