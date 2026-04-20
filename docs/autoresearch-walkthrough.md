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

Shaka creates a git worktree next to your repo and switches to a new branch. Your main checkout is untouched.

Because we started fresh, the runner auto-generates `autoresearch.md` and `autoresearch.sh` as templates with TODO markers. The first iteration can't run yet — the template `autoresearch.sh` exits with `# TODO: replace with real benchmark` and exit code 1, which triggers a `crash` and aborts with:

> Baseline benchmark failed (exit 1). `autoresearch.sh` has a TODO marker — edit it and run `shaka autoresearch resume`.

Edit `autoresearch.md` to describe the run:

```markdown
# Autoresearch: cut prime count from 80ms to <5ms

## Objective

Speed up countPrimesUpTo(50000) while preserving the exact answer (5133).

## Metric

- command: `./autoresearch.sh`
- unit: ms
- direction: minimize
- baseline: 80.0

## Files in scope

- slow.ts

## Off-limits

- autoresearch.*

## Constraints

- must print `Primes found: 5133`
```

Edit `autoresearch.sh` so it actually runs the benchmark:

```sh
#!/usr/bin/env sh
set -e
bun run slow.ts
```

Create an optional correctness gate at `autoresearch.checks.sh`:

```sh
#!/usr/bin/env sh
bun run slow.ts | grep -q "Primes found: 5133"
```

Make them executable (`chmod +x autoresearch.*.sh`) and resume:

```bash
$ shaka autoresearch resume
Resuming: /path/to/project.ar-cut-prime-count-from-80ms
```

## The loop

Each iteration, Shaka builds a prompt that contains:

- The Autoresearch skill (protocol, off-limits, JIT-bait warning)
- Your `autoresearch.md` body
- The last 5 entries from `autoresearch.jsonl`
- An instruction to propose one change and respond with `HYPOTHESIS:`

The agent edits `slow.ts` and emits something like:

```
HYPOTHESIS: replace O(n²) trial division with a sieve of Eratosthenes
ASI: #algorithm #structural
```

Shaka runs `./autoresearch.sh`, parses the `METRIC` line, runs `./autoresearch.checks.sh`, compares the new metric against `best`, commits or reverts, and writes a line to `autoresearch.jsonl`:

```json
{"iter":1,"ts":"2026-04-19T...","provider":"claude","hypothesis":"replace O(n²) trial division with a sieve of Eratosthenes","metric":3.2,"verdict":"keep","commit":"a3f4c21","asi":["#algorithm","#structural"],"duration_ms":12400}
```

The status widget on your terminal redraws in place:

```
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
$ shaka autoresearch resume
```

Resume picks up at `max(iter) + 1`, reads the jsonl for prior hypotheses, and keeps going. If the previous run was killed mid-write and the last jsonl line is truncated, Shaka warns, drops the bad tail, and continues from the last valid entry.

From the source repo (not the worktree), you can resume by slug:

```bash
$ shaka autoresearch resume cut-prime-count-from-80ms
```

Or with no args if there's exactly one active experiment:

```bash
$ shaka autoresearch resume
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
$ git worktree remove /path/to/project.ar-cut-prime-count-from-80ms
$ git branch -d autoresearch/cut-prime-count-from-80ms
```

If the experiment produced commits you want to keep, cherry-pick or rebase them into your main branch before removing.

## Tips

- **Propose real headroom.** Bun's JIT already does loop unrolling, bit tricks, and inlining. Micro-optimizations usually lose. The skill nudges the agent toward algorithmic and structural changes; prefer those when you're reviewing hypotheses.
- **Keep the benchmark fast.** Under ~30s per run is good; longer and each iteration becomes expensive. If your real workload is slower, run a small representative slice.
- **Use the correctness gate.** Without it, the loop can "optimize" by breaking behavior. `autoresearch.checks.sh` catches hacks the metric alone can't.
- **The jsonl is local.** It's kept out of commits (pathspec exclude at stage time) and out of revert cleanup (`git clean -e`). Don't commit it by hand — future reverts will drop it.
