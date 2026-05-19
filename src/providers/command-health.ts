import type { DiscoveredCommand } from "./command-discovery";
import type { CommandManifest } from "./command-manifest";
import type { ComponentStatus } from "./types";

interface CommandTarget {
  readonly command: DiscoveredCommand;
  readonly cwd?: string;
}

type CommandPathResolver = (target: CommandTarget) => string;
type CommandInstallVerifier = (target: CommandTarget, path: string) => Promise<boolean>;

function commandKey(name: string, cwd?: string): string {
  return cwd ? `scoped:${cwd}:${name}` : `global:${name}`;
}

function discoveredKeys(commands: DiscoveredCommand[]): Set<string> {
  const keys = new Set<string>();
  for (const command of commands) {
    if (command.cwd?.length) {
      for (const cwd of command.cwd) keys.add(commandKey(command.name, cwd));
    } else {
      keys.add(commandKey(command.name));
    }
  }
  return keys;
}

function manifestKeys(manifest: CommandManifest): Set<string> {
  const keys = new Set<string>();
  for (const name of manifest.global) keys.add(commandKey(name));
  for (const [cwd, names] of Object.entries(manifest.scoped)) {
    for (const name of names) keys.add(commandKey(name, cwd));
  }
  return keys;
}

function countSymmetricDifference(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) if (!b.has(item)) count += 1;
  for (const item of b) if (!a.has(item)) count += 1;
  return count;
}

function commandTargets(commands: DiscoveredCommand[]): CommandTarget[] {
  return commands.flatMap((command) => {
    if (!command.cwd?.length) return [{ command }];
    return command.cwd.map((cwd) => ({ command, cwd }));
  });
}

export async function checkCommandHealth(
  commands: DiscoveredCommand[],
  manifest: CommandManifest,
  resolvePath: CommandPathResolver,
  isInstalled: CommandInstallVerifier = async (_target, path) => Bun.file(path).exists(),
): Promise<ComponentStatus> {
  const drift = countSymmetricDifference(discoveredKeys(commands), manifestKeys(manifest));
  if (drift > 0) {
    return {
      ok: false,
      issue: `${drift} command(s) out of sync with manifest (run shaka reload)`,
    };
  }

  const missingFiles: CommandTarget[] = [];
  for (const target of commandTargets(commands)) {
    const path = resolvePath(target);
    if (!(await isInstalled(target, path))) missingFiles.push(target);
  }
  if (missingFiles.length > 0) {
    return {
      ok: false,
      issue: `${missingFiles.length} command(s) not installed (run shaka reload)`,
    };
  }

  return { ok: true };
}
