import { runAgentProcess } from "../agent-runner";
import type { ProviderAgentExecution } from "../types";
import { buildClaudeCliEnv } from "./env";

export const claudeAgentExecution = {
  run(options, deps) {
    return runAgentProcess(
      "claude",
      {
        command: "claude",
        args: ["-p"],
        stdin: options.prompt,
        env: buildClaudeCliEnv(),
      },
      options,
      deps,
    );
  },
} satisfies ProviderAgentExecution;
