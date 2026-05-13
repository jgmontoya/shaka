import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTools, isToolDefinition } from "../../../src/mcp/tool-discovery";

describe("default tools", () => {
  const defaultToolsDir = join(import.meta.dir, "..", "..", "..", "defaults", "system", "tools");

  test("memory-search tool is discoverable", async () => {
    const tools = await discoverTools(defaultToolsDir);
    const memoryTool = tools.find((t) => t.name === "memory-search");
    expect(memoryTool).toBeDefined();
  });

  test("memory-search tool has correct schema", async () => {
    const tools = await discoverTools(defaultToolsDir);
    const memoryTool = tools.find((t) => t.name === "memory-search");
    expect(memoryTool?.description).toContain("session");
    expect(memoryTool?.inputSchema.properties).toHaveProperty("query");
    expect(memoryTool?.inputSchema.required).toContain("query");
  });
});

describe("tool-discovery", () => {
  async function withTestToolsDir<T>(run: (testToolsDir: string) => Promise<T>): Promise<T> {
    const testId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const testToolsDir = join(tmpdir(), `shaka-test-tools-${testId}`);
    await mkdir(testToolsDir, { recursive: true });
    try {
      return await run(testToolsDir);
    } finally {
      await rm(testToolsDir, { recursive: true, force: true });
    }
  }

  describe("isToolDefinition", () => {
    test("returns true for valid tool definition", () => {
      const tool = {
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "result",
      };
      expect(isToolDefinition(tool)).toBe(true);
    });

    test("returns true for tool with optional name", () => {
      const tool = {
        name: "custom-name",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "result",
      };
      expect(isToolDefinition(tool)).toBe(true);
    });

    test("returns false for null", () => {
      expect(isToolDefinition(null)).toBe(false);
    });

    test("returns false for non-object", () => {
      expect(isToolDefinition("string")).toBe(false);
      expect(isToolDefinition(123)).toBe(false);
    });

    test("returns false when missing description", () => {
      const tool = {
        inputSchema: { type: "object", properties: {} },
        execute: async () => "result",
      };
      expect(isToolDefinition(tool)).toBe(false);
    });

    test("returns false when missing execute", () => {
      const tool = {
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      };
      expect(isToolDefinition(tool)).toBe(false);
    });

    test("returns false when missing inputSchema", () => {
      const tool = {
        description: "A test tool",
        execute: async () => "result",
      };
      expect(isToolDefinition(tool)).toBe(false);
    });

    test("returns false when inputSchema.type is not object", () => {
      const tool = {
        description: "A test tool",
        inputSchema: { type: "string" },
        execute: async () => "result",
      };
      expect(isToolDefinition(tool)).toBe(false);
    });
  });

  describe("discoverTools", () => {
    test("returns empty array for non-existent directory", async () => {
      const tools = await discoverTools("/non/existent/path");
      expect(tools).toEqual([]);
    });

    test("returns empty array for empty directory", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        const tools = await discoverTools(testToolsDir);
        expect(tools).toEqual([]);
      });
    });

    test("ignores files without valid tool export", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(`${testToolsDir}/helper.ts`, `export const notATool = { foo: "bar" };`);
        const tools = await discoverTools(testToolsDir);
        expect(tools).toEqual([]);
      });
    });

    test("discovers tool from .ts file", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(
          `${testToolsDir}/echo.ts`,
          `export default {
          description: "Echo the input",
          inputSchema: { type: "object", properties: { message: { type: "string" } } },
          execute: async (args) => args.message,
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("echo");
        expect(tools[0]?.description).toBe("Echo the input");
      });
    });

    test("uses tool name from definition if provided", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(
          `${testToolsDir}/file.ts`,
          `export default {
          name: "custom-name",
          description: "A tool with custom name",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "result",
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("custom-name");
      });
    });

    test("discovers named export ending with Tool", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(
          `${testToolsDir}/utils.ts`,
          `export const helperTool = {
          description: "A helper tool",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "helped",
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("helper");
      });
    });

    test("discovers multiple tools from one file", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(
          `${testToolsDir}/multi.ts`,
          `export default {
          description: "Default tool",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "default",
        };
        export const extraTool = {
          description: "Extra tool",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "extra",
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.name).sort()).toEqual(["extra", "multi"]);
      });
    });

    test("handles invalid tool files gracefully", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(`${testToolsDir}/broken.ts`, "this is not valid javascript");
        await Bun.write(
          `${testToolsDir}/valid.ts`,
          `export default {
          description: "Valid tool",
          inputSchema: { type: "object", properties: {} },
          execute: async () => "valid",
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        // Should still load the valid tool
        expect(tools).toHaveLength(1);
        expect(tools[0]?.name).toBe("valid");
      });
    });

    test("tools can be executed", async () => {
      await withTestToolsDir(async (testToolsDir) => {
        await Bun.write(
          `${testToolsDir}/math.ts`,
          `export default {
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            }
          },
          execute: async (args) => String(Number(args.a) + Number(args.b)),
        };`,
        );

        const tools = await discoverTools(testToolsDir);

        expect(tools).toHaveLength(1);
        const result = await tools[0]?.execute({ a: 2, b: 3 });
        expect(result).toBe("5");
      });
    });
  });
});
