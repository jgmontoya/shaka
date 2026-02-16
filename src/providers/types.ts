/**
 * Provider abstraction for Claude Code and opencode.
 * Each provider implements this interface to handle installation.
 */

import type { Result } from "../domain/result";

export type ProviderName = "claude" | "opencode";

export interface ProviderConfigurer {
  readonly name: ProviderName;

  /** Check if provider CLI is installed */
  isInstalled(): boolean;

  /** Install Shaka hooks, agents, and skills for this provider */
  install(config: InstallConfig): Promise<Result<void, Error>>;

  /** Uninstall Shaka hooks, agents, and skills */
  uninstall(config: InstallConfig): Promise<Result<void, Error>>;

  /** Check installation status: hooks, agents, skills */
  checkInstallation(config: InstallConfig): Promise<InstallationStatus>;
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
}
