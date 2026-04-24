# Experiment README template

Copy this structure when creating a new experiment's README. Sections marked *before the run* must be filled in before the script is executed; `Findings` is filled in after.

```markdown
# Experiment NN: Short Name

One-line summary of what's being tested.

## Background                                  # before the run

Why this matters. Prior art (link to earlier experiments this builds on).

## Hypotheses                                  # before the run

| #   | Hypothesis | Expected outcome |
| --- | ---------- | ---------------- |
| H1  | ...        | ...              |

## Method                                      # before the run

How the test works. Fixture, isolation strategy, orchestration, cells/variants if A/B.

## Files                                       # before the run

Table of scripts in the folder and what each does.

## Step-by-step                                # before the run

Exact commands. Copy-pasteable. Container path first if applicable, host path second.

## Verification criteria                       # before the run

Checklist mapping each hypothesis to the signal that decides it.

## Implications matrix                         # before the run

How different hypothesis outcomes map to next steps.

## Findings                                    # after the run

- Date, versions, platform, iteration count
- Per-hypothesis verdicts with evidence
- Bonus findings
- Caveats
- Implications
```

## Notes on filling it in

- **Hypotheses** land at 3–5. If you're reaching for H8, split into two experiments.
- **Method** should include isolation strategy (container / tmpdir / install-uninstall / pure analysis) explicitly — the next reader needs to know how the run is bounded.
- **Step-by-step** is copy-pasteable, not paraphrased. An agent landing cold should execute without guessing.
- **Implications matrix** gets written *before* the run. Post-hoc matrices rationalize; pre-registered matrices commit.
- **Findings** evidence is quoted log counts, metrics, or output — not paraphrase. "H1 CONFIRMED: transform-fires.jsonl had 20 entries across 10 invocations" beats "H1 confirmed based on the logs."
