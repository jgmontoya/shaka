---
name: steal-adapt-reject
description: Evaluates an external source (repo, tool, article, talk) against the current project and produces a report-only steal/adapt/reject decision table with named rejections. Use when mining another system for ideas worth adopting without copying its scope.
key: stealadaptreject
include_when: An external system, repo, tool, or document is being evaluated for ideas to adopt into the current project.
---

# steal-adapt-reject Skill

A repeatable procedure for answering "what should we borrow from X?" without
turning admiration into scope creep. The output is a decision report; the
skill never changes the project.

## Core Rule

**Borrow mechanisms, not identity.** A source's contracts, gates, tests, and
disciplines transfer; its product boundary, scope, and self-image do not. If
a candidate only makes sense inside the source's product, it is a reject.

## Inputs

- **Source**: URL, repo, document, talk, or path. Prefer primary sources over
  summaries of them.
- **Project**: the current working project (its code, docs, plans, and any
  available memory of past decisions).
- **Focus** (optional): a surface area to weigh candidates against.

## Procedure

### 1. Ground the source

Read the actual artifact, not recollections of it. Record versions, dates,
and exact locations of claims so the report is checkable. If the source has
moved, renamed, or changed since it was last discussed, say so explicitly —
stale snapshots produce stale recommendations.

### 2. Ground the project

Before extracting a single candidate, establish what the project already
has: shipped features, existing commands, open plans, and previously rejected
ideas. This is what makes the prior-status column honest. Skipping this step
is how a report recommends building something that already exists.

### 3. Extract candidates

Enumerate the source's ideas as mechanisms ("append-only event log read by a
health command"), not features to envy ("great observability"). A mechanism
sits at the altitude of one adoptable change — "their install does a
read-only conflict scan", not "their installer is nice" and not one candidate
per config flag.

Breadth: if a **Focus** was given, be exhaustive within it. Otherwise cap at
the strongest candidates (a dozen is usually plenty) and say what was left
unexamined — a silent cap reads as "covered everything" when it didn't.

Each candidate must name the **pain it addresses in the project today**. No
named current pain → the candidate still enters the table, as a **Reject**
with "no current pain" as the reason. It is not silently dropped — that's
what keeps the same idea from being re-litigated next pass.

### 4. Validate premises

Every claim a candidate rests on gets checked against the project's actual
code and docs before the candidate earns a verdict or a place in the
recommended order. A recommendation built on an unverified premise inverts
the whole ordering. This cuts both ways: rejection reasons carry load too —
a false premise in a rejection is a bug even if the conclusion happens to be
right.

Delegate grounding and validation to research subagents when available; the
report should cite what was verified, not what was assumed.

### 5. Classify and decide

For each candidate assign a prior status, a verdict, and three ratings on a
**high / medium / low** scale:

- **Value** — size of the pain removed if adopted.
- **Complexity** — effort and blast radius of adopting it.
- **Risk** — what could break or drift if adopted (maintenance, privacy,
  scope).

| Prior status | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `new`        | Nothing like it exists in the project                            |
| `partial`    | Exists in weaker or narrower form                                |
| `done`       | Already shipped — candidate collapses to "nothing to do"         |
| `rejected`   | Considered before and declined — re-raise only with new evidence |
| `unknown`    | Could not be established — say so, don't guess                   |

| Verdict    | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| **Steal**  | Adopt the mechanism as-is (adapted to project idiom)           |
| **Adapt**  | The idea survives but the shape must change to fit the project |
| **Reject** | Named and reasoned — never silently dropped                    |

Two prior statuses resolve their own verdicts: `done` collapses to
**Reject (already shipped)**, and `unknown` defers the verdict entirely — the
candidate goes to the Unknowns section instead of receiving a guess.

### 6. Report

```markdown
## Steal/Adapt/Reject: [source] vs [project]

Source ground truth: [versions, dates, links]

| Candidate | Evidence | Prior status | Pain today | Value | Complexity | Risk | Verdict |
| --------- | -------- | ------------ | ---------- | ----- | ---------- | ---- | ------- |

[Evidence = where the mechanism lives in the SOURCE: link, path, or
file reference plus version. Prior status cites where in the PROJECT it was
checked. Value/Complexity/Risk are high/medium/low per Step 5.]

### Recommended order

[Only steals and adapts, ordered by value; each with the premise that was verified]

### Rejections

[Every reject with its reason — this section is mandatory]

### Unknowns

[What could not be verified, honestly]
```

## Hard Rules

- **Report-only.** The skill never acts on its findings — no code, config,
  plan, or install changes. Deliver the report in the conversation; write it
  to a file only if the user asks (the requested report is the deliverable,
  not a project mutation). Adoption is a separate step the user initiates.
- **Rejections are output.** A report without a rejections section did not
  apply the filter — it made a shopping list.
- **No place in the recommended order without a verified premise.** Position
  is earned by evidence, not by how good the idea sounds.
- **Re-raising a `rejected` candidate requires new evidence**, and the old
  rejection's premises must be re-checked against the current project — both
  sides may have changed.

## Anti-Patterns

- **Feature-table envy**: comparing feature lists instead of asking what
  pain each mechanism addresses here, now.
- **Wholesale admiration**: a report that steals everything evaluated
  nothing.
- **Silent rejection**: dropping candidates without naming why, so the same
  idea gets re-litigated in the next pass.
- **Scope adoption**: importing the source's product boundary along with its
  mechanism.
- **Unverified prior status**: labeling a candidate `new` without searching
  the project first.
