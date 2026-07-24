---
name: red-team
description: Stress-tests an idea through adversarial analysis, steelmanning, and concrete counterarguments. Use when claims need pressure-testing, failure modes may be subtle, or security and robustness matter.
key: redteam
include_when: Claims need stress-testing. Security implications. Could fail non-obviously.
---

# red-team Skill

Pressure-test claims, plans, architectures, and security designs. Size the
analysis to the task, preserve independent first passes when multiple
perspectives add value, and prefer concrete evidence over vote counts. The core
deliverables are a fair steelman, the strongest surviving counter-argument, and
an explicit stop reason.

## Workflow Routing

Route to the workflow that matches the requested outcome.

**When executing a workflow, output this notification directly:**

```pseudocode
Running the **WorkflowName** workflow in the **red-team** skill to ACTION...
```

| Trigger                                                      | Workflow                             |
| ------------------------------------------------------------ | ------------------------------------ |
| Red team analysis (stress-test existing content)             | `Workflows/ParallelAnalysis.md`      |
| Adversarial validation (produce new content via competition) | `Workflows/AdversarialValidation.md` |

## Quick Reference

| Workflow                  | Purpose                             | Output summary                                  |
| ------------------------- | ----------------------------------- | ----------------------------------------------- |
| **ParallelAnalysis**      | Stress-test existing content        | Steelman + counter-argument (8 points each)     |
| **AdversarialValidation** | Produce new content via competition | Synthesized solution from competing proposals   |

The output column is a routing summary. Follow the selected workflow and
`Integration.md` for its full contract.

**ParallelAnalysis protocol:**

1. Frame the core position and its independently falsifiable assumptions.
2. Size the work to the task, host capacity, and user budget.
3. Preserve independent first passes before sharing findings.
4. Synthesize evidence, discard speculation, and state the resulting judgment.
5. Present the steelman, counter-argument, stop reason, and unresolved concerns.

## Context Files

- `Philosophy.md`: Core philosophy, success criteria, and evidence standards
- `Integration.md`: Optional integrations and output contract

## Examples

**Stress-test an architecture proposal:**

```text
User: "red team this microservices migration plan"
--> Workflows/ParallelAnalysis.md
--> Returns the strongest steelman and surviving counter-argument
```

**Compare competing approaches before creating a design:**

```text
User: "battle of bots - which approach is better for this feature?"
--> Workflows/AdversarialValidation.md
--> Synthesizes a solution from competing proposals
```

---

**Last Updated:** 2026-07-23
