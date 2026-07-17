import type { JsonSchema, JsonSchemaProperty } from "../../mcp/types";

function renderProperty(property: JsonSchemaProperty, required: boolean): string {
  let schema: string;
  if (property.enum) {
    schema = `z.enum(${JSON.stringify(property.enum)})`;
  } else {
    switch (property.type) {
      case "string":
        schema = "z.string()";
        break;
      case "number":
        schema = "z.number()";
        break;
      case "boolean":
        schema = "z.boolean()";
        break;
      default:
        throw new Error(`Unsupported opencode tool property type: ${property.type}`);
    }
  }

  if (!required) schema += ".optional()";
  if (property.description !== undefined) {
    schema += `.describe(${JSON.stringify(property.description)})`;
  }
  return schema;
}

export function renderOpencodeToolSchema(inputSchema: JsonSchema): string {
  const required = new Set(inputSchema.required ?? []);
  const properties = Object.entries(inputSchema.properties).map(
    ([name, property]) =>
      `    [${JSON.stringify(name)}]: ${renderProperty(property, required.has(name))}`,
  );
  return `{\n${properties.join(",\n")}\n  }`;
}
