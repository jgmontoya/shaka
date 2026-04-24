---
name: Experiment
description: Reproducible proof-of-concept in an isolated folder with findings. USE WHEN spike, A/B test, validate before building, organizing experiments/, needing to reduce uncertainty of a plan.
key: experiment
include_when: Empirical question a run would settle. Spike, A/B test, or proof-of-concept. Organizing an `experiments/` folder.
---

# Experiment

An experiment is the smallest reproducible investigation that settles a design question. The question is empirical and non-trivial: does an API behave the way its docs claim? Does this algorithm converge in practice? What do the wire logs look like when this CLI is invoked that way? A good experiment answers one of those questions in the smallest bounded form possible, and leaves a write-up behind so the answer doesn't have to be re-discovered next quarter.

Don't run an experiment when the answer already exists — in the codebase, in the upstream docs, or in a previous experiment. Go read.

## The six rules

### 1. Hypothesis-driven

Open with numbered hypotheses (H1, H2, …) and an expected outcome per line. If the question can't be phrased as hypotheses a run could confirm or reject, the experiment isn't ready — the thinking isn't done. Most experiments land at 3–5 hypotheses. If you catch yourself writing H8, split it into two experiments.

### 2. Reproducible from the README alone

Someone — or some agent — landing in the experiment folder cold must be able to run it. The README lists every command in order. Links to prior experiments are fine; unwritten assumptions are not. No tribal knowledge, no "obviously you'd …".

### 3. Clean machine, always

The _only_ allowed side effects are artifacts inside the experiment folder (`logs/`, `outputs/`, `results/`, etc.). Global installs, host config edits, long-running background processes, stray files outside the folder — all must be torn down by the time the experiment exits.

Four isolation strategies, ranked by preference:

- **Container** — the experiment installs something into `~/.config/`, edits global state, or otherwise touches the host. Run inside a throwaway container (`docker compose run --rm`, `nerdctl run --rm`). Bind-mount the experiment folder back so logs survive the container.
- **Tmpdir + git** — code spikes that need a real filesystem and git history but nothing else. Use `mktemp -d /tmp/<exp-name>-XXXXXX`, log the path, document a single `rm -rf` for cleanup.
- **Install / uninstall pair** — you are intentionally measuring cost or behavior on the real host. The pair must be symmetric. The installer must refuse if a conflicting experiment — or the production install of the thing under test — is already present.
- **Pure analysis** — reads fixtures, writes analysis into the folder, no external side effects. No cleanup required.

### 4. Prefer agent-runnable

The target shape is one command: a script at the folder root that an agent can invoke without human input (`./run.sh`, `python run.py`, `bun run.ts`, etc.). The agent runs it, reads the logs, fills in the findings.

Interactive experiments are allowed _only_ when the thing under test requires a human in the loop — e.g., testing how a model reacts to a blocked tool call needs someone to prompt it. Flag these clearly as **Interactive** in the README. Everything else defaults to agent-runnable.

### 5. Findings are first-class

The run is not the deliverable. The write-up is. Before walking away, the README must include:

- **Run metadata** — date, software versions, platform, iteration count
- **Hypothesis verdicts** — one row per hypothesis: `CONFIRMED` / `REJECTED` / `INCONCLUSIVE`, with the evidence (log counts, metrics, quoted output) — not a paraphrase. Evidence looks like *"H1 CONFIRMED: `transform-fires.jsonl` has 20 entries across 10 invocations = 2 fires per call."* Not like *"H1 confirmed based on the logs."*
- **Bonus findings** — things the run surfaced that weren't in the original hypotheses; these are often more valuable than the verdict itself
- **Caveats** — what the experiment does _not_ prove (environmental assumptions, deferred measurements, sample-size limits)
- **Implications** — the concrete changes this unlocks, defers, or rules out

An experiment without findings is half-done.

### 6. Pre-register the implications

Before running, include an **implications matrix**: a table mapping combinations of hypothesis outcomes to next steps. Writing it _before_ the run prevents retro-rationalizing the verdict once results are in. The run either lands in a cell you planned for, or it surprises you into a genuinely new decision.

## Directory conventions

- **Name**: `NN-kebab-case-topic/` where `NN` is the next unused two-digit number. Don't skip, don't renumber.
- **`README.md`** is mandatory. It _is_ the experiment.
- **Ephemeral outputs** (`logs/`, `outputs/`, `results/`) live inside the folder. Whether to track them in version control is a project-level call — some projects commit them as the run record, others treat them as disposable. Match whatever convention the project already uses.
- **Fixtures** (`fixtures/`, `test-cases/`, `sample-*.json`) are part of the repro contract. Keep them alongside the scripts so future runs can reproduce deterministically.
- **Install scripts** live at the folder root (`install.*` paired with `uninstall.*`), named consistently across experiments so agents find them by convention.

## README template

When creating a new experiment or auditing an existing one against the convention, load the template: [`references/readme-template.md`](references/readme-template.md). It lists every section, which ones get filled in before vs after the run, and notes on what evidence each section expects.

## Gotchas

- **Don't run an experiment to answer a question that's already answered.** Check the codebase, upstream docs, and any previous experiment folder before setting one up. Experiments are for unknowns.
- **Don't turn discovery into scope.** If the run surfaces a new question, open a new experiment. Retrofitting scope muddles both experiments and rots the original hypothesis.
- **Don't delete old experiments.** If a finding is later invalidated (upstream patched the bug, the API changed), add a dated note to Findings. The folder is a time-stamped archive of what was true against which versions.
- **Don't retro-rationalize.** Once the run completes, the pre-registered implications matrix is the commitment. If the actual outcome doesn't fit any cell, that's a signal — not a license to reword the matrix.
- **Don't conflate single-run and multi-run questions.** A one-off spike answers structural questions ("does the parser accept Unicode at all?"). Performance, reliability, and non-determinism questions need N≥3 runs and a statistical note.
- **Don't let captured outputs leak secrets.** Runs often capture tokens, PII, or local filesystem paths. Scrub them before anything in the experiment folder gets shared externally, regardless of how the project tracks these files in version control.
- **Don't let install experiments stack.** If the design uses an install/uninstall pair, the installer must refuse to run on top of another experiment's install. Two hooks fighting for the same slot corrupt all the signals they would otherwise produce.
- **Don't skip the caveats section.** "This experiment didn't measure X" is as valuable as the verdict — it tells the next reader which follow-up is still open.

## When to restate findings elsewhere

The experiment folder is a lab notebook, not a deliverable. When a finding is load-bearing for shipped work:

- Restate it in the plan / design doc / memory where shipped decisions live.
- Cite the experiment by number (`experiment 28 — 2026-04-14`) so the evidence trail is followable.
- The experiment folder may or may not be the durable record, depending on how the project treats it. Don't rely on the folder alone when the finding shapes work on the critical path.

## Examples

**User: "I want to prove that our new caching layer actually speeds things up under concurrent load."**
→ Help frame hypotheses (cold vs warm, sequential vs concurrent), choose an isolation strategy (container if the cache touches Redis/shared state; tmpdir + git if pure in-process), and sketch the README before any script is written. Pre-register the implications matrix: what does the team do if speedup is <10%? <2×? ≥5×?

**User: "I ran the script and it produced logs. Now what?"**
→ Walk through the five findings subsections — metadata, per-hypothesis verdicts with evidence, bonus findings, caveats, implications. Quote log counts and metrics, not paraphrases. Resist the urge to tidy up the script or retrofit hypotheses; the run is the run.

**User: "This old experiment says our API returns X, but I'm seeing Y now."**
→ Add a dated note to the existing Findings ("Re-validated YYYY-MM-DD; behavior changed in v2.3, likely upstream cause"). Don't delete or rewrite. If the divergence is load-bearing for something shipping, open a new experiment that cites the old one.

**User: "Can you design an A/B test for these two prompt variants?"**
→ Frame it as cells (C0 = baseline, C1 = variant). Decide N upfront (≥3 runs if the variance matters). Pick pure-analysis isolation if it's text-in/text-out. Pre-register the metric and the threshold that would make C1 ship.
