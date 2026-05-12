/**
 * Init service for `shaka init` command.
 *
 * Creates user-owned directories, symlinks system/ to the repo's defaults,
 * copies user templates (per-file, never overwrites), links the shaka library,
 * and tracks the installed version.
 */

import { lstat, mkdir, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Eta } from "eta";
import { type Result, err, ok } from "../domain/result";
import { getCurrentVersion } from "../domain/version";
import { readSymlinkTarget, removeLink, resolveFromModule } from "../platform/paths";
import { getProviderNames } from "../providers/registry";
import type { ProviderName } from "../providers/types";
import { type DetectedProviders, detectInstalledProviders } from "./provider-detection";

// Resolve defaults directory relative to this module
const DEFAULT_DEFAULTS_PATH = resolveFromModule(import.meta.url, "../../defaults");
const DEFAULT_REPO_ROOT = resolveFromModule(import.meta.url, "../..");

export interface InitServiceConfig {
  shakaHome: string;
  /** Path to defaults directory (for testing) */
  defaultsPath?: string;
  /** Path to repo root (for bun link; for testing) */
  repoRoot?: string;
  /** Override provider detection (for testing) */
  detectProviders?: () => DetectedProviders | Promise<DetectedProviders>;
  /** Override bun link execution (for testing) */
  runBunLink?: (cwd: string, args: string[]) => Promise<Result<void, Error>>;
}

export interface Personalization {
  principalName: string;
  assistantName: string;
}

export interface InitOptions {
  /** Specific providers to install. If empty/undefined, installs all detected. */
  providers?: ProviderName[];
  force?: boolean;
  /** User and assistant names for template rendering and config. */
  personalization?: Personalization;
}

export interface InitResult {
  providers: Record<ProviderName, { detected: boolean; installed: boolean }>;
  directories: string[];
  files: string[];
  symlinks: string[];
  currentVersion: string;
}

/** Default bun link runner using Bun.spawn. */
async function defaultRunBunLink(cwd: string, args: string[]): Promise<Result<void, Error>> {
  try {
    const proc = Bun.spawn(["bun", "link", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return err(
        new Error(`bun link ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`),
      );
    }
    return ok(undefined);
  } catch (e) {
    return err(new Error(`bun link failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

export class InitService {
  private readonly shakaHome: string;
  private readonly defaultsPath: string;
  private readonly repoRoot: string;
  private readonly detectProviders: () => DetectedProviders | Promise<DetectedProviders>;
  private readonly runBunLink: (cwd: string, args: string[]) => Promise<Result<void, Error>>;

  constructor(config: InitServiceConfig) {
    this.shakaHome = config.shakaHome;
    this.defaultsPath = config.defaultsPath ?? DEFAULT_DEFAULTS_PATH;
    this.repoRoot = config.repoRoot ?? DEFAULT_REPO_ROOT;
    this.detectProviders = config.detectProviders ?? detectInstalledProviders;
    this.runBunLink = config.runBunLink ?? defaultRunBunLink;
  }

  /**
   * Create user-owned directories (never replaced on upgrade).
   * system/ is handled separately via symlink.
   */
  async createDirectories(): Promise<Result<string[], Error>> {
    const directories = [
      this.shakaHome,
      join(this.shakaHome, "user"),
      join(this.shakaHome, "memory"),
      join(this.shakaHome, "customizations"),
      join(this.shakaHome, "customizations", "commands"),
    ];

    for (const dir of directories) {
      try {
        await mkdir(dir, { recursive: true });
      } catch (e) {
        return err(
          new Error(
            `Failed to create directory '${dir}': ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    }

    return ok(directories);
  }

  /**
   * Create symlink: ~/.config/shaka/system → <repo>/defaults/system
   *
   * Handles four cases:
   * 1. No system/ exists → create symlink
   * 2. system/ is already a correct symlink → no-op
   * 3. system/ is a symlink to wrong target → replace
   * 4. system/ is a real directory → error (user must resolve manually)
   */
  async linkSystem(): Promise<Result<string[], Error>> {
    const linkPath = join(this.shakaHome, "system");
    const target = join(this.defaultsPath, "system");
    const symlinks: string[] = [];

    try {
      let exists = false;

      try {
        await lstat(linkPath);
        exists = true;
      } catch {
        // Does not exist — will create
      }

      if (exists) {
        // readlink works for both symlinks and Windows junctions
        const currentTarget = await readSymlinkTarget(linkPath);
        if (currentTarget === null) {
          // Real directory — not a symlink/junction
          return err(
            new Error(
              `${linkPath} exists as a real directory. Move any custom files to customizations/ and remove system/, then re-run init.`,
            ),
          );
        }
        if (resolve(currentTarget) === resolve(target)) {
          // Already correct
          return ok(symlinks);
        }
        // Wrong target — remove and re-create
        await removeLink(linkPath);
      }

      // "junction" requires no elevated privileges on Windows; ignored on Unix
      await symlink(target, linkPath, "junction");
      symlinks.push(`${linkPath} → ${target}`);

      return ok(symlinks);
    } catch (e) {
      return err(
        new Error(`Failed to link system/: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * Copy user templates from defaults/user/ to shakaHome/user/.
   * Copies each file individually. Never overwrites existing files.
   * Files ending in .eta are rendered with Eta before writing (extension stripped).
   * This means new templates added in future versions get deployed
   * to existing installations.
   */
  async copyUserTemplates(personalization?: Personalization): Promise<Result<string[], Error>> {
    const sourceDir = join(this.defaultsPath, "user");
    const targetDir = join(this.shakaHome, "user");

    let entries: string[];
    try {
      entries = await readdir(sourceDir);
    } catch {
      return ok([]);
    }

    const eta = new Eta({ autoEscape: false });
    const templateData = {
      principalName: personalization?.principalName ?? "Chief",
      assistantName: personalization?.assistantName ?? "Shaka",
    };

    try {
      const files = await this.renderAndCopyTemplates(
        entries,
        sourceDir,
        targetDir,
        eta,
        templateData,
      );
      return ok(files);
    } catch (e) {
      return err(
        new Error(`Failed to copy user templates: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  private async renderAndCopyTemplates(
    entries: string[],
    sourceDir: string,
    targetDir: string,
    eta: Eta,
    templateData: Record<string, string>,
  ): Promise<string[]> {
    const files: string[] = [];

    for (const entry of entries) {
      const isTemplate = entry.endsWith(".eta");
      const outputName = isTemplate ? entry.slice(0, -4) : entry;
      const targetPath = join(targetDir, outputName);

      if (await Bun.file(targetPath).exists()) {
        continue;
      }

      const sourceFile = Bun.file(join(sourceDir, entry));
      if (await sourceFile.exists()) {
        const raw = await sourceFile.text();
        const content = isTemplate ? eta.renderString(raw, templateData) : raw;
        await Bun.write(targetPath, content);
        files.push(targetPath);
      }
    }

    return files;
  }

  /**
   * Copy default config.json if it doesn't exist.
   * When personalization is provided, updates names in the config (existing or new).
   */
  async copyDefaultConfig(personalization?: Personalization): Promise<Result<string[], Error>> {
    const files: string[] = [];
    const configPath = join(this.shakaHome, "config.json");
    const configFile = Bun.file(configPath);

    if (!(await configFile.exists())) {
      const defaultConfigPath = join(this.defaultsPath, "config.json");
      const defaultConfig = Bun.file(defaultConfigPath);

      if (!(await defaultConfig.exists())) {
        return err(new Error(`Default config not found at ${defaultConfigPath}`));
      }

      if (personalization) {
        const config = await defaultConfig.json();
        config.principal.name = personalization.principalName;
        config.assistant.name = personalization.assistantName;
        await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
      } else {
        const content = await defaultConfig.text();
        await Bun.write(configPath, content);
      }

      files.push(configPath);
    } else if (personalization) {
      // Config exists — update names if personalization provided
      const config = await configFile.json();
      config.principal.name = personalization.principalName;
      config.assistant.name = personalization.assistantName;
      await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    return ok(files);
  }

  /**
   * Update provider enabled flags in config.json.
   * Persists the user's provider selection so `shaka update` can re-use it.
   */
  async updateConfigProviders(providers: ProviderName[]): Promise<Result<void, Error>> {
    const configPath = join(this.shakaHome, "config.json");
    const file = Bun.file(configPath);

    if (!(await file.exists())) return ok(undefined);

    try {
      const config = await file.json();
      if (config.providers) {
        for (const name of getProviderNames()) {
          config.providers[name] = {
            ...config.providers[name],
            enabled: providers.includes(name),
          };
        }
        await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
      }
      return ok(undefined);
    } catch (e) {
      return err(
        new Error(
          `Failed to update config providers: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  /**
   * Link the shaka library so hooks can `import from "shaka"`.
   *
   * Step 1: `bun link` from repo root — registers package globally
   * Step 2: `bun link shaka` from shakaHome — creates node_modules/shaka symlink
   */
  async linkLibrary(): Promise<Result<void, Error>> {
    // Step 1: Register globally
    const registerResult = await this.runBunLink(this.repoRoot, []);
    if (!registerResult.ok) return registerResult;

    // Step 2: Link at shakaHome
    const linkResult = await this.runBunLink(this.shakaHome, ["shaka"]);
    if (!linkResult.ok) return linkResult;

    return ok(undefined);
  }

  /**
   * Determine which providers to install based on selection and detection.
   */
  private resolveProviders(
    selected: ProviderName[] | undefined,
    detected: DetectedProviders,
  ): ProviderName[] {
    if (selected && selected.length > 0) {
      return selected.filter((p) => detected[p]);
    }
    return getProviderNames().filter((name) => detected[name]);
  }

  /**
   * Run full initialization.
   */
  async init(options: InitOptions = {}): Promise<Result<InitResult, Error>> {
    const detected = await this.detectProviders();
    const currentVersion = getCurrentVersion();

    const toInstall = this.resolveProviders(options.providers, detected);

    if (toInstall.length === 0) {
      return err(
        new Error("No AI providers detected. Install Claude Code, opencode, Codex, or Pi first."),
      );
    }

    // 1. Create user-owned directories
    const directories = await this.createDirectories();
    if (!directories.ok) return directories;

    // 2. Symlink system/ → defaults/system
    const symlinks = await this.linkSystem();
    if (!symlinks.ok) return symlinks;

    // 3. Link library for import resolution
    const linkResult = await this.linkLibrary();
    if (!linkResult.ok) {
      return err(new Error(`Library link failed: ${linkResult.error.message}`));
    }

    // 4. Copy user templates (per-file, no overwrite, render .eta with names)
    const userFiles = await this.copyUserTemplates(options.personalization);
    if (!userFiles.ok) return userFiles;

    // 5. Copy config.json (no overwrite, inject names if provided)
    const configFiles = await this.copyDefaultConfig(options.personalization);
    if (!configFiles.ok) return configFiles;

    // 6. Persist provider selection to config.json
    await this.updateConfigProviders(toInstall);

    const providerResult = {} as InitResult["providers"];
    for (const name of getProviderNames()) {
      providerResult[name] = {
        detected: detected[name],
        installed: toInstall.includes(name),
      };
    }

    const result: InitResult = {
      providers: providerResult,
      directories: directories.value,
      files: [...userFiles.value, ...configFiles.value],
      symlinks: symlinks.value,
      currentVersion,
    };

    return ok(result);
  }
}
