import type { AgentExecutionResult } from "../../domain/agent-execution";
import { runAgentProcess } from "../agent-runner";
import type { ProviderAgentExecution } from "../types";
import { DEFAULT_PI_MODEL, piProviderForModel } from "./defaults";
import { detectProviderError } from "./error-detect";

export const piAgentExecution = {
  async run(options, deps): Promise<AgentExecutionResult> {
    const model = options.model ?? DEFAULT_PI_MODEL;
    const provider = piProviderForModel(model);
    if (!provider) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Unsupported Pi model namespace: ${model}`,
        provider: "pi",
        timedOut: false,
      };
    }

    const result = await runAgentProcess(
      "pi",
      {
        command: "pi",
        args: ["-p", "--provider", provider, "--model", model],
        stdin: options.prompt,
      },
      options,
      deps,
    );

    if (result.exitCode !== 0) return result;

    const providerError = detectProviderError(result.stdout);
    if (!providerError) return result;

    return {
      ...result,
      exitCode: providerError.code,
      stderr: result.stderr ? `${result.stderr}\n${providerError.body}` : providerError.body,
    };
  },
} satisfies ProviderAgentExecution;
