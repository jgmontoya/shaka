import { runAgentProcess } from "../agent-runner";
import type { ProviderAgentExecution } from "../types";

export const opencodeAgentExecution = {
  run(options, deps) {
    const args = ["run"];
    if (options.cwd) args.push("--dir", options.cwd);
    args.push("--", options.prompt);
    return runAgentProcess(
      "opencode",
      {
        command: "opencode",
        args,
        stdin: "",
      },
      options,
      deps,
    );
  },
} satisfies ProviderAgentExecution;
