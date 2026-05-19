import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResponse } from "../inference-response";
import type { ProviderInference } from "../types";

function formatCliFailure(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  return stdout || "no output";
}

export const codexInference = {
  async run(options, deps) {
    const tmpOutput = join(tmpdir(), `.shaka-codex-inference-${process.pid}-${randomUUID()}.txt`);
    try {
      const args = [
        "exec",
        "--disable",
        "hooks",
        "--ephemeral",
        "--skip-git-repo-check",
        "-c",
        'sandbox="read-only"',
      ];
      if (options.model) args.push("-m", options.model);
      const prompt = options.systemPrompt
        ? `${options.systemPrompt}\n\n${options.userPrompt}`
        : options.userPrompt;
      args.push("-o", tmpOutput, prompt);

      const result = await deps.processRunner({
        command: "codex",
        args,
        stdin: "",
        timeout: options.timeout,
      });

      if (result.exitCode !== 0) {
        return {
          success: false,
          error: `Codex CLI error: ${formatCliFailure(result)}`,
          provider: "codex-cli",
        };
      }

      const outputFile = Bun.file(tmpOutput);
      if (!(await outputFile.exists())) {
        return {
          success: false,
          error: "Codex CLI produced no output file",
          provider: "codex-cli",
        };
      }
      const text = await outputFile.text();
      return parseResponse(text.trim(), options.expectJson, "codex-cli");
    } finally {
      await unlink(tmpOutput).catch(() => {});
    }
  },
} satisfies ProviderInference;
