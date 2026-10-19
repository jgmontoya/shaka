---
name: council
description: Surfaces stronger decisions through structured debate across competing perspectives, using available agents or clearly labeled local passes. Use when several plausible approaches exist and the tradeoffs need to be argued, not just listed.
key: council
include_when: Multiple valid approaches exist. Design decisions with no clear winner.
---

# council skill

Discuss topics in rounds, respond to specific arguments, and surface insights
through competing perspectives. Use available agents when authorized, with an
honest local fallback when delegation is unavailable.

**Key Differentiator from red-team:** Council is collaborative-adversarial (debate to find best path), while red-team is purely adversarial (attack the idea). Council produces visible conversation transcripts; red-team produces steelman + counter-argument.

## Workflow Routing

Route to the appropriate workflow based on the request.

**When executing a workflow, output this notification directly:**

```
Running the **WorkflowName** workflow in the **council** skill to ACTION...
```

| Trigger | Workflow |
| --- | --- |
| Full structured debate (3 rounds, visible transcript) | [Debate](Workflows/Debate.md) |
| Quick consensus check (1 round, fast) | [Quick](Workflows/Quick.md) |
| Pure adversarial analysis | red-team skill |

## Quick Reference

| Workflow   | Purpose                    | Rounds | Output                          |
| ---------- | -------------------------- | ------ | ------------------------------- |
| **DEBATE** | Full structured discussion | 3      | Complete transcript + synthesis |
| **QUICK**  | Fast perspective check     | 1      | Initial positions only          |

## Context Files

| File | Content |
| --- | --- |
| [CouncilMembers.md](CouncilMembers.md) | Agent roles, perspectives, voice mapping |
| [RoundStructure.md](RoundStructure.md) | Three-round debate structure and execution |
| [OutputFormat.md](OutputFormat.md) | Transcript format templates |

## Dispatch and Fallback

Pick the perspectives relevant to the question from
[CouncilMembers.md](CouncilMembers.md), honoring any composition the user asked for.

**Delegated:** dispatch one agent per perspective through the active provider.
Run them concurrently when the host allows, sequentially otherwise. Finish each
round before starting the next.

**Local fallback:** if delegation is unavailable, denied, or blocked (for
example by nesting limits), play each perspective yourself, one at a time. If
only some roles lack an agent, cover those locally and report mixed execution.
Never work around a denial.

**Isolation:** every initial position gets the same question and evidence, and
none of the other positions. Collect all initial positions before Round 2 or
synthesis. Later rounds get the full transcripts of earlier rounds. Local passes
share your context, so they are perspectives, not independent agents; say so.

**Disclosure:** state the execution mode (delegated, local, or mixed), any
capacity limits, and which roles ran locally. Claim parallel or independent work
only when it happened.

## Core Philosophy

**Origin:** Best decisions emerge from diverse perspectives challenging each other. Not just collecting opinions - genuine intellectual friction where experts respond to each other's actual points.

**Scope:** Keep the selected perspectives and depth proportional to the decision.
Host capacity and the user's budget are limits, not targets. There is no fixed
agent count or completion-time promise.

## Examples

```
"Council: Should we use WebSockets or SSE?"
-> Invokes DEBATE workflow -> 3-round transcript

"Quick council check: Is this API design reasonable?"
-> Invokes QUICK workflow -> Fast perspectives

"Council with security: Evaluate this auth approach"
-> DEBATE with Security agent added
```

## Integration

**Works well with:**

- **red-team** - Pure adversarial attack after collaborative discussion
- **Development** - Before major architectural decisions
- **Research** - Gather context before convening the council

## Best Practices

1. Use QUICK for sanity checks, DEBATE for important decisions
2. Add domain-specific experts as needed (security for auth, etc.)
3. Review the transcript - insights are in the responses, not just positions
4. Weigh evidence and arguments; agreement alone does not establish correctness

---

**Last Updated:** 2026-10-19
