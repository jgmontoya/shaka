/**
 * CLI handler for `shaka skill` command group.
 *
 * Subcommands: install, remove, update, list.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import { loadManifest } from "../domain/skills-manifest";
import {
  InstallCancelledError,
  type SecurityReport,
  installSkill,
} from "../services/skill-install-service";
import { removeSkill } from "../services/skill-remove-service";
import { getProviderByName } from "../services/skill-source";
import { type UpdateResult, updateAllSkills, updateSkill } from "../services/skill-update-service";

function getShakaHome(): string {
  return resolveShakaHome({
    SHAKA_HOME: process.env.SHAKA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  });
}

export function createSkillCommand(): Command {
  const skill = new Command("skill").description("Manage installed skills");

  skill
    .command("install")
    .description("Install a skill (auto-detects source)")
    .argument("<source>", "Skill source (user/repo, URL, or clawhub slug)")
    .option("--yolo", "Skip security checks and install without confirmation", false)
    .option("--github", "Force GitHub provider")
    .option("--clawhub", "Force Clawhub provider")
    .option("--clawdhub", "Deprecated alias for --clawhub")
    .action(handleInstall);

  skill
    .command("remove")
    .description("Remove an installed skill")
    .argument("<name>", "Skill name")
    .action(handleRemove);

  skill
    .command("update")
    .description("Update one or all installed skills")
    .argument("[name]", "Skill name (omit to update all)")
    .action(handleUpdate);

  skill.command("list").description("List all skills (system + installed)").action(handleList);

  return skill;
}

async function handleInstall(
  source: string,
  opts: { yolo: boolean; github?: boolean; clawhub?: boolean; clawdhub?: boolean },
): Promise<void> {
  const shakaHome = getShakaHome();

  // Resolve provider override from flags
  const providerOverride = resolveProviderFlag(opts);
  if (providerOverride && !providerOverride.ok) {
    console.error(`\u2717 ${providerOverride.error.message}`);
    process.exit(1);
  }

  console.log(`Installing skill from ${source}...`);

  const result = await installSkill(shakaHome, source, {
    yolo: opts.yolo,
    provider: providerOverride?.ok ? providerOverride.value : undefined,
    selectSkill: async (skills) => {
      if (skills.length === 0) return null;

      console.log("\nMultiple skills found. Select one to install:");
      for (const [index, skill] of skills.entries()) {
        const details = skill.description ? ` - ${skill.description}` : "";
        console.log(`  ${index + 1}) ${skill.name}${details}`);
      }

      process.stdout.write("Choose a skill number (or press Enter to cancel): ");
      const answer = await readLine();
      if (!answer || answer.toLowerCase() === "n") return null;

      const selectedIndex = Number.parseInt(answer, 10);
      if (Number.isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > skills.length) {
        console.log("Invalid selection, installation cancelled.");
        return null;
      }

      return skills[selectedIndex - 1]?.name ?? null;
    },
    onSecurityCheck: async (report, skillName) => {
      console.log(formatSecurityReport(report));

      if (!report.allPassed) {
        console.log("\n\u{1F6A8}  Make sure to review it properly before installing.");
        console.log(
          `Run \`shaka skill install ${source} --yolo\` to skip checks and install anyway.`,
        );
        return false;
      }

      console.log(
        "\n\u2139\uFE0F  You should still review the skill and/or get them from trusted sources.",
      );
      process.stdout.write(`Install skill "${skillName}"? [Y/n] `);
      const answer = await readLine();
      return answer === "" || answer.toLowerCase() === "y";
    },
  });

  if (!result.ok) {
    if (!(result.error instanceof InstallCancelledError)) {
      console.error(`\n\u2717 ${result.error.message}`);
    }
    process.exit(1);
  }

  const ver = result.value.skill.version.slice(0, 7);
  console.log(`\n\u2713 Installed skill "${result.value.name}" (${ver})`);
}

async function handleRemove(name: string): Promise<void> {
  const shakaHome = getShakaHome();

  const result = await removeSkill(shakaHome, name);
  if (!result.ok) {
    console.error(`✗ ${result.error.message}`);
    process.exit(1);
  }

  console.log(`✓ Removed skill "${name}"`);
}

async function handleUpdate(name?: string): Promise<void> {
  const shakaHome = getShakaHome();

  if (name) {
    const result = await updateSkill(shakaHome, name);
    if (!result.ok) {
      console.error(`✗ ${result.error.message}`);
      process.exit(1);
    }
    printUpdateResult(result.value);
  } else {
    const result = await updateAllSkills(shakaHome);
    if (!result.ok) {
      console.error(`✗ ${result.error.message}`);
      process.exit(1);
    }
    const { results, failures } = result.value;
    if (results.length === 0 && failures.length === 0) {
      console.log("No installed skills to update.");
      return;
    }
    for (const r of results) {
      printUpdateResult(r);
    }
    for (const f of failures) {
      console.error(`  ✗ "${f.name}": ${f.error.message}`);
    }
    if (failures.length > 0) {
      process.exitCode = 1;
    }
  }
}

async function handleList(): Promise<void> {
  const shakaHome = getShakaHome();

  const systemSkills = await listSkillDirs(join(shakaHome, "system", "skills"));
  const manifest = await loadManifest(shakaHome);
  if (!manifest.ok) {
    console.error(`✗ ${manifest.error.message}`);
  }
  const installedSkills = manifest.ok ? Object.entries(manifest.value.skills) : [];

  if (systemSkills.length === 0 && installedSkills.length === 0) {
    console.log("No skills found.");
    return;
  }

  if (systemSkills.length > 0) {
    console.log("System skills:");
    for (const name of systemSkills) {
      console.log(`  ${name}`);
    }
  }

  if (installedSkills.length > 0) {
    if (systemSkills.length > 0) console.log("");
    console.log("Installed skills:");
    for (const [name, skill] of installedSkills) {
      const ver = skill.version.slice(0, 7);
      console.log(`  ${name}  (${skill.provider}: ${skill.source}, ${ver})`);
    }
  }
}

// --- Helpers ---

function resolveProviderFlag(opts: { github?: boolean; clawhub?: boolean; clawdhub?: boolean }) {
  const useClawhub = Boolean(opts.clawhub || opts.clawdhub);

  if (opts.github && useClawhub) {
    return { ok: false as const, error: new Error("Cannot use both --github and --clawhub") };
  }
  if (opts.github) return getProviderByName("github");
  if (useClawhub) return getProviderByName("clawhub");
  return null;
}

function printUpdateResult(r: UpdateResult): void {
  if (r.upToDate) {
    console.log(`  \u2713 "${r.name}" is up to date (${r.newVersion.slice(0, 7)})`);
  } else {
    const from = r.previousVersion.slice(0, 7);
    const to = r.newVersion.slice(0, 7);
    console.log(`  \u2713 Updated "${r.name}" (${from} \u2192 ${to})`);
    if (r.warnings?.length) {
      for (const w of r.warnings) {
        console.log(`    \u26A0  ${w}`);
      }
    }
  }
}

function formatSecurityReport(report: SecurityReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const status = check.passed ? "\u2705" : "\u274C";
    lines.push(`${check.emoji} ${check.label} ${status}`);
  }
  return lines.join("\n");
}

async function listSkillDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    const onData = (chunk: string | Buffer) => {
      clearTimeout(timeout);
      process.stdin.pause();
      resolve(chunk.toString().trim());
    };
    const timeout = setTimeout(() => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve("n");
    }, 30000);
    process.stdin.once("data", onData);
  });
}
