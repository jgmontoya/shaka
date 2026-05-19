import type { ProviderModule } from "../types";
import { piAgentExecution } from "./agent";
import { PiProviderConfigurer } from "./configurer";
import { piInference } from "./inference";
import { piSetupSession } from "./setup";

export const piProvider = {
  metadata: {
    name: "pi",
    label: "Pi",
    executable: "pi",
    priority: 3,
  },
  agentExecution: piAgentExecution,
  inference: piInference,
  setupSession: piSetupSession,
  createConfigurer: () => new PiProviderConfigurer(),
} satisfies ProviderModule;
