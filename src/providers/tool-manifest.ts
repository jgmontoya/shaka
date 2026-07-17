import { join } from "node:path";
import { discoverToolsStrict } from "../mcp/tool-discovery";
import type { JsonSchema } from "../mcp/types";
import { OPENCODE_RESERVED_TOOL_NAMES } from "./opencode/reserved-tool-names";
import { PI_RESERVED_TOOL_NAMES } from "./pi/reserved-tool-names";

export interface ToolManifest {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

const ROOT_SCHEMA_KEYS = new Set(["type", "properties", "required"]);
const PROPERTY_SCHEMA_KEYS = new Set(["type", "description", "enum"]);
const NATIVE_PROPERTY_TYPES = new Set(["string", "number", "boolean"]);
const NATIVE_TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

function validateToolName(name: unknown): asserts name is string {
  if (typeof name !== "string")
    throw new Error(`Tool name must be a string, received ${typeof name}`);
  if (!NATIVE_TOOL_NAME.test(name)) {
    throw new Error(
      `Tool "${name}" cannot be represented safely by Pi and opencode; use 1-64 lowercase letters, numbers, hyphens, or underscores`,
    );
  }
  if (PI_RESERVED_TOOL_NAMES.has(name)) {
    throw new Error(`Tool "${name}" collides with a Pi built-in tool`);
  }
  if (OPENCODE_RESERVED_TOOL_NAMES.has(name)) {
    throw new Error(`Tool "${name}" collides with an opencode built-in tool`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function assertJsonArray(value: unknown[], path: string, stack: Set<object>): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new Error(`${path}: symbol keys are not JSON serializable`);
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      throw new Error(`${path}.${key}: array properties are not JSON serializable`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${path}[${index}]: expected a data property`);
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${path}[${index}]: sparse arrays are not JSON serializable`);
    }
    assertJsonSerializable(value[index], `${path}[${index}]`, stack);
  }
}

function assertJsonSerializable(value: unknown, path: string, stack = new Set<object>()): void {
  if (isJsonScalar(value)) return;
  if (typeof value === "number") {
    throw new Error(`${path}: non-finite numbers are not JSON serializable`);
  }
  if (typeof value !== "object") {
    throw new Error(`${path}: ${typeof value} values are not JSON serializable`);
  }
  if (stack.has(value)) throw new Error(`${path}: cyclic values are not JSON serializable`);

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      assertJsonArray(value, path, stack);
      return;
    }
    if (!isPlainObject(value)) throw new Error(`${path}: expected a plain JSON object`);

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(`${path}: symbol keys are not JSON serializable`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${path}.${key}: expected an enumerable data property`);
      }
      assertJsonSerializable(descriptor.value, `${path}.${key}`, stack);
    }
  } finally {
    stack.delete(value);
  }
}

function assertSupportedKeys(
  value: Record<string, unknown>,
  supportedKeys: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!supportedKeys.has(key)) throw new Error(`${path}.${key}: unsupported keyword`);
  }
}

function validateEnum(property: Record<string, unknown>, path: string): void {
  if (property.enum === undefined) return;
  if (property.type !== "string") {
    throw new Error(`${path}.enum: enums require a string property`);
  }
  if (
    !Array.isArray(property.enum) ||
    property.enum.length === 0 ||
    property.enum.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${path}.enum: expected a non-empty string array`);
  }
}

function validateProperty(value: unknown, path: string): void {
  if (!isPlainObject(value)) throw new Error(`${path}: expected an object`);
  assertSupportedKeys(value, PROPERTY_SCHEMA_KEYS, path);
  if (!NATIVE_PROPERTY_TYPES.has(String(value.type))) {
    throw new Error(`${path}.type: unsupported type ${JSON.stringify(value.type)}`);
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${path}.description: expected a string`);
  }
  validateEnum(value, path);
}

function validateRequired(value: unknown, propertyNames: ReadonlySet<string>, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`${path}: expected an array of property names`);
  }
  const seen = new Set<string>();
  for (const [index, propertyName] of value.entries()) {
    if (typeof propertyName !== "string") {
      throw new Error(`${path}[${index}]: expected a string`);
    }
    if (seen.has(propertyName)) {
      throw new Error(`${path}: duplicate property ${JSON.stringify(propertyName)}`);
    }
    if (!propertyNames.has(propertyName)) {
      throw new Error(`${path}: unknown property ${JSON.stringify(propertyName)}`);
    }
    seen.add(propertyName);
  }
}

function validateInputSchema(toolName: string, value: unknown): JsonSchema {
  const rootPath = `Tool "${toolName}" inputSchema`;
  assertJsonSerializable(value, rootPath);
  if (!isPlainObject(value)) throw new Error(`${rootPath}: expected an object schema`);
  assertSupportedKeys(value, ROOT_SCHEMA_KEYS, rootPath);
  if (value.type !== "object") throw new Error(`${rootPath}.type: expected "object"`);
  if (!isPlainObject(value.properties)) {
    throw new Error(`${rootPath}.properties: expected a plain object`);
  }

  for (const [name, property] of Object.entries(value.properties)) {
    validateProperty(property, `${rootPath}.properties.${name}`);
  }
  validateRequired(value.required, new Set(Object.keys(value.properties)), `${rootPath}.required`);

  return JSON.parse(JSON.stringify(value)) as JsonSchema;
}

export async function buildToolManifests(shakaHome: string): Promise<ToolManifest[]> {
  const systemToolsDir = join(shakaHome, "system", "tools");
  const systemTools = await discoverToolsStrict(systemToolsDir);
  const customizationTools = await discoverToolsStrict(join(shakaHome, "customizations", "tools"), {
    allowMissing: true,
  });
  const tools = new Map(systemTools.map(({ tool }) => [tool.name, tool]));
  for (const { tool } of customizationTools) tools.set(tool.name, tool);

  return [...tools.values()]
    .map(({ name, description, inputSchema }) => {
      validateToolName(name);
      return {
        name,
        description,
        inputSchema: validateInputSchema(name, inputSchema),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
