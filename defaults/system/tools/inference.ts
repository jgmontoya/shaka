/**
 * Inference Tool for MCP
 *
 * Exposes the inference library as an MCP tool that Claude Code can call.
 * This allows Claude Code to invoke other AI models when needed.
 */

import { type InferenceOptions, inference } from "shaka";

export default {
  name: "inference",
  description:
    "Run AI inference using an available provider CLI. " +
    "Useful for tasks requiring a separate AI model call.",

  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string" as const,
        description: "The user prompt to send to the AI model",
      },
      systemPrompt: {
        type: "string" as const,
        description: "Optional system prompt to set context",
      },
      expectJson: {
        type: "boolean" as const,
        description: "If true, attempts to parse JSON from response",
      },
    },
    required: ["prompt"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const options: InferenceOptions = {
      userPrompt: args.prompt as string,
      systemPrompt: args.systemPrompt as string | undefined,
      expectJson: args.expectJson as boolean | undefined,
    };

    const result = await inference(options);

    if (!result.success) {
      return JSON.stringify({ error: result.error }, null, 2);
    }

    if (result.parsed) {
      return JSON.stringify(result.parsed, null, 2);
    }

    return result.text ?? "";
  },
};
