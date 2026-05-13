import { DEFAULT_SETUP_TIMEOUT_MS } from "../setup-defaults";
import type { ProviderSetupSession } from "../types";
import { OPENCODE_AUTORESEARCH_SETUP_AGENT } from "./agents";

export const opencodeSetupSession = {
  buildInteractiveArgs({ objective, worktreePath }) {
    return [
      "opencode",
      ...(worktreePath ? [worktreePath] : []),
      "--prompt",
      objective,
      "--agent",
      OPENCODE_AUTORESEARCH_SETUP_AGENT,
    ];
  },
  async runOneshot({ worktreePath, prompt }, deps) {
    const result = await deps.processRunner({
      command: "opencode",
      args: [
        "run",
        "--dir",
        worktreePath,
        "--agent",
        OPENCODE_AUTORESEARCH_SETUP_AGENT,
        "--",
        prompt,
      ],
      cwd: worktreePath,
      timeout: DEFAULT_SETUP_TIMEOUT_MS,
    });
    return {
      exitCode: result.exitCode,
      provider: "opencode",
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
    };
  },
} satisfies ProviderSetupSession;
