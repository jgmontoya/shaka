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
import { type Result, err, ok } from "../domain/result";
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
  /**
   * Scope the uninstall to a subset of providers. When omitted, runs the
   * full teardown (every provider + framework files + symlinks). When
   * provided, only the named providers are uninstalled — framework files,
   * system/ symlink, and user data are left untouched.
   */
  only?: readonly ProviderName[];
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
  async uninstallProviders(only?: readonly ProviderName[]): Promise<UninstallResult["providers"]> {
    const detected = await this.detectProviders();
    const result = {} as UninstallResult["providers"];
    // Empty array is truthy in JS — normalize so `only:[]` means "no scope"
    // (full teardown) rather than "scope to nothing" (silent no-op).
    const scope = only && only.length > 0 ? new Set(only) : null;

    for (const name of getProviderNames()) {
      result[name] = { detected: detected[name], uninstalled: false };
      if (!detected[name]) continue;
      if (scope && !scope.has(name)) continue;

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
    // Normalize `only:[]` to "no scope" (see uninstallProviders for why).
    const scopedOnly = options.only && options.only.length > 0 ? options.only : undefined;

    if (scopedOnly && options.deleteUserData) {
      return err(
        new Error(
          "per-provider uninstall cannot be combined with --delete-data; user data belongs to the whole install, not one provider",
        ),
      );
    }

    if (scopedOnly) return this.uninstallScoped(scopedOnly);
    return this.uninstallFull(options);
  }

  /**
   * Per-provider scope: remove just the named providers' artifacts.
   * Framework files (`system/`, `config.json`, `node_modules`) and user
   * data belong to the install as a whole, so they're untouched here.
   */
  private async uninstallScoped(
    scopedOnly: readonly ProviderName[],
  ): Promise<Result<UninstallResult, Error>> {
    const providers = await this.uninstallProviders(scopedOnly);
    const errors = scopedOnly
      .filter((name) => providers[name].detected && !providers[name].uninstalled)
      .map((name) => `Failed to uninstall ${name} configuration`);
    // Return err so the CLI exits non-zero. The full-uninstall path leaves
    // these in `errors` (alongside framework cleanup) — there's value in a
    // partial success there. For scoped, "remove THIS provider" either
    // worked or it didn't.
    if (errors.length > 0) {
      return err(new Error(errors.join("; ")));
    }
    return ok({ providers, removed: [], errors });
  }

  private async uninstallFull(options: UninstallOptions): Promise<Result<UninstallResult, Error>> {
    const removed: string[] = [];
    const errors: string[] = [];

    // 1. Uninstall provider configuration (full set).
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
