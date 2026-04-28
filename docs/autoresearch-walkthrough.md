# Autoresearch Walkthrough

An end-to-end example of using `shaka autoresearch` to optimize a toy program. The same shape works for real benchmarks — test suites, build pipelines, hot paths.

## The target

Say we have a slow prime counter at `slow.ts`:

```ts
export function countPrimesUpTo(n: number): number {
  let count = 0;
  for (let i = 2; i <= n; i++) {
    let isPrime = true;
    for (let j = 2; j < i; j++) {
      if (i % j === 0) { isPrime = false; break; }
    }
    if (isPrime) count++;
  }
  return count;
}

if (import.meta.main) {
  const start = performance.now();
  const count = countPrimesUpTo(50000);
  const ms = performance.now() - start;
  console.log(`Primes found: ${count}`);
  console.log(`METRIC name=runtime value=${ms.toFixed(2)} unit=ms`);
}
```

Running it takes ~80ms — the `j < i` inner loop is O(n²). We know there's algorithmic headroom (sieve of Eratosthenes is O(n log log n)), but we want to let autoresearch find it.

## Start the experiment

```bash
$ shaka autoresearch start "cut prime count from 80ms to <5ms"
Worktree: /path/to/project.ar-cut-prime-count-from-80ms
Branch:   autoresearch/cut-prime-count-from-80ms
```

Shaka creates a git worktree next to your repo, switches to a new branch (your main checkout is untouched), and **hands your terminal to your installed provider CLI's interactive TUI** (claude, opencode, or codex) with a setup agent seeded by the `autoresearch-setup` skill. You talk to the agent directly — no wizard, no hand-editing — and it produces the setup artifacts:

- `autoresearch.md` — the spec (metric name, direction, unit, which benchmark is being wrapped)
- `autoresearch.sh` — the executable harness that emits one `METRIC name=... value=... unit=...` line on stdout
- `autoresearch.checks.sh` — optional correctness gate

If your objective is ambiguous (e.g. "make it faster" in a repo with two plausible benchmarks), the agent asks you in the TUI. When it's done, type `/exit` or Ctrl-D and control returns to Shaka.

Shaka then **validates the setup independently** — agent success text is never enough. The validation gate checks that `autoresearch.md` parses, `./autoresearch.sh` exits 0 and emits a parseable METRIC line, any `autoresearch.checks.sh` passes against the baseline, and only setup artifacts are dirty. If validation passes, Shaka commits the setup with message `autoresearch: finalize agent-generated setup` and enters the optimization loop. If it fails, Shaka prints a diagnostic naming the failing phase (`spec` / `benchmark` / `checks` / `dirty`), leaves the worktree on disk, and exits — you can inspect, fix by hand if you like, or re-run with a more specific objective.

### Opt-outs and overrides

- `--wizard` — skip the agent-driven path entirely and use the original six-question wizard + TODO-template flow. Useful in environments without an installed agent provider, or if you prefer to author the setup by hand.
- `--oneshot` — run the setup agent non-interactively (no TUI handoff). Useful for unattended queues, CI, or when your objective is unambiguous and you don't want the TTY round-trip. Combines with `--dry-run`; rejected in combination with `--wizard`.
- `--dry-run` — run the interactive setup + validation but don't commit and don't enter the loop. Prints the worktree path and the generated `autoresearch.sh` for review; pick up later with `shaka autoresearch resume <slug>`. Rejected in combination with `--wizard`.
- `--provider <name>` — force a specific provider (`claude`, `opencode`, or `codex`) when multiple are installed. Default resolution: claude → opencode → codex.

### When the default can't run

The full-auto default needs a TTY (interactive handoff to the provider CLI). If you run `shaka autoresearch start` in a non-TTY context — CI, a bash pipeline with redirected stdin, `ssh -T` — it fails with an actionable error pointing at `--wizard`. The loop itself still runs unattended once setup is done; only setup is interactive.

Non-TTY contexts now have two options: `--oneshot` runs the setup agent non-interactively (agent authors the setup artifacts end-to-end, no TUI) and `--wizard` uses the hand-filled wizard + TODO template. Pick `--oneshot` when you trust the agent to pick sensible defaults from the objective alone; pick `--wizard` when you want to dictate every field yourself.

If no provider CLI is installed, the default fails the same way. Run `shaka init` to install one, or use `--wizard` to author the setup by hand.

## The loop

Each iteration, Shaka builds a prompt that contains:

- The `autoresearch` skill (protocol, off-limits, JIT-bait warning)
- Your `autoresearch.md` body
- The last 5 entries from `autoresearch.jsonl`
- An instruction to propose one change and respond with `HYPOTHESIS:`

The agent edits `slow.ts` and emits something like:

```pseudocode
HYPOTHESIS: replace O(n²) trial division with a sieve of Eratosthenes
ASI: #algorithm #structural
```

Shaka runs `./autoresearch.sh`, parses the `METRIC` line, runs `./autoresearch.checks.sh`, compares the new metric against `best`, commits or reverts, and writes a line to `autoresearch.jsonl`:

```json
{"iter":1,"ts":"2026-04-19T...","provider":"claude","hypothesis":"replace O(n²) trial division with a sieve of Eratosthenes","metric":3.2,"verdict":"keep","commit":"a3f4c21","asi":["#algorithm","#structural"],"duration_ms":12400}
```

The status widget on your terminal redraws in place:

```pseudocode
iter 1 | kept 1 | disc 0 | best 3.20 (base 80.00) | cur 3.20
```

## Watching progress

From any directory inside the repo:

```bash
$ shaka autoresearch status

cut-prime-count-from-80ms  [active]
  path:   /path/to/project.ar-cut-prime-count-from-80ms
  branch: refs/heads/autoresearch/cut-prime-count-from-80ms
  HEAD:   a3f4c21
  iter 1 [keep] metric=3.2 commit=a3f4c21 — replace O(n²) trial division with a sieve of Eratosthenes
```

## Pausing and resuming

Ctrl+C at any point pauses the loop between iterations — the in-flight iteration finishes its cleanup (commit or revert), then the process exits with code 130.

```bash
shaka autoresearch resume
```

Resume picks up at `max(iter) + 1`, reads the jsonl for prior hypotheses, and keeps going. If the previous run was killed mid-write and the last jsonl line is truncated, Shaka warns, drops the bad tail, and continues from the last valid entry.

From the source repo (not the worktree), you can resume by slug:

```bash
shaka autoresearch resume cut-prime-count-from-80ms
```

Or with no args if there's exactly one active experiment:

```bash
shaka autoresearch resume
```

## Bounded runs

By default the loop runs until you stop it. Two flags bound it:

```bash
shaka autoresearch start "..." --max-iterations 20
shaka autoresearch start "..." --stop-after 5   # stop after 5 consecutive discards
```

Both accepted by `resume` too.

## Finishing

Autoresearch never auto-deletes the worktree. When you're done reviewing the experiment branch, clean up yourself:

```bash
git worktree remove /path/to/project.ar-cut-prime-count-from-80ms
git branch -d autoresearch/cut-prime-count-from-80ms
```

If the experiment produced commits you want to keep, cherry-pick or rebase them into your main branch before removing.

## Tips

- **Propose real headroom.** Bun's JIT already does loop unrolling, bit tricks, and inlining. Micro-optimizations usually lose. The skill nudges the agent toward algorithmic and structural changes; prefer those when you're reviewing hypotheses.
- **Keep the benchmark fast.** Under ~30s per run is good; longer and each iteration becomes expensive. If your real workload is slower, run a small representative slice.
- **Use the correctness gate.** Without it, the loop can "optimize" by breaking behavior. `autoresearch.checks.sh` catches hacks the metric alone can't.
- **The jsonl is local.** It's kept out of commits (pathspec exclude at stage time) and out of revert cleanup (`git clean -e`). Reverts preserve it; you don't need to hand-commit it.
