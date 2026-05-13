import type { ProviderModule } from "../types";
import { opencodeAgentExecution } from "./agent";
import { OpencodeProviderConfigurer } from "./configurer";
import { opencodeInference } from "./inference";
import { opencodeSetupSession } from "./setup";

export const opencodeProvider = {
  metadata: {
    name: "opencode",
    label: "opencode",
    executable: "opencode",
    priority: 1,
  },
  agentExecution: opencodeAgentExecution,
  inference: opencodeInference,
  setupSession: opencodeSetupSession,
  createConfigurer: () => new OpencodeProviderConfigurer(),
} satisfies ProviderModule;
