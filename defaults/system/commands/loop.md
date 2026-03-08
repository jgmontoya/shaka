---
description: Run an iterative coding loop — multiple rounds of focused improvements on a task
argument-hint: <task> [--rounds N] [--verify "cmd"] [--scope file.md] [--continue]
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
| Keep context between rounds | `--continue` or `-c` |
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
- Mode: fresh context per round (use `--continue` for session continuity)
- The loop creates `.loop-logs/` and `.loop-state-*.md` files in the current directory
- If `--verify` is set, runs a baseline check before round 1
- If baseline verification already passes, the loop exits cleanly and still writes metadata
- Verification failure output is fed back into the next round's prompt
- Stops automatically if the same verification failures repeat 3 rounds in a row
- Stops early if consecutive rounds make no meaningful progress
- The outer loop owns the state file and writes it from each round's structured report
- Writes `run.json` metadata to the log directory for programmatic consumption

### Before running

1. Parse the arguments from what the user typed
2. Treat `--depth N` exactly like `--rounds N`
3. Show the user what command you're about to run
4. Execute it with Bash

### Important

- Run the command in the current working directory
- Do NOT add `--dir` unless the user specifically asks to run in a different directory
- If the user omits `--verify`, warn them that the loop can improve code but cannot prove convergence
- The loop runs as a CLI process — just execute and let it go
- If the user didn't specify a task, ask them what they want to loop on
