/**
 * Provider abstractions for installed AI CLIs.
 * Each provider implements installation plus runtime capabilities.
 */

import type { AgentExecutionOptions, AgentExecutionResult } from "../domain/agent-execution";
import type { Result } from "../domain/result";
import type { InferenceOptions, InferenceResult } from "../inference";
import type { ProcessRunner } from "../platform/process-runner";
import type { DiscoveredCommand } from "./command-discovery";
import type { CommandManifest } from "./command-manifest";

export type ProviderName = "claude" | "opencode" | "codex" | "pi";

export interface ProviderMetadata {
  readonly name: ProviderName;
  readonly label: string;
  readonly executable: string;
  readonly priority: number;
}

export interface ProviderModule {
  readonly metadata: ProviderMetadata;
  readonly agentExecution: ProviderAgentExecution;
  readonly inference: ProviderInference;
  readonly setupSession: ProviderSetupSession;
  createConfigurer(): ProviderConfigurer;
}

export interface ProviderRuntimeDeps {
  readonly processRunner: ProcessRunner;
}

export interface ProviderAgentExecution {
  run(options: AgentExecutionOptions, deps: ProviderRuntimeDeps): Promise<AgentExecutionResult>;
}

export interface ProviderInference {
  run(options: InferenceOptions, deps: ProviderRuntimeDeps): Promise<InferenceResult>;
}

export interface SetupSessionInvocationInput {
  readonly objective: string;
  readonly skillBody: string;
  readonly worktreePath?: string;
}

export interface SetupOneshotInput {
  readonly worktreePath: string;
  readonly prompt: string;
}

export interface ProviderSetupSession {
  buildInteractiveArgs(input: SetupSessionInvocationInput): string[];
  runOneshot(
    input: SetupOneshotInput,
    deps: ProviderRuntimeDeps,
  ): Promise<{
    readonly exitCode: number;
    readonly provider: ProviderName;
    readonly stdout?: string;
    readonly stderr?: string;
  }>;
}

export interface ProviderCommandSupport {
  install(config: CommandInstallConfig): Promise<void>;
}

export interface ProviderHealthItem {
  readonly label: string;
  readonly ok: boolean;
  readonly issue?: string;
}

export interface ProviderConfigurer {
  readonly name: ProviderName;

  /** Human-readable label (e.g., "Claude Code", "opencode", "Codex") */
  readonly label: string;

  /** Absolute path to this provider's skills directory */
  readonly skillsDir: string;

  /** Provider-owned native command installation capability. */
  readonly commands: ProviderCommandSupport;

  /** Check if provider CLI is installed */
  isInstalled(): boolean;

  /** Install Shaka hooks, agents, skills for this provider (excludes commands) */
  install(config: InstallConfig): Promise<Result<void, Error>>;

  /** Install commands: clean old installs + write new ones. No discovery or manifest I/O. */
  installCommands(config: CommandInstallConfig): Promise<void>;

  /** Uninstall Shaka hooks, agents, skills, and commands */
  uninstall(config: InstallConfig): Promise<Result<void, Error>>;

  /** Check installation status: hooks, agents, skills, commands */
  checkInstallation(config: InstallConfig): Promise<InstallationStatus>;

  /** Provider-specific health checks that are not install-file checks. */
  checkHealth?(): ProviderHealthItem[];

  /** Register MCP server with this provider (e.g., `claude mcp add`, `codex mcp add`) */
  registerMcpServer?(): Promise<Result<void, Error>>;

  /** Unregister MCP server from this provider */
  unregisterMcpServer?(): Promise<Result<void, Error>>;
}

export interface CommandInstallConfig {
  /** Pre-discovered commands to install. */
  commands: DiscoveredCommand[];
  /** Current manifest for detecting pre-existing user files. */
  manifest: CommandManifest;
}

export type PermissionMode = "apply" | "merge" | "skip";

export interface InstallConfig {
  shakaHome: string;
  /** How to handle permissions. Default: merge (union-dedupe for Claude, apply-if-missing for opencode). */
  permissionMode?: PermissionMode;
}

export interface ComponentStatus {
  ok: boolean;
  issue?: string;
}

export interface InstallationStatus {
  hooks: ComponentStatus;
  agents: ComponentStatus;
  skills: ComponentStatus;
  commands: ComponentStatus;
  installedSkills: ComponentStatus;
}
