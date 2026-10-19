# Quick Workflow

Fast single-round perspective check. Use for sanity checks and quick feedback.

Running the **Quick** workflow in the **council** skill to get fast perspectives...

## Prerequisites

- Topic or question to evaluate
- Optional: Custom council members
- Read the shared [dispatch and fallback contract](../SKILL.md#dispatch-and-fallback)
  and [role mapping](../CouncilMembers.md).

## Execution

### Step 1: Announce Quick Council

```markdown
## Quick Council: [Topic]

**Council Members:** [List selected perspectives]
**Execution:** [Delegated agents / Sequential local perspectives / Mixed; limits]
**Mode:** Single round (fast perspectives)
```

### Step 2: Gather Initial Perspectives

Gather one initial position per selected role using the shared dispatch and
fallback contract. Keep initial inputs separate from earlier positions; only
synthesize after all selected perspectives are complete.

**Each agent prompt:**

```
You are [Agent Name], [brief role description].

QUICK COUNCIL CHECK

Topic: [The topic]

Give your immediate take from your specialized perspective:
- Key concern, insight, or recommendation
- 30-50 words max
- Be direct and specific

This is a quick sanity check, not a full debate.
```

### Step 3: Output Perspectives

```markdown
### Perspectives

**🏛️ Architect (Serena):**
[Brief take]

**🎨 Designer (Aditi):**
[Brief take]

**⚙️ Engineer (Marcus):**
[Brief take]

**🔍 Researcher (Ava):**
[Brief take]

### Quick Summary

**Consensus:** [Do they generally agree? On what?]
**Concerns:** [Any red flags raised?]
**Recommendation:** [Proceed / Reconsider / Need full debate]
```

## When to Escalate

If the quick check reveals significant disagreement or complex trade-offs, recommend:

```
⚠️ This topic has enough complexity for a full council debate.
Run: "Council: [topic]" for 3-round structured discussion.
```

## Done

Quick perspectives gathered. Use for fast validation; escalate to DEBATE for complex decisions.
