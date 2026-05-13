/**
 * Provider-agnostic agent execution for workflow steps.
 *
 * Unlike inference.ts which disables tools and hooks (pure text inference),
 * this module runs the AI CLI with tools enabled and hooks active —
 * the agent can read/write files, run commands, etc.
 *
 * Provider-specific argv, model handling, and output quirks live in
 * `src/providers/<provider>/agent.ts`; this file only chooses the first
 * available provider and calls its agent execution capability.
 */

import { runProcess } from "../platform/process-runner";
import { getInstalledProviderModules, getProviderNames } from "../providers/registry";
import {
  type DetectedProviders,
  type ProviderName,
  detectInstalledProviders,
} from "../services/provider-detection";

export interface AgentExecutionOptions {
  readonly prompt: string;
  readonly timeout?: number;
  /** Working directory forwarded to the provider CLI subprocess. */
  readonly cwd?: string;
  /** Optional model hint consumed by providers that support model selection. */
  readonly model?: string;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The provider that executed the step, or null when none were available. */
  readonly provider: ProviderName | null;
  /** True iff the internal timeout fired before the subprocess exited. */
  readonly timedOut: boolean;
}

/**
 * Run an agent step using the first available provider CLI.
 *
 * `detected` is injectable so tests can pass a fake provider set without
 * monkey-patching `Bun.which`. Production callers omit it and get live
 * detection via `detectInstalledProviders()`.
 */
export async function runAgentStep(
  options: AgentExecutionOptions,
  detected: DetectedProviders = detectInstalledProviders(),
): Promise<AgentExecutionResult> {
  const provider = getInstalledProviderModules(detected)[0];
  if (provider) {
    return provider.agentExecution.run(options, { processRunner: runProcess });
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `No agent provider available. Install ${getProviderNames().join(", ")} CLI.`,
    provider: null,
    timedOut: false,
  };
}
