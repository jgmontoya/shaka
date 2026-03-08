---
description: Run an iterative coding loop — multiple rounds of focused improvements on a task
argument-hint: <task> [--rounds N] [--verify "cmd"] [--scope file.md]
---

Run an automated coding loop using `shaka loop`. This spawns an external process that orchestrates multiple rounds of autonomous coding — each round gets its own agent session, with verification between rounds and persistent state tracking.

## What the user asked for

$ARGUMENTS

## Your job

Parse the user's request and execute `shaka loop` with the right arguments.

### Argument mapping

| User says | Flag |
|-----------|------|
| Number of rounds/iterations | `--rounds N` or `-r N` |
| Depth | `--depth N` (alias for `--rounds N`) |
| Verification command (tests, build, lint) | `--verify "command"` or `-v "command"` |
| Scope/workload file | `--scope file.md` or `-s file.md` |
| Directory to run in | `--dir path` or `-d path` |
| The topic/task | First positional argument (quoted) |

### Examples

User: `/loop fix all test failures --rounds 5`
```bash
shaka loop "fix all test failures" --rounds 5
```

User: `/loop implement auth per AUTH.md, 10 rounds, verify with bun test`
```bash
shaka loop "implement auth per AUTH.md" --rounds 10 --verify "bun test"
```

User: `/loop harden the alpha checklist --depth 10`
```bash
shaka loop "harden the alpha checklist" --rounds 10
```

User: `/loop refactor database layer`
```bash
shaka loop "refactor database layer"
```

User: `/loop --scope workloads/api.md`
```bash
shaka loop --scope workloads/api.md "work through the scoped tasks"
```

### Defaults

- Rounds: 10 (if not specified)
- The loop creates `.loop-logs/` and `.loop-state-*.md` files in the current directory
- Each round spawns a fresh agent session via the CLI
- The outer process controls iteration, verification, and stopping

### Before running

1. Parse the arguments from what the user typed
2. Treat `--depth N` exactly like `--rounds N`
3. Show the user what command you're about to run
4. Execute it with Bash

### Important

- Run the command in the current working directory
- Do NOT add `--dir` unless the user specifically asks to run in a different directory
- The loop runs as a CLI process — just execute and let it go
- If the user didn't specify a task, ask them what they want to loop on
