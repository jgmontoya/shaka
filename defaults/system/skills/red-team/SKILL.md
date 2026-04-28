---
name: red-team
description: Stress-tests an idea through adversarial analysis, steelmanning, and concrete counterarguments. Use when claims need pressure-testing, failure modes may be subtle, or security and robustness matter.
key: redteam
include_when: Claims need stress-testing. Security implications. Could fail non-obviously.
---

# red-team Skill

Military-grade adversarial analysis using parallel agent deployment. Breaks arguments into atomic components, attacks from 32 expert perspectives (engineers, architects, pentesters, interns), synthesizes findings, and produces devastating counter-arguments with steelman representations.

## Workflow Routing

Route to the appropriate workflow based on the request.

**When executing a workflow, output this notification directly:**

```pseudocode
Running the **WorkflowName** workflow in the **red-team** skill to ACTION...
```

| Trigger                                                      | Workflow                             |
| ------------------------------------------------------------ | ------------------------------------ |
| Red team analysis (stress-test existing content)             | `Workflows/ParallelAnalysis.md`      |
| Adversarial validation (produce new content via competition) | `Workflows/AdversarialValidation.md` |

---

## Quick Reference

| Workflow                  | Purpose                             | Output                                        |
| ------------------------- | ----------------------------------- | --------------------------------------------- |
| **ParallelAnalysis**      | Stress-test existing content        | Steelman + Counter-argument (8-points each)   |
| **AdversarialValidation** | Produce new content via competition | Synthesized solution from competing proposals |

**The Five-Phase Protocol (ParallelAnalysis):**

1. **Decomposition** - Break into 24 atomic claims
2. **Parallel Analysis** - 32 agents examine strengths AND weaknesses
3. **Synthesis** - Identify convergent insights
4. **Steelman** - Strongest version of the argument
5. **Counter-Argument** - Strongest rebuttal

---

## Context Files

- `Philosophy.md` - Core philosophy, success criteria, agent types
- `Integration.md` - Skill integration, first-principles usage, output format

---

## Examples

**Attack an architecture proposal:**

```
User: "red team this microservices migration plan"
--> Workflows/ParallelAnalysis.md
--> Returns steelman + devastating counter-argument (8 points each)
```

**Devil's advocate on a business decision:**

```
User: "poke holes in my plan to raise prices 20%"
--> Workflows/ParallelAnalysis.md
--> Surfaces the ONE core issue that could collapse the plan
```

**Adversarial validation for content:**

```
User: "battle of bots - which approach is better for this feature?"
--> Workflows/AdversarialValidation.md
--> Synthesizes best solution from competing ideas
```

---

**Last Updated:** 2025-12-20
