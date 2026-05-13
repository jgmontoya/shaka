import type { ProviderModule } from "../types";
import { claudeAgentExecution } from "./agent";
import { ClaudeProviderConfigurer } from "./configurer";
import { claudeInference } from "./inference";
import { claudeSetupSession } from "./setup";

export const claudeProvider = {
  metadata: {
    name: "claude",
    label: "Claude Code",
    executable: "claude",
    priority: 0,
  },
  agentExecution: claudeAgentExecution,
  inference: claudeInference,
  setupSession: claudeSetupSession,
  createConfigurer: () => new ClaudeProviderConfigurer(),
} satisfies ProviderModule;
