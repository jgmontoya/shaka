import { DEFAULT_SETUP_TIMEOUT_MS } from "../setup-defaults";
import type { ProviderSetupSession } from "../types";
import { codexAgentExecution } from "./agent";

export const codexSetupSession = {
  buildInteractiveArgs({ objective, skillBody }) {
    return ["codex", `${skillBody}\n\n## Objective\n\n${objective}`];
  },
  async runOneshot({ worktreePath, prompt }, deps) {
    const result = await codexAgentExecution.run(
      {
        prompt,
        cwd: worktreePath,
        timeout: DEFAULT_SETUP_TIMEOUT_MS,
      },
      deps,
    );
    return {
      exitCode: result.exitCode,
      provider: "codex",
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  },
} satisfies ProviderSetupSession;
