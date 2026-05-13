import { parseResponse } from "../inference-response";
import type { ProviderInference } from "../types";
import { buildClaudeCliEnv } from "./env";

function formatCliFailure(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  return stdout || "no output";
}

export const claudeInference = {
  async run(options, deps) {
    const args = ["--setting-sources", "", "--tools", "", "--no-session-persistence"];
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    args.push("-p");

    const result = await deps.processRunner({
      command: "claude",
      args,
      stdin: options.userPrompt,
      timeout: options.timeout,
      env: buildClaudeCliEnv(),
    });

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `Claude CLI error: ${formatCliFailure(result)}`,
        provider: "claude-cli",
      };
    }

    return parseResponse(result.stdout.trim(), options.expectJson, "claude-cli");
  },
} satisfies ProviderInference;
