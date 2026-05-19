import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../domain/config";
import {
  type CompiledCommand,
  applyOverrides,
  autoAppendArguments,
  buildFrontmatter,
  replaceArgsWithNaturalLanguage,
} from "../command-compiler";
import { type DiscoveredCommand, discoverCommands } from "../command-discovery";
import { checkCommandHealth } from "../command-health";
import {
  type CommandManifest,
  assertValidCommandManifest,
  readManifest,
} from "../command-manifest";
import type { CommandInstallConfig, ComponentStatus, InstallConfig } from "../types";

export function compileCodexCommand(
  command: DiscoveredCommand,
  targetDir: string,
): CompiledCommand {
  const fields = applyOverrides(command, "codex");
  const rawBody = autoAppendArguments(command.body);
  const body = replaceArgsWithNaturalLanguage(rawBody);

  const description = fields.argumentHint
    ? `${fields.description}. Invoke with $${command.name} ${fields.argumentHint}`
    : fields.description;

  const frontmatter = buildFrontmatter({
    name: command.name,
    description,
  });

  return {
    path: join(targetDir, command.name, "SKILL.md"),
    content: frontmatter + body,
  };
}

export async function installCodexCommands(
  config: CommandInstallConfig,
  skillsDir: string,
): Promise<void> {
  const { commands, manifest } = config;
  assertValidCommandManifest(manifest);

  for (const name of manifest.global) {
    await rm(join(skillsDir, name), { recursive: true, force: true });
  }

  for (const cmd of commands) {
    if (cmd.cwd) continue;

    const compiled = compileCodexCommand(cmd, skillsDir);
    await mkdir(join(skillsDir, cmd.name), { recursive: true });
    await Bun.write(compiled.path, compiled.content);
    console.error(`  ℹ Installed "${cmd.name}" to ${compiled.path}`);
  }
}

export async function uninstallCodexCommands(
  config: InstallConfig,
  skillsDir: string,
): Promise<void> {
  const manifest = await readManifest(config.shakaHome);
  for (const name of manifest.global) {
    await rm(join(skillsDir, name), { recursive: true, force: true });
  }
}

export async function checkCodexCommands(
  config: InstallConfig,
  skillsDir: string,
): Promise<ComponentStatus> {
  let manifest: CommandManifest;
  try {
    manifest = await readManifest(config.shakaHome);
  } catch (e) {
    return { ok: false, issue: e instanceof Error ? e.message : String(e) };
  }
  const shakaConfig = await loadConfig(config.shakaHome);
  const { commands } = await discoverCommands(config.shakaHome, shakaConfig?.commands?.disabled);

  const globalCommands = commands.filter((command) => !command.cwd?.length);
  const codexManifest = { global: manifest.global, scoped: {} };
  const isEmpty = globalCommands.length === 0 && codexManifest.global.length === 0;
  if (isEmpty) return { ok: true };

  return checkCommandHealth(globalCommands, codexManifest, ({ command }) =>
    join(skillsDir, command.name, "SKILL.md"),
  );
}
