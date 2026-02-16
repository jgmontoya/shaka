/**
 * CLI handler for `shaka update` command.
 *
 * Safe upgrade path using git tags as release points.
 * Checks latest tag BEFORE changing any files. Warns on major version bumps.
 *
 * Flow: git fetch --tags → find latest vX.Y.Z tag → compare → confirm if major
 *       → git checkout <tag> → bun install → shaka init
 */

import { createInterface } from "node:readline";
import { Command } from "commander";
import { ensureConfigComplete, loadConfig, resolveShakaHome } from "../domain/config";
import {
  compareSemver,
  findLatestTag,
  getCurrentVersion,
  isMajorUpgrade,
  parseSemver,
} from "../domain/version";
import { resolveFromModule } from "../platform/paths";
import { printOpencodeSummarizationHint } from "./hints";

interface UpdateInfo {
  localVersion: string;
  latestTag: string | null;
  latestVersion: string | null;
  isMajor: boolean;
}

async function run(args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  return { stdout: stdout.trim(), ok: exitCode === 0 };
}

function getRepoRoot(): string {
  // Resolve from this file's location — works regardless of cwd.
  // src/commands/update.ts → ../../ = repo root
  return resolveFromModule(import.meta.url, "../..");
}

async function checkForUpdate(repoRoot: string): Promise<UpdateInfo> {
  const localVersion = getCurrentVersion();

  // Fetch tags from remote
  const fetchResult = await run(["git", "fetch", "--tags"], repoRoot);
  if (!fetchResult.ok) {
    return { localVersion, latestTag: null, latestVersion: null, isMajor: false };
  }

  const latestTag = await findLatestTag(repoRoot);
  if (!latestTag) {
    return { localVersion, latestTag: null, latestVersion: null, isMajor: false };
  }

  const latestVersion = latestTag.startsWith("v") ? latestTag.slice(1) : latestTag;

  return {
    localVersion,
    latestTag,
    latestVersion,
    isMajor: isMajorUpgrade(localVersion, latestVersion),
  };
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function confirmMajorUpgrade(info: UpdateInfo): Promise<boolean> {
  const remoteVer = parseSemver(info.latestVersion ?? "");
  const localVer = parseSemver(info.localVersion);
  const majorLabel = localVer && remoteVer ? `${localVer.major}.x → ${remoteVer.major}.x` : "";

  console.log(`⚠️  Major version upgrade (${majorLabel})`);
  console.log("   system/ will be updated. user/, memory/, and customizations/ are preserved.");
  console.log("   Review the changelog before upgrading.\n");

  const ok = await confirm("   Continue? [y/N] ");
  if (!ok) {
    console.log("\nUpgrade cancelled. Your installation is unchanged.");
  }
  return ok;
}

async function checkoutAndInit(repoRoot: string, tag: string): Promise<boolean> {
  console.log(`Updating to ${tag}...`);
  const mergeResult = await run(["git", "merge", "--ff-only", tag], repoRoot);
  if (!mergeResult.ok) {
    console.error(
      "ERROR: Fast-forward to tag failed. You may have local commits ahead of the tag.",
    );
    console.error("       Stash or commit your changes, then retry.");
    return false;
  }

  console.log("Installing dependencies...");
  const installResult = await run(["bun", "install"], repoRoot);
  if (!installResult.ok) {
    console.error("ERROR: bun install failed.");
    return false;
  }

  console.log("Re-initializing...\n");

  // Backfill missing config fields (e.g., permissions added in v0.4.0)
  await ensureConfigComplete(resolveShakaHome());

  // Read config to determine which providers the user originally selected
  const config = await loadConfig();
  const args = ["--defaults"]; // Skip name prompts — names are already in config.json

  if (config?.providers.claude.enabled) args.push("--claude");
  if (config?.providers.opencode.enabled) args.push("--opencode");

  // No providers enabled — config exists but is stale or from before provider tracking
  if (!config?.providers.claude.enabled && !config?.providers.opencode.enabled) {
    console.log("⚠️  No providers enabled in config.json.");
    console.log(
      "   Run `shaka init` to select providers, or `shaka doctor --fix` to auto-detect.\n",
    );
    return false;
  }

  const { createInitCommand } = await import("./init");
  const initCmd = createInitCommand();
  await initCmd.parseAsync(args, { from: "user" });
  return true;
}

export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update Shaka to the latest stable release")
    .option("--force", "Skip major version confirmation")
    .action(async (options) => {
      const repoRoot = getRepoRoot();

      console.log("Checking for updates...\n");
      const info = await checkForUpdate(repoRoot);

      if (!info.latestTag || !info.latestVersion) {
        console.error("ERROR: No release tags found. Check your git remote.");
        process.exit(1);
      }

      if (compareSemver(info.localVersion, info.latestVersion) >= 0) {
        console.log(`Already up to date (v${info.localVersion}).`);
        return;
      }

      console.log(`  Current: v${info.localVersion}`);
      console.log(`  Latest:  v${info.latestVersion} (${info.latestTag})\n`);

      if (info.isMajor && !options.force) {
        const confirmed = await confirmMajorUpgrade(info);
        if (!confirmed) return;
        console.log();
      }

      const success = await checkoutAndInit(repoRoot, info.latestTag);
      if (!success) process.exit(1);

      console.log(`\n✅ Shaka updated: v${info.localVersion} → v${info.latestVersion}`);

      const shakaHome = resolveShakaHome({
        SHAKA_HOME: process.env.SHAKA_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      });
      await printOpencodeSummarizationHint(shakaHome);
    });
}
