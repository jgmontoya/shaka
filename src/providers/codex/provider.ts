import type { ProviderModule } from "../types";
import { codexAgentExecution } from "./agent";
import { CodexProviderConfigurer } from "./configurer";
import { codexInference } from "./inference";
import { codexSetupSession } from "./setup";

export const codexProvider = {
  metadata: {
    name: "codex",
    label: "Codex",
    executable: "codex",
    priority: 2,
  },
  agentExecution: codexAgentExecution,
  inference: codexInference,
  setupSession: codexSetupSession,
  createConfigurer: () => new CodexProviderConfigurer(),
} satisfies ProviderModule;
