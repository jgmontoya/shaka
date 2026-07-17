/**
 * Dynamic tool discovery for MCP server.
 * Scans directories for tool definitions and loads them.
 */

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JsonSchema, ToolDefinition } from "./types";

/**
 * Type guard to check if an object is a valid ToolDefinition.
 * Tools must have: description, inputSchema, execute
 * Name is optional (defaults to filename).
 */
export function isToolDefinition(
  obj: unknown,
): obj is Omit<ToolDefinition, "name"> & { name?: string } {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }

  const candidate = obj as Record<string, unknown>;

  // Required fields
  if (typeof candidate.description !== "string") return false;
  if (typeof candidate.execute !== "function") return false;

  // inputSchema must be an object with type: "object"
  if (typeof candidate.inputSchema !== "object" || candidate.inputSchema === null) {
    return false;
  }

  const schema = candidate.inputSchema as Record<string, unknown>;
  return schema.type === "object";
}

/**
 * Create a ToolDefinition from a valid tool export.
 */
function toToolDefinition(
  tool: Omit<ToolDefinition, "name"> & { name?: string },
  defaultName: string,
): ToolDefinition {
  return {
    name: tool.name ?? defaultName,
    description: tool.description,
    inputSchema: tool.inputSchema as JsonSchema,
    execute: tool.execute,
  };
}

/**
 * Process named exports from a module, looking for *Tool exports.
 */
function processNamedExports(module: Record<string, unknown>): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const [exportName, exportValue] of Object.entries(module)) {
    if (exportName === "default") continue;
    if (!exportName.endsWith("Tool")) continue;
    if (!isToolDefinition(exportValue)) continue;

    const toolName = exportName.replace(/Tool$/, "").toLowerCase();
    tools.push(toToolDefinition(exportValue, toolName));
  }

  return tools;
}

/**
 * Load tools from a single file.
 * Returns empty array if file is not a valid tool module.
 */
async function loadToolsFromFile(filePath: string, baseName: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  const module = await import(filePath);

  // Check default export
  if (module.default && isToolDefinition(module.default)) {
    tools.push(toToolDefinition(module.default, baseName));
  }

  // Check named exports that end with "Tool"
  tools.push(...processNamedExports(module));

  return tools;
}

export interface SourcedToolDefinition {
  readonly tool: ToolDefinition;
  readonly source: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadToolsFromFileStrict(
  filePath: string,
  baseName: string,
): Promise<SourcedToolDefinition[]> {
  let module: Record<string, unknown>;
  try {
    module = (await import(filePath)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to import tool file ${filePath}: ${errorMessage(error)}`);
  }

  const tools: SourcedToolDefinition[] = [];
  if ("default" in module) {
    if (!isToolDefinition(module.default)) {
      throw new Error(`Invalid default tool export in ${filePath}`);
    }
    tools.push({ tool: toToolDefinition(module.default, baseName), source: `${filePath}#default` });
  }

  for (const [exportName, exportValue] of Object.entries(module)) {
    if (exportName === "default" || !exportName.endsWith("Tool")) continue;
    if (!isToolDefinition(exportValue)) {
      throw new Error(`Invalid tool export ${exportName} in ${filePath}`);
    }
    const toolName = exportName.replace(/Tool$/, "").toLowerCase();
    tools.push({
      tool: toToolDefinition(exportValue, toolName),
      source: `${filePath}#${exportName}`,
    });
  }

  if (tools.length === 0) {
    throw new Error(`Tool file ${filePath} contains no valid tool export`);
  }
  return tools;
}

export async function discoverToolsStrict(
  toolsDir: string,
  options: { allowMissing?: boolean } = {},
): Promise<SourcedToolDefinition[]> {
  let files: string[];
  try {
    files = await readdir(toolsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (options.allowMissing && code === "ENOENT") return [];
    throw new Error(`Failed to read tools directory ${toolsDir}: ${errorMessage(error)}`);
  }

  const toolFiles = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")).sort();
  const tools: SourcedToolDefinition[] = [];
  for (const file of toolFiles) {
    tools.push(...(await loadToolsFromFileStrict(join(toolsDir, file), basename(file, ".ts"))));
  }

  const firstSourceByName = new Map<string, string>();
  for (const { tool, source } of tools) {
    const firstSource = firstSourceByName.get(tool.name);
    if (firstSource) {
      throw new Error(`Duplicate tool name "${tool.name}" in ${firstSource} and ${source}`);
    }
    firstSourceByName.set(tool.name, source);
  }
  return tools;
}

/**
 * Discover and load tools from a directory.
 * Returns an array of ToolDefinition objects.
 *
 * Tool files should export a default object matching ToolDefinition:
 * - name (optional, defaults to filename)
 * - description (required)
 * - inputSchema (required)
 * - execute (required)
 */
export async function discoverTools(toolsDir: string): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  let files: string[];
  try {
    files = await readdir(toolsDir);
  } catch {
    // Directory doesn't exist - that's ok
    return tools;
  }

  // All .ts files in tools/ directory are tools (except .d.ts)
  const toolFiles = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

  for (const file of toolFiles) {
    const filePath = join(toolsDir, file);
    const baseName = basename(file, ".ts");

    try {
      const fileTools = await loadToolsFromFile(filePath, baseName);
      tools.push(...fileTools);
    } catch (error) {
      // Log but don't fail - one bad tool shouldn't break everything
      console.error(`[MCP] Failed to load tool ${file}:`, error);
    }
  }

  return tools;
}

/**
 * Discover tools from system and user directories with override support.
 *
 * Loads tools from both directories. If the same tool name appears in both,
 * the user version takes precedence (user overrides system).
 *
 * @param systemToolsDir - Path to system/tools directory
 * @param userToolsDir - Path to user/tools directory
 * @returns Merged array of tools with user overrides applied
 */
export async function discoverToolsWithOverrides(
  systemToolsDir: string,
  userToolsDir: string,
): Promise<ToolDefinition[]> {
  // Load system tools first
  const systemTools = await discoverTools(systemToolsDir);

  // Build map keyed by tool name
  const toolMap = new Map<string, ToolDefinition>();
  for (const tool of systemTools) {
    toolMap.set(tool.name, tool);
  }

  // Load user tools - these override system tools on collision
  const userTools = await discoverTools(userToolsDir);
  for (const tool of userTools) {
    if (toolMap.has(tool.name)) {
      console.error(`[MCP] Customization tool "${tool.name}" overrides system tool`);
    }
    toolMap.set(tool.name, tool);
  }

  return [...toolMap.values()];
}
