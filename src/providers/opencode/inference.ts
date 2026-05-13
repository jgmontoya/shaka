import { parseResponse } from "../inference-response";
import type { ProviderInference } from "../types";
import { OPENCODE_INFERENCE_AGENT } from "./agents";

export function parseOpencodeJsonStream(stdout: string): {
  sessionId: string | null;
  text: string;
} {
  const lines = stdout.split("\n");
  let sessionId: string | null = null;
  const textParts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (sessionId === null && evt.type === "step_start" && typeof evt.sessionID === "string") {
        sessionId = evt.sessionID;
      }
      if (evt.type === "text" && typeof evt.part?.text === "string") {
        textParts.push(evt.part.text);
      }
    } catch {
      // Skip malformed event lines; opencode output is best-effort.
    }
  }
  return { sessionId, text: textParts.join("") };
}

export const opencodeInference = {
  async run(options, deps) {
    const prompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${options.userPrompt}`
      : options.userPrompt;

    const args = ["run", "--pure", "--format", "json", "--agent", OPENCODE_INFERENCE_AGENT];
    if (options.model?.includes("/")) args.push("--model", options.model);
    args.push("--", prompt);

    const result = await deps.processRunner({
      command: "opencode",
      args,
      env: { SHAKA_OPENCODE_SUBAGENT: "true" },
      timeout: options.timeout,
    });

    const { sessionId, text } = parseOpencodeJsonStream(result.stdout);
    if (sessionId) {
      Bun.spawn(["opencode", "--pure", "session", "delete", sessionId], {
        env: { ...process.env, SHAKA_OPENCODE_SUBAGENT: "true" },
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
    }

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: `OpenCode CLI error: ${result.stderr}`,
        provider: "opencode-cli",
      };
    }

    return parseResponse(text, options.expectJson, "opencode-cli");
  },
} satisfies ProviderInference;
