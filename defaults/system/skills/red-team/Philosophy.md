# Red Team Philosophy

## Origin

Red teaming uses an independent, adversarial perspective to expose weaknesses
before they become costly failures.

## Core Insight

The goal is not destruction. It is to find the assumption, logical gap, or
counterexample that most changes the decision while representing the original
position fairly.

The strongest critique often rests on one core issue:

- a hidden assumption that is false or unsupported;
- a logical step that does not follow;
- a category error;
- a relevant counterexample or precedent;
- a failure mode the proposal does not contain.

## Success Criteria

- The steelman is strong enough that a proponent recognizes their position.
- The counter-argument defeats that steelman, not a weaker substitute.
- Findings identify a concrete mechanism and evidence suited to the task.
- A well-supported lone finding survives even when other perspectives miss it.
- Unsupported speculation and low-value nitpicks are discarded.
- The conclusion states what remains unresolved and why the analysis stopped.

## Task-Sized Independence

Use only the perspectives that can examine distinct failure
mechanisms. A narrow claim may need one local pass. A broader design may benefit
from a small set of independent first passes.

Host capacity and the user's budget are ceilings, never targets. Work
sequentially when parallel execution is unavailable. Do not share sibling
conclusions until the initial passes are complete.

## Evidence Over Consensus

Agent count is not confidence. Prefer reproduction, supplied facts, violated
constraints, counterexamples, and explicit logical gaps. Similar conclusions
matter when they arise from independent evidence, but agreement cannot rescue
an unsupported finding.

---

**Last Updated:** 2026-07-23
