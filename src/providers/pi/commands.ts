import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig } from "../../domain/config";
import { type CompiledCommand, applyOverrides, buildFrontmatter } from "../command-compiler";
import { type DiscoveredCommand, discoverCommands } from "../command-discovery";
import type { CommandInstallConfig, ComponentStatus, InstallConfig } from "../types";

const PROMPTS_DIR_NAME = "prompts";

function hasPiArgReferences(body: string): boolean {
  const stripped = body.replace(/!`[^`]*`/g, "");
  return /\$ARGUMENTS|\$\d+|\$@|\$\{@:\d+(?::\d+)?\}/.test(stripped);
}

function autoAppendPiArguments(body: string): string {
  return hasPiArgReferences(body) ? body : `${body}\n\n$ARGUMENTS`;
}

export function compilePiCommand(command: DiscoveredCommand, targetDir: string): CompiledCommand {
  const fields = applyOverrides(command, "pi");
  const body = autoAppendPiArguments(command.body);

  const frontmatter = buildFrontmatter({
    description: fields.description,
    "argument-hint": fields.argumentHint,
    model: fields.model,
  });

  return {
    path: join(targetDir, `shaka-${command.name}.md`),
    content: frontmatter + body,
  };
}

export async function installPiCommands(
  config: CommandInstallConfig,
  piHome: string,
): Promise<void> {
  const promptsDir = join(piHome, PROMPTS_DIR_NAME);
  await mkdir(promptsDir, { recursive: true });

  const compiledCommands = config.commands
    // Pi v1 ships global commands only; scoped commands deferred.
    .filter((command) => !command.cwd)
    .map((command) => compilePiCommand(command, promptsDir));
  const expected = new Set(compiledCommands.map((command) => basename(command.path)));

  const entries = await readdir(promptsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("shaka-") || !entry.name.endsWith(".md")) continue;
    if (expected.has(entry.name)) continue;
    await rm(join(promptsDir, entry.name), { force: true });
  }

  for (const compiled of compiledCommands) {
    await Bun.write(compiled.path, compiled.content);
  }
}

/**
 * Remove every `shaka-*.md` prompt template `installPiCommands` may have
 * written under `<piHome>/prompts/`. Scope is the `shaka-` prefix only;
 * user-authored prompt templates in the same directory are preserved.
 */
export async function uninstallPiCommands(piHome: string): Promise<void> {
  const promptsDir = join(piHome, PROMPTS_DIR_NAME);
  if (!(await directoryExists(promptsDir))) return;
  const entries = await readdir(promptsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("shaka-") || !entry.name.endsWith(".md")) continue;
    await rm(join(promptsDir, entry.name), { force: true });
  }
}

export async function checkPiCommands(
  config: InstallConfig,
  piHome: string,
): Promise<ComponentStatus> {
  const shakaConfig = await loadConfig(config.shakaHome);
  const { commands } = await discoverCommands(config.shakaHome, shakaConfig?.commands?.disabled);
  const promptsDir = join(piHome, PROMPTS_DIR_NAME);
  const expectedCommands = new Map(
    commands
      // Pi v1 ships global commands only; scoped commands deferred.
      .filter((command) => !command.cwd)
      .map((command) => {
        const compiled = compilePiCommand(command, promptsDir);
        return [basename(compiled.path), compiled] as const;
      }),
  );

  if (!(await directoryExists(promptsDir))) {
    return expectedCommands.size === 0
      ? { ok: true }
      : {
          ok: false,
          issue: `${expectedCommands.size} command(s) not installed (run shaka reload)`,
        };
  }

  const entries = await readdir(promptsDir, { withFileTypes: true });
  const installedNames = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("shaka-") && name.endsWith(".md")),
  );
  const missing = [...expectedCommands.keys()].filter((name) => !installedNames.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      issue: `${missing.length} command(s) not installed (run shaka reload)`,
    };
  }

  const stale = [...installedNames].filter((name) => !expectedCommands.has(name));
  if (stale.length > 0) {
    return {
      ok: false,
      issue: `${stale.length} stale command(s) installed (run shaka reload)`,
    };
  }

  let outdated = 0;
  for (const command of expectedCommands.values()) {
    if ((await Bun.file(command.path).text()) !== command.content) {
      outdated += 1;
    }
  }
  if (outdated > 0) {
    return {
      ok: false,
      issue: `${outdated} command(s) out of date (run shaka reload)`,
    };
  }

  return { ok: true };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}
