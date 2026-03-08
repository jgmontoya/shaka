---
description: Run an iterative coding loop — multiple rounds of focused improvements on a task
argument-hint: <task> [--rounds N] [--verify "cmd"] [--scope file.md]
---

You are running an iterative coding loop. Your job is to make focused, incremental improvements across multiple rounds until the task is complete or verification passes.

## Task

$ARGUMENTS

## How the Loop Works

Parse the user's arguments to determine:

| Argument | Meaning | Default |
|----------|---------|---------|
| The task description | What to work on | (required) |
| `--rounds N` or `-r N` | Maximum rounds | 10 |
| `--depth N` | Alias for `--rounds N` | 10 |
| `--verify "cmd"` or `-v "cmd"` | Command that defines "done" (exits 0 = stop) | none |
| `--scope file.md` or `-s file.md` | Workload file defining boundaries | none |

## State File

Create a state file called `.loop-state.md` in the current directory at the start of round 1. Update it after every round.

```markdown
# Loop State
Task: [the task]
Rounds: [current] / [total]
Started: [timestamp]

## Completed
- [round N]: [what was done]

## Rejected Directions
- [what you considered but didn't do, and why]

## Open Risks
- [things that might break or need attention]

## Next Best Step
[what the next round should focus on]
```

Read this file at the start of each round to understand where you left off.

## Rules Per Round

1. **One focused change per round.** Don't try to fix everything at once. Make a single, surgical improvement that moves the task forward.
2. **Verify before ending the round.** Run tests, builds, or the `--verify` command to confirm your change works. If it doesn't, fix it in the same round.
3. **Update the state file** at the end of every round with what you did, what you rejected, and what's next.
4. **Respect scope boundaries.** If `--scope` is set, read the workload file and stay within its boundaries. Record out-of-scope observations in "Rejected Directions" instead of acting on them.
5. **No git operations.** Don't commit, push, or change git config. The user manages git.
6. **No architecture rewrites** unless the task explicitly asks for it. Keep changes shippable.

## Stopping Conditions

Stop the loop early when:
- The `--verify` command passes (exits 0)
- You've completed the task with nothing meaningful left to do
- You're blocked on something outside your control (mark the round as "blocked" and explain why)
- Two consecutive blocked rounds = stop the loop entirely

## Round Output Format

End each round with this structured output:

```
ROUND [N]/[total]
STATUS: done | blocked
SUMMARY: [one line — what you did this round]
FILES: [comma-separated paths changed]
VERIFY: [commands run and their results]
NEXT: [what the next round should focus on]
```

## Execution

You are now in round 1. Begin by:
1. Reading the scope file if `--scope` was provided
2. Creating the state file
3. Assessing the current state of the codebase relevant to the task
4. Making your first focused improvement
5. Verifying it works
6. Updating the state file
7. Outputting the round summary

After each round, immediately proceed to the next round. Continue until a stopping condition is met or you've exhausted all rounds.
