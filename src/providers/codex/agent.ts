import { runAgentProcess } from "../agent-runner";
import type { ProviderAgentExecution } from "../types";

export const codexAgentExecution = {
  run(options, deps) {
    const bypass = process.env.SHAKA_CODEX_BYPASS_SANDBOX === "1";
    const sandboxFlag = bypass ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto";
    return runAgentProcess(
      "codex",
      {
        command: "codex",
        args: ["exec", sandboxFlag, "-"],
        stdin: options.prompt,
      },
      options,
      deps,
    );
  },
} satisfies ProviderAgentExecution;
