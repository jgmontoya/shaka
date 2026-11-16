---
name: autoresearch-setup
description: Creates the benchmark harness for a new autoresearch run from a natural-language objective. Use when starting an interactive `shaka autoresearch start` setup session.
key: autoresearch-setup
include_when: Only inside `shaka autoresearch start` (full-auto default) before the loop begins. Loaded via provider-specific system-prompt / agent mechanism at session spawn time.
---

# autoresearch-setup protocol

You have been handed a git worktree and a natural-language objective. You are in an interactive terminal session with the user. Produce a working benchmark harness that the autoresearch loop can consume. Ask the user when the objective is ambiguous.

## Output contract

Three files in the worktree root:

1. **`autoresearch.md`**: the spec, with these required fields under `## Metric`:
   - `- command: ./autoresearch.sh`
   - `- direction: minimize` OR `- direction: maximize`
   - `- unit: <unit>` (e.g. `s`, `ms`, `ops/s`, `count`, `bytes`)

2. **`autoresearch.sh`**: an executable shell script. When run with no args from the worktree root, it exits 0 and emits exactly one line on stdout matching:
   `METRIC name=<name> value=<number> unit=<unit>`

3. **`autoresearch.checks.sh`** (optional): a correctness gate that exits 0 when the candidate is acceptable against the baseline tree.

## How to verify yourself

Before exiting:

1. Inspect the wrapped benchmark and record its workload, measured region, build/data configuration, and observable work evidence in `autoresearch.md`.
2. Run `./autoresearch.sh` from the worktree root. Require successful completion of the declared work before emitting the single `METRIC` line. Make errors or missing required work produce a nonzero exit. A parseable metric alone does not establish useful work.
3. Run any correctness gate against the baseline. Confirm that the harness detects failed or incomplete work. If correctness checks run inside the benchmark or no separate checks script is needed, record that rationale in the spec.

For noisy timing or throughput, record repeated baseline runs and their spread. Choose repetitions and aggregation to suit the measurement, and aggregate within the script when needed to preserve one `METRIC` line. Deterministic counts do not require repetition. Keep these setup observations in the spec; the runner owns iteration measurements and history.

Fix failed checks and re-run before reporting completion. Record the setup evidence in the spec, tell the user what was verified, and exit (`/exit` or Ctrl-D). The runner independently checks the spec, metric, optional checks script, and dirty scope; it cannot establish whether an arbitrary workload is meaningful.

## When to ask the user

Ask, don't guess, when:
- The objective names a benchmark that doesn't exist in the repo.
- The repo has multiple plausible benchmarks and the objective doesn't disambiguate (e.g. "make it faster" with both `bench-cli.sh` and `bench-api.sh`).
- The metric direction is unclear (is "performance" latency or throughput?).
- The benchmark produces output you can't confidently parse.

Don't ask for decisions you can make safely on your own (file names, awk regexes, POSIX vs non-POSIX tool choice, etc.).

## Constraints

- Only touch `autoresearch.md`, `autoresearch.sh`, and (optionally) `autoresearch.checks.sh`. Do not modify anything else in the worktree.
- Prefer POSIX tools (`awk`, `grep`, `sed`, `cut`) over `rg`, `fd`, or `jq`. The generated script must work on a minimal Unix system.
- **Record your choices in `autoresearch.md`.** When the repo exposes more than one plausible benchmark, explain your selection so iteration agents can understand it from the spec. Use the shape below.

## Required spec structure

```markdown
# <one-line objective, paraphrased>

## Metric
- command: ./autoresearch.sh
- direction: minimize
- unit: s

## Benchmark
- wraps: ./bench-cli.sh (CLI startup latency, lower is better)
- workload: <fixed inputs and required work per invocation>
- measured region: <start/end boundaries, including what setup or build work is excluded>
- configuration: <build mode, data/fixture identity, and relevant settings>
- work evidence: <observable output, completed operations, or artifact checks>

## Correctness
- checks: <checks script, inline checks, or rationale for no separate checks script>
- failure behavior: <how errors and incomplete work cause a nonzero exit>

## Baseline
- method: <repetitions and aggregation, or why repetition is unnecessary>
- observations: <baseline values and spread where applicable>
```

Iteration history lives in `autoresearch.jsonl` and is surfaced by `shaka autoresearch status`. You don't need to duplicate it in the spec.
