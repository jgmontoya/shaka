---
name: ValidatePlan
description: Orchestrate Research + Architect + Engineer + cold-reader review to pressure-test a design before implementation. USE WHEN validate plan, review design, before implementing.
key: validateplan
include_when: Orchestrator layer — calls Council/RedTeam/FirstPrinciples only at the routing points below. A non-trivial design exists and is about to be implemented.
---

# ValidatePlan Skill

Pressure-test a proposed design with Research, Architect, Engineer, and cold-reader passes against an explicit quality bar. Output: a revised plan delta with a verdict — **proceed**, **revise**, or **abandon**.

| Skill              | Target                     | Move                                                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| `RedTeam`          | Any idea                   | 32-agent adversarial attack; steelman + counter                                            |
| `Council`          | Open question              | Multi-round debate transcript across perspectives                                          |
| `FirstPrinciples`  | Stuck reasoning            | Decompose → challenge constraints → reconstruct                                            |
| **`ValidatePlan`** | **A design about to ship** | **Orchestrate Research+Architect+Engineer+cold reader; produce a revised plan delta + verdict** |

## Inputs

- **The plan** — markdown design doc, pasted proposal, or current plan text. Ask "which plan?" if not named.
- **A repo** for Phase 1 to map against. If none exists, skip the Research call and treat the author's stated context as the source of truth.

The revised plan ships as the `Revised plan delta` in the Output Format. Not written to disk unless asked.

## Dispatch

Two mechanisms — not interchangeable:

- **Subagents** (`Architect`, `Engineer`, `Intern`, and an available agent with `capability: research`) → use Shaka's active provider agent dispatch for that role.
- **Sibling skills** (`Council`, `RedTeam`, `FirstPrinciples`, `TDD`) → _you_ follow their workflow. "Escalate to `Council`" means: read `Council/SKILL.md`, route to its workflow, dispatch its agents.

Provider neutrality rules:

- Use Shaka capability names (`research`, `architect`, `engineer`, `general`) and skill names, not provider tool names.
- If a sibling workflow says `Task`, `subagent_type`, or another provider-specific dispatch term, translate that to the active provider's Shaka-supported agent dispatch.
- If the active provider cannot launch true parallel agents, run independent passes sequentially. Preserve independence by giving each pass the same input and no prior reviewer output.
- If no research agent is available, do local code search directly and record that Phase 1 was local.

Sibling-skill routing is narrow:

- Use `FirstPrinciples/Challenge` when rejecting a defect depends on whether a premise is a hard constraint, soft constraint, or assumption.
- Use `Council/Quick` after Phase 3 for non-trivial plans. You may skip it only when the plan is narrow, Architect and Engineer converge cleanly, and all findings are nits.
- Use `Council/Debate` for major architecture choices, contested tradeoffs, or plans that would be expensive to unwind.
- Use `RedTeam/ParallelAnalysis` only when a rejected or contested premise would create high blast radius if wrong.

## The Quality Bar

The plan must answer **yes** to all of these. A `no` is a defect, not a preference.

1. **Clean architecture.** Boundaries match responsibilities. No hidden coupling.
2. **Idiomatic.** Follows the language's and framework's grain and the project's existing patterns.
3. **Simple-by-default.** Every abstraction earns its keep. Complexity must buy something concrete.
4. **Reads cold.** Names carry meaning, control flow is obvious, a fresh implementer can build from the plan alone.
5. **Correct.** Failure modes are named, not handwaved. Concurrency, ordering, lifecycle explicit.
6. **Right-sized.** No speculative features. No anticipatory scaffolding.
7. **Pleasant to work in.** The resulting code should feel intentional: clear names, low ceremony, cohesive files, and no generated-looking filler.

## The Loop

Each phase has an explicit exit.

### Phase 1 — Context

Spawn an available Research-capability agent to map the relevant code. The plan must be validated _against the actual codebase_.

**Exit (brownfield):** name the 3–7 files this plan would change and the patterns it must respect.
**Exit (new feature in an existing repo):** name the 2–4 sibling features whose conventions this plan inherits, and the directories the new code lands in.
**Exit (no repo or no sibling features):** name the author's stated constraints, missing assumptions, and the proposed directories or artifacts.

### Phase 2 — Adversarial pass (parallel)

Dispatch `Architect` and `Engineer` independently. Prefer parallel dispatch when available. Each gets the plan plus verbatim Phase-1 context — no shared state.

- **Architect**: structural fit, layering, hidden coupling, missing prerequisites, scaling/lifecycle gaps, contract ambiguities. Per-row audit of any failure-modes or acceptance tables.
- **Engineer**: idiomatic fit, simplicity, anti-slop, naming, error handling that names a real failure (not ceremonial try/catch). Smallest correct change?

Both must flag any AI-slop-shaped plan section: vague abstractions, ceremonial layers, generic error handling, overexplained names, or code shape that hides the simple idea.

Each returns: **blockers**, **mediums**, **nits**, **well-covered** (the last prevents over-correction).

### Phase 3 — Synthesize

- **Convergent** (both flagged): high-confidence defects. Fix.
- **Divergent** (only one): obvious call → one-line decision; otherwise escalate to `Council`.
- **Council check**: run `Council/Quick` unless the plan is narrow, both reviewers converge cleanly, and all findings are nits. Use `Council/Debate` for major architecture choices.
- **Premise audit**: for every defect you reject, write the rejection's premise. Verify load-bearing claims. False-premise rejections are bugs even when the conclusion is right.

**Exit:** every defect is in the ledger with a fix, an explicit carry-forward, or a rejection with a verified premise.

Carry-forward is allowed only for nits or for mediums that become implementation tasks with an owner, location, and acceptance check. A carried-forward medium prevents **Proceed** unless the plan itself names that task.

### Phase 4 — Cold-reader audit (mandatory)

Spawn a fresh `Intern` with explicit "you have no prior context" framing. Hand it the **revised** plan only. Ask for: self-containment defects, contract ambiguities, missing prerequisites, well-covered sections.

Skipping this phase ships gaps the author cannot see.

**Routing:**

- **Design-shape blockers** (a contract is wrong, a phase is missing) → loop back to Phase 2.
- **Interface gaps or mediums** (missing inputs, ambiguous artifact, undefined term) → patch the delta and continue.
- **Clean** → continue.

### Phase 5 — Verdict

- **Proceed.** No unresolved blockers or mediums. Carried-forward mediums are named as implementation tasks with acceptance checks. Plan is **implementation-ready** — never claim "production-ready" (that's a property of shipped code).
- **Revise.** Apply fixes and re-enter. **Local** changes (wording, ordering, single section) re-enter at Phase 4. **Structural** changes (a contract, a phase, a file in scope) re-enter at Phase 2.
- **Abandon.** The premise is wrong. State why and propose a replacement direction.

## Stop Conditions

A **loop iteration** = one full pass through Phases 1–5. Stop reviewing when **any** holds (between iterations, not within a pass):

- Severity drops two levels across consecutive passes (blockers → mediums → nits).
- Findings are about wording rather than design shape.
- A pass returns 0 blockers and ≤2 mediums, and every medium is fixed, rejected with evidence, or converted into a named implementation task.

After that, **TDD finds more than another review pass.** Ship to implementation.

## Authority

You have permission to challenge and override the user when the design is wrong. State the disagreement plainly, name the load-bearing premise, and propose the alternative. Don't smuggle disagreement into hedging.

## Anti-Patterns

- **Author-as-reviewer.** Skipping the cold-reader because "I read it carefully." Memory bias is invisible.
- **Convergent silence ≠ correctness.** When Architect and Engineer both miss a defect, convergence looks like signal but isn't. Phase 4 is the asymmetric check.
- **Phased-UX leakage.** Treating intermediate-phase UX as the v1 user model. Bootstrap gaps belong in test setup.
- **Table-as-decoration.** Failure-modes / acceptance-criteria tables are shippable contracts, not notes.
- **Polish loops.** A fourth review when the third only found prose nits.
- **Slop tolerance.** "Comprehensive error handling", "robust validation", "future-proof abstraction" — every one must name the concrete failure it prevents.
- **Consensus theater.** Convening Council to ratify a decision already made.

## Output Format

```markdown
## ValidatePlan: <plan title>

### Context
- Files in scope: <3–7 paths, or "new feature: <dirs> following <sibling-features>", or "no repo: <artifacts>">
- Patterns the plan must respect: <list>
- Missing assumptions: <none, or list>

### Convergent defects (Architect ∩ Engineer)
- <defect> — <blocker | medium | nit> — <fix>

### Divergent findings
- <point> — Architect: <view>; Engineer: <view> — Resolution: <decision>. <reasoning>.

### Council status
**<Quick run | Debate run | Skipped>** — <reason>

### Defect ledger
- Accepted: <defect> — <severity> — <fix in revised plan>
- Carried forward: <defect> — <severity> — <owner/location/acceptance check>
- Rejected: <defect> — <verified premise> — <evidence>

### Cold-reader status
**<Pass | Blocked — looped to Phase 2 | Patched in place>**
- <gap> — <where>

### Verdict
**<Proceed | Revise | Abandon>** — <one-sentence justification>

### Revised plan delta
<bullet diff against the original>
```
