import { describe, expect, test } from "bun:test";
import { renderOpencodeToolSchema } from "../../../../src/providers/opencode/tool-schema";

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

function evaluateSchema(source: string): Record<string, RecordedSchema> {
  return Function("z", `return (${source});`)(recordingZ) as Record<string, RecordedSchema>;
}

describe("renderOpencodeToolSchema", () => {
  test("renders a required string property with its description", () => {
    const source = renderOpencodeToolSchema({
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt" },
      },
      required: ["prompt"],
    });

    expect(evaluateSchema(source)).toEqual({
      prompt: expect.objectContaining({
        type: "string",
        required: true,
        description: "The prompt",
      }),
    });
  });

  test("preserves optionality, primitive types, enums, and escaped values", () => {
    const source = renderOpencodeToolSchema({
      type: "object",
      properties: {
        "output-format": {
          type: "string",
          enum: ["plain", 'quoted "value"'],
          description: 'Choose a "format"',
        },
        enabled: { type: "boolean" },
        count: { type: "number" },
      },
      required: ["count"],
    });

    const schema = evaluateSchema(source);
    expect(Object.keys(schema)).toEqual(["output-format", "enabled", "count"]);
    expect(schema["output-format"]).toEqual(
      expect.objectContaining({
        type: "string",
        required: false,
        enumValues: ["plain", 'quoted "value"'],
        description: 'Choose a "format"',
      }),
    );
    expect(schema.enabled).toEqual(expect.objectContaining({ type: "boolean", required: false }));
    expect(schema.count).toEqual(expect.objectContaining({ type: "number", required: true }));
  });
});
