/**
 * Provider abstraction for Claude Code and opencode.
 * Each provider implements this interface to handle installation.
 */

import type { Result } from "../domain/result";
import type { DiscoveredCommand } from "./command-discovery";
import type { CommandManifest } from "./command-manifest";

export type ProviderName = "claude" | "opencode" | "codex";

export interface ProviderConfigurer {
  readonly name: ProviderName;

  /** Human-readable label (e.g., "Claude Code", "opencode", "Codex") */
  readonly label: string;

  /** Absolute path to this provider's skills directory */
  readonly skillsDir: string;

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
