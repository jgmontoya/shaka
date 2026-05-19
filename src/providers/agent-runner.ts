import type { AgentExecutionOptions, AgentExecutionResult } from "../domain/agent-execution";
import type { ProcessInvocation } from "../platform/process-runner";
import type { ProviderName, ProviderRuntimeDeps } from "./types";

export async function runAgentProcess(
  provider: ProviderName,
  invocation: Omit<ProcessInvocation, "timeout" | "cwd">,
  options: AgentExecutionOptions,
  deps: ProviderRuntimeDeps,
): Promise<AgentExecutionResult> {
  const result = await deps.processRunner({
    ...invocation,
    cwd: options.cwd,
    timeout: options.timeout,
  });
  return { ...result, provider };
}
