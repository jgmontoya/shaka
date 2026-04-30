# Installing Shaka

Get Shaka running in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- [Git](https://git-scm.com/)
- At least one AI coding assistant:
  - [Claude Code](https://claude.ai/download) (`claude` CLI)
  - [opencode](https://opencode.ai/) (`opencode` CLI)
  - [Codex](https://github.com/openai/codex) (`codex` CLI)
  - [Pi](https://pi.dev) (`pi` CLI — `bun add -g @mariozechner/pi-coding-agent`)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/jgmontoya/shaka.git
cd shaka

# Install dependencies
bun install

# Register shaka globally (makes `shaka` available in PATH)
bun link

# Initialize Shaka
shaka init

# Verify installation
shaka doctor
```

> **Note:** The repo must stay on disk — `bun link` creates a symlink, so
> deleting the repo breaks the `shaka` command and hook imports.

## What `shaka init` Does

1. **Creates user-owned directories** at `~/.config/shaka/`:

   - `user/` — Your personal context files (never overwritten on upgrade)
   - `customizations/` — Your overrides for system files (survives upgrades)
   - `memory/` — Session data (created as needed)

2. **Symlinks `system/`** — Points `~/.config/shaka/system/` to `<repo>/defaults/system/`. This means `git pull` or `shaka update` instantly updates the framework without copying files.

3. **Links the shaka library** — Runs `bun link` so that hooks can `import { ... } from "shaka"` to access shared utilities (config, inference, security, etc.).

4. **Copies user templates** — Deploys starter files from `defaults/user/` to `~/.config/shaka/user/` (per-file, never overwrites existing files). New templates added in future versions are deployed automatically.

5. **Copies default config** — Creates `~/.config/shaka/config.json` if it doesn't exist.

6. **Detects providers** (Claude Code, opencode, Codex, Pi) and installs hooks, tools, commands, skills, and agents for each one present.

7. **Tracks version** — Writes `.shaka-version` in the shaka home directory.

## Verifying Installation

```bash
shaka doctor
```

Expected output (simplified — actual output is more detailed; per-provider
includes `Enabled`, `Hooks`, `Agents`, `Skills`, `Installed`, and `Commands`):

```text
Shaka Doctor

Checking system health...

Shaka home: /Users/you/.config/shaka
  ✓ config.json exists

Provider status:

  claude:
    CLI installed: ✓ yes
    Hooks configured: ✓ yes

  opencode:
    CLI installed: ✓ yes
    Hooks configured: ✓ yes

  codex:
    CLI installed: ✓ yes
    Hooks configured: ✓ yes

  pi:
    CLI installed: ✓ yes
    Hooks configured: ✓ yes

────────────────────────────────────────
✅ All systems operational.
```

Doctor reports each detected provider on its own block. Pi gets an extra `Credentials: ✗ no (...)` line **only when** none of `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, or `~/.pi/agent/auth.json` is reachable — Pi has no first-run OAuth flow so Shaka surfaces this as an actionable warning. The line is omitted from healthy output.

## Configuration

Edit `~/.config/shaka/config.json` to customize:

```json
{
  "version": "0.6.0",
  "reasoning": {
    "enabled": true
  },
  "providers": {
    "claude": {
      "enabled": true,
      "summarization_model": "auto"
    },
    "opencode": {
      "enabled": true,
      "summarization_model": "auto"
    },
    "codex": {
      "enabled": true,
      "summarization_model": "auto"
    },
    "pi": {
      "enabled": true,
      "summarization_model": "auto"
    }
  },
  "assistant": {
    "name": "Shaka"
  },
  "principal": {
    "name": "Your Name"
  }
}
```

### User Context Files

Files in `~/.config/shaka/user/` are loaded at session start:

| File            | Purpose                               |
| --------------- | ------------------------------------- |
| `user.md`       | Who you are (name, timezone, handles) |
| `assistant.md`  | How your assistant behaves            |
| `missions.md`   | High-level purpose (TELOS-lite)       |
| `goals.md`      | Specific objectives                   |
| `projects.md`   | Active projects and paths             |
| `tech-stack.md` | Your preferred technologies           |

## Customization

Override any system file by copying it to `customizations/`:

```bash
# Customize the reasoning framework
cp ~/.config/shaka/system/base-reasoning-framework.md \
   ~/.config/shaka/customizations/base-reasoning-framework.md

# Edit your version
$EDITOR ~/.config/shaka/customizations/base-reasoning-framework.md
```

Files in `customizations/` take precedence over `system/`.

## Upgrading

Use the built-in update command:

```bash
shaka update
```

This will:

1. Fetch the latest release tags from the remote
2. Compare your current version against the latest `vX.Y.Z` tag
3. Warn and ask for confirmation on major version upgrades
4. Check out the new tag, run `bun install`, and re-initialize

Your `user/`, `customizations/`, and `memory/` directories are never touched during upgrades. The `system/` symlink ensures framework updates are instant.

To skip the major-version confirmation prompt:

```bash
shaka update --force
```

## Troubleshooting

### "Hooks not configured"

Run init to install hooks:

```bash
shaka init
```

### "config.json not found"

Run init to create the directory structure:

```bash
shaka init
```

### "`shaka` command not found"

Re-register the CLI:

```bash
cd /path/to/shaka
bun link
```

### "system/ exists as a real directory"

Init expects `system/` to be a symlink. Move any custom files to `customizations/`, remove the directory, and re-run init:

```bash
mv ~/.config/shaka/system/my-custom-file.md ~/.config/shaka/customizations/
rm -rf ~/.config/shaka/system
shaka init
```

### Provider not detected

Ensure the CLI is in your PATH:

```bash
which claude     # Claude Code
which opencode   # opencode
which codex      # Codex
which pi         # Pi
```

### Hooks not firing

Check the provider-specific configuration:

```bash
# Claude Code — hooks live in settings.json
cat ~/.claude/settings.json | grep -A 10 hooks

# opencode — plugin file
ls -la ~/.config/opencode/plugins/shaka.ts

# Codex — wrapper registered in config.toml
grep -A 5 '\[hooks' ~/.codex/config.toml

# Pi — generated extension
ls -la ~/.pi/agent/extensions/shaka.ts
```

### Hook import errors

Hooks import shared code via `import { ... } from "shaka"`. If you see import resolution errors:

```bash
# Re-link the library
cd /path/to/shaka
bun link
cd ~/.config/shaka
bun link shaka
```

Or simply re-run `shaka init`, which handles this automatically.

## Uninstalling

```bash
# The right way: let Shaka clean up its own artifacts per provider
shaka uninstall                # interactive prompt: keep or delete user/customizations/memory
shaka uninstall --keep-data    # remove hooks/tools/skills/agents/commands; keep user config + memory
shaka uninstall --delete-data  # also wipe user/, customizations/, memory/

# Manual fallback (only if `shaka uninstall` isn't available):
#   Claude Code  → remove `shaka` entries from ~/.claude/settings.json
#   opencode     → rm ~/.config/opencode/plugins/shaka.ts
#   Codex        → remove `[mcp_servers.shaka]` + Shaka hook block from ~/.codex/config.toml
#   Pi           → rm ~/.pi/agent/extensions/shaka.ts, ~/.pi/agent/prompts/shaka-*.md, and any ~/.pi/agent/skills/shaka-* entries

# Remove Shaka configuration (system/ is a symlink — removing it doesn't delete the repo)
rm ~/.config/shaka/system

# Remove everything (warning: deletes your customizations and memory)
rm -rf ~/.config/shaka
```

## Next Steps

- Edit `~/.config/shaka/user/user.md` to tell Shaka about yourself
- Run `claude`, `opencode`, `codex`, or `pi` and see the context injection in action
- Explore `~/.config/shaka/system/` to understand available hooks and tools
- Run `shaka update` periodically to get the latest framework updates
