import { parseResponse } from "../inference-response";
import type { ProviderInference } from "../types";
import { DEFAULT_PI_MODEL, piProviderForModel } from "./defaults";
import { detectProviderError } from "./error-detect";

function formatCliFailure(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  return stdout || "no output";
}

export const piInference = {
  async run(options, deps) {
    const model = options.model ?? DEFAULT_PI_MODEL;
    const provider = piProviderForModel(model);
    if (!provider) {
      return {
        success: false,
        error: `Unsupported Pi model namespace: ${model}`,
        provider: "pi-cli",
      };
    }

    const args = [
      "-p",
      "--no-extensions",
      "--no-tools",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--offline",
      "--provider",
      provider,
      "--model",
      model,
      "--system-prompt",
      options.systemPrompt ?? "",
    ];

    const result = await deps.processRunner({
      command: "pi",
      args,
      stdin: options.userPrompt,
      timeout: options.timeout,
      env: {
        SHAKA_PI_SUBAGENT: "true",
        PI_TELEMETRY: "0",
        PI_OFFLINE: "1",
      },
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Pi CLI error: ${formatCliFailure(result)}`,
        provider: "pi-cli",
      };
    }

    const providerError = detectProviderError(result.stdout);
    if (providerError) {
      return {
        success: false,
        error: `Pi provider error (${providerError.code}): ${providerError.body}`,
        provider: "pi-cli",
      };
    }

    return parseResponse(result.stdout.trim(), options.expectJson, "pi-cli");
  },
} satisfies ProviderInference;
