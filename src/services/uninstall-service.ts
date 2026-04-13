/**
 * Uninstall service for `shaka uninstall` command.
 *
 * Reverses what `shaka init` does:
 * - Removes provider hooks (Claude settings.json entries, opencode plugin)
 * - Removes system/ symlink
 * - Removes config.json
 * - Optionally removes user-owned directories (user/, customizations/, memory/)
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Result, ok } from "../domain/result";
import { readSymlinkTarget, removeLink } from "../platform/paths";
import { createProvider, getProviderNames } from "../providers/registry";
import type { ProviderName } from "../providers/types";
import { type DetectedProviders, detectInstalledProviders } from "./provider-detection";

export interface UninstallServiceConfig {
  shakaHome: string;
  /** Override provider detection (for testing) */
  detectProviders?: () => DetectedProviders | Promise<DetectedProviders>;
}

export interface UninstallOptions {
  /** Delete user-owned directories (user/, customizations/, memory/) */
  deleteUserData: boolean;
}

export interface UninstallResult {
  providers: Record<ProviderName, { detected: boolean; uninstalled: boolean }>;
  removed: string[];
  errors: string[];
}

export class UninstallService {
  private readonly shakaHome: string;
  private readonly detectProviders: () => DetectedProviders | Promise<DetectedProviders>;

  constructor(config: UninstallServiceConfig) {
    this.shakaHome = config.shakaHome;
    this.detectProviders = config.detectProviders ?? detectInstalledProviders;
  }

  /**
   * Uninstall provider configuration (hooks, agents, skills) via each provider's uninstall().
   */
  async uninstallProviders(): Promise<UninstallResult["providers"]> {
    const detected = await this.detectProviders();
    const result = {} as UninstallResult["providers"];

    for (const name of getProviderNames()) {
      result[name] = { detected: detected[name], uninstalled: false };
      if (!detected[name]) continue;

      const provider = createProvider(name);
      const uninstallResult = await provider.uninstall({ shakaHome: this.shakaHome });
      result[name].uninstalled = uninstallResult.ok;
      await provider.unregisterMcpServer?.();
    }

    return result;
  }

  /**
   * Remove system/ symlink (only if it's a symlink, never delete a real directory).
   */
  async removeSystemLink(): Promise<Result<boolean, Error>> {
    const linkPath = join(this.shakaHome, "system");

    // readlink works for both symlinks and Windows junctions
    const target = await readSymlinkTarget(linkPath);
    if (target !== null) {
      await removeLink(linkPath);
      return ok(true);
    }
    // Real directory or doesn't exist — don't touch it
    return ok(false);
  }

  /**
   * Remove framework-owned files (config.json).
   */
  async removeFrameworkFiles(): Promise<string[]> {
    const removed: string[] = [];
    const files = [
      join(this.shakaHome, "config.json"),
      join(this.shakaHome, "commands-manifest.json"),
    ];

    for (const filePath of files) {
      try {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          await rm(filePath);
          removed.push(filePath);
        }
      } catch {
        // Best-effort — continue on failure
      }
    }

    return removed;
  }

  /**
   * Remove node_modules/ link at shakaHome (created by bun link shaka).
   */
  async removeNodeModulesLink(): Promise<boolean> {
    const nmPath = join(this.shakaHome, "node_modules");
    try {
      await rm(nmPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove user-owned directories (user/, customizations/, memory/).
   */
  async removeUserData(): Promise<string[]> {
    const removed: string[] = [];
    const dirs = ["user", "customizations", "memory"];

    for (const dir of dirs) {
      const dirPath = join(this.shakaHome, dir);
      try {
        const stats = await lstat(dirPath);
        if (stats.isDirectory()) {
          await rm(dirPath, { recursive: true });
          removed.push(dirPath);
        }
      } catch {
        // Doesn't exist — skip
      }
    }

    return removed;
  }

  /**
   * Remove shakaHome directory if it's empty.
   */
  async removeShakaHomeIfEmpty(): Promise<boolean> {
    try {
      const entries = await readdir(this.shakaHome);
      if (entries.length === 0) {
        await rm(this.shakaHome, { recursive: true });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Run full uninstallation.
   */
  async uninstall(options: UninstallOptions): Promise<Result<UninstallResult, Error>> {
    const removed: string[] = [];
    const errors: string[] = [];

    // 1. Uninstall provider configuration
    const providers = await this.uninstallProviders();

    for (const name of getProviderNames()) {
      if (providers[name].detected && !providers[name].uninstalled) {
        errors.push(`Failed to uninstall ${name} configuration`);
      }
    }

    // 2. Remove system/ symlink
    const symlinkResult = await this.removeSystemLink();
    if (symlinkResult.ok && symlinkResult.value) {
      removed.push(join(this.shakaHome, "system"));
    }

    // 3. Remove framework files
    const frameworkFiles = await this.removeFrameworkFiles();
    removed.push(...frameworkFiles);

    // 4. Remove node_modules link
    const nmRemoved = await this.removeNodeModulesLink();
    if (nmRemoved) {
      removed.push(join(this.shakaHome, "node_modules"));
    }

    // 5. Optionally remove user data
    if (options.deleteUserData) {
      const userDirs = await this.removeUserData();
      removed.push(...userDirs);
    }

    // 6. Clean up empty shakaHome
    const homeRemoved = await this.removeShakaHomeIfEmpty();
    if (homeRemoved) {
      removed.push(this.shakaHome);
    }

    return ok({ providers, removed, errors });
  }
}
