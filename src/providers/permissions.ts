/**
 * Default permission sets for Claude Code and OpenCode.
 *
 * Shaka applies these during `shaka init` when no existing permissions are found.
 * Philosophy: allow all standard dev tools, guard destructive operations in `ask`.
 */

export interface ClaudePermissions {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface OpencodePermissions {
  edit: "allow" | "ask";
  bash: "allow" | "ask";
}

export const CLAUDE_PERMISSION_DEFAULTS: Readonly<ClaudePermissions> = {
  allow: [
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "NotebookRead",
    "NotebookEdit",
    "TodoWrite",
    "ExitPlanMode",
    "Task",
    "Skill",
    "mcp__*",
  ],
  deny: [],
  ask: [
    "Bash(rm -rf /)",
    "Bash(rm -rf /:*)",
    "Bash(sudo rm -rf /)",
    "Bash(sudo rm -rf /:*)",
    "Bash(rm -rf ~)",
    "Bash(rm -rf ~:*)",
    "Bash(rm -rf ~/.claude)",
    "Bash(rm -rf ~/.claude:*)",
    "Bash(diskutil eraseDisk:*)",
    "Bash(diskutil zeroDisk:*)",
    "Bash(diskutil partitionDisk:*)",
    "Bash(diskutil apfs deleteContainer:*)",
    "Bash(diskutil apfs eraseVolume:*)",
    "Bash(dd if=/dev/zero:*)",
    "Bash(mkfs:*)",
    "Bash(gh repo delete:*)",
    "Bash(gh repo edit --visibility public:*)",
    "Bash(git push --force:*)",
    "Bash(git push -f:*)",
    "Bash(git push origin --force:*)",
    "Bash(git push origin -f:*)",
    "Read(~/.ssh/id_*)",
    "Read(~/.ssh/*.pem)",
    "Read(~/.aws/credentials)",
    "Read(~/.gnupg/private*)",
    "Write(~/.claude/settings.json)",
    "Edit(~/.claude/settings.json)",
    "Write(~/.ssh/*)",
    "Edit(~/.ssh/*)",
  ],
};

export const OPENCODE_PERMISSION_DEFAULTS: Readonly<OpencodePermissions> = {
  edit: "allow",
  bash: "allow",
};

/**
 * Check if OpenCode config already has permissions configured.
 */
export function hasExistingOpencodePermissions(config: Record<string, unknown>): boolean {
  return config.permission !== undefined;
}

/**
 * Merge Shaka defaults into existing Claude Code permissions.
 * - allow: union (deduplicated)
 * - ask: union (deduplicated)
 * - deny: preserve existing only (never add, never remove)
 */
export function mergeClaudePermissions(existing: Partial<ClaudePermissions>): ClaudePermissions {
  return {
    allow: dedupe([...(existing.allow ?? []), ...CLAUDE_PERMISSION_DEFAULTS.allow]),
    ask: dedupe([...(existing.ask ?? []), ...CLAUDE_PERMISSION_DEFAULTS.ask]),
    deny: existing.deny ?? [],
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
