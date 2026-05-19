import { DEFAULT_SETUP_TIMEOUT_MS } from "../setup-defaults";
import type { ProviderSetupSession } from "../types";
import { piAgentExecution } from "./agent";
import { DEFAULT_PI_MODEL, DEFAULT_PI_PROVIDER } from "./defaults";

export const piSetupSession = {
  buildInteractiveArgs({ objective, skillBody }) {
    return [
      "pi",
      "--provider",
      DEFAULT_PI_PROVIDER,
      "--model",
      DEFAULT_PI_MODEL,
      "--append-system-prompt",
      skillBody,
      "--",
      objective,
    ];
  },
  async runOneshot({ worktreePath, prompt }, deps) {
    const result = await piAgentExecution.run(
      {
        prompt,
        cwd: worktreePath,
        timeout: DEFAULT_SETUP_TIMEOUT_MS,
      },
      deps,
    );
    return {
      exitCode: result.exitCode,
      provider: "pi",
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  },
} satisfies ProviderSetupSession;
