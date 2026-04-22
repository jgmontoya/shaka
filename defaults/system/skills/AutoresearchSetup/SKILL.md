---
name: AutoresearchSetup
description: Interactive setup protocol — produce autoresearch.md + autoresearch.sh + optional autoresearch.checks.sh from a natural-language objective so the loop can run.
key: autoresearch-setup
include_when: Only inside `shaka autoresearch start` (full-auto default) before the loop begins. Loaded via provider-specific system-prompt / agent mechanism at session spawn time.
---

# Autoresearch Setup Protocol

You have been handed a git worktree and a natural-language objective. You are in an interactive terminal session with the user. Produce a working benchmark harness that the autoresearch loop can consume. Ask the user if the objective is genuinely ambiguous — you are talking to them in real time.

## Output contract

Three files in the worktree root:

1. **`autoresearch.md`** — the spec. Required fields under `## Metric`:
   - `- command: ./autoresearch.sh`
   - `- direction: minimize` OR `- direction: maximize`
   - `- unit: <unit>` (e.g. `s`, `ms`, `ops/s`, `count`, `bytes`)

2. **`autoresearch.sh`** — executable shell script. When run with no args from the worktree root, it exits 0 and emits exactly one line on stdout matching:
   `METRIC name=<name> value=<number> unit=<unit>`

3. **`autoresearch.checks.sh`** (optional) — correctness gate. Exits 0 when the candidate is acceptable against the baseline tree.

## How to verify yourself

Before exiting, run `./autoresearch.sh` from the worktree root. If it exits 0 and stdout contains a line matching `METRIC name=... value=... unit=...`, you're done. If not, fix and re-run. When you're confident the setup is correct, tell the user and exit (`/exit` or Ctrl-D).

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
- **Record your choices in `autoresearch.md`.** When the repo exposes more than one plausible benchmark, iteration agents later read the spec, not your transcript — silent choices break the audit trail. Use the shape below.

## Required spec structure

```markdown
# <one-line objective, paraphrased>

## Metric
- command: ./autoresearch.sh
- direction: minimize
- unit: s

## Benchmark
- wraps: ./bench-cli.sh — CLI startup latency (lower is better)

## What's Been Tried
_no iterations yet_
```

Seed the `## What's Been Tried` section as shown — the iteration loop appends to it later.
