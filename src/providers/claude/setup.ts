import { DEFAULT_SETUP_TIMEOUT_MS } from "../setup-defaults";
import type { ProviderSetupSession } from "../types";
import { claudeAgentExecution } from "./agent";

export const claudeSetupSession = {
  buildInteractiveArgs({ objective, skillBody }) {
    return ["claude", objective, "--append-system-prompt", skillBody];
  },
  async runOneshot({ worktreePath, prompt }, deps) {
    const result = await claudeAgentExecution.run(
      {
        prompt,
        cwd: worktreePath,
        timeout: DEFAULT_SETUP_TIMEOUT_MS,
      },
      deps,
    );
    return {
      exitCode: result.exitCode,
      provider: "claude",
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  },
} satisfies ProviderSetupSession;
