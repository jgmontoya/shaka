# Output Format

Standard format for council debate transcripts.

Examples show the default roles. Include only selected perspectives, using the
shared [role mapping](CouncilMembers.md) and
[dispatch and fallback contract](SKILL.md#dispatch-and-fallback). Role labels
identify viewpoints; the Execution line states whether separate agents or local
passes produced them.

## Full Debate Transcript

```markdown
## Council Debate: [Topic]

**Execution:** [Delegated agents / Sequential local perspectives / Mixed; limits]

### Round 1: Initial Positions

**Architect (Serena):**
[Position from architectural perspective]

**Designer (Aditi):**
[Position from design perspective]

**Engineer (Marcus):**
[Position from implementation perspective]

**Researcher (Ava):**
[Position with data/precedent]

### Round 2: Responses & Challenges

**Architect (Serena):**
[Responds to specific points from Round 1]

**Designer (Aditi):**
[Responds to specific points from Round 1]

[...]

### Round 3: Synthesis

**Architect (Serena):**
[Final position, areas of agreement/disagreement]

[...]

### Council Synthesis

**Areas of Convergence:**

- [Points where multiple perspectives agreed, with supporting evidence]

**Remaining Disagreements:**

- [Points still contested]

**Recommended Path:**
[Synthesized recommendation]
```

## Quick Council Format

```markdown
## Quick Council: [Topic]

**Execution:** [Delegated agents / Sequential local perspectives / Mixed; limits]

### Perspectives

**Architect (Serena):**
[Brief take - 30-50 words]

**Designer (Aditi):**
[Brief take]

[...]

### Quick Summary

**Consensus:** [Do they agree? On what?]
**Concerns:** [Red flags raised?]
**Recommendation:** [Proceed / Reconsider / Need full debate]
```

## Output Requirements

- **Length:** 50-150 words per perspective per round (debate), 30-50 words (quick)
- **Tone:** Professional but direct; genuine challenges
- **Must Include:** Specific references to other perspectives' points in Round 2+
- **Must Avoid:** Generic opinions, restating initial position without engagement
