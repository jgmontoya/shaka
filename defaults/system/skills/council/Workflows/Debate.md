# Debate Workflow

Full structured debate with 3 rounds and a visible transcript.

Running the **Debate** workflow in the **council** skill to compare perspectives...

## Prerequisites

- Topic or question to debate
- Optional: Custom council members (default: architect, designer, engineer, researcher)
- Read the shared [dispatch and fallback contract](../SKILL.md#dispatch-and-fallback)
  and [role mapping](../CouncilMembers.md).

## Execution

### Step 1: Announce the Council

Output the debate header:

```markdown
## Council Debate: [Topic]

**Council Members:** [List selected perspectives]
**Execution:** [Delegated agents / Sequential local perspectives / Mixed; limits]
**Rounds:** 3 (Positions → Responses → Synthesis)
```

### Step 2: Round 1 - Initial Positions

Gather one initial position per selected role using the shared dispatch and
fallback contract. Keep the original question and evidence the same for each
initial pass, without earlier positions. Complete all initial positions before
Round 2.

**Each agent prompt includes:**

```
You are [Council Role], [brief perspective from CouncilMembers.md].

COUNCIL DEBATE - ROUND 1: INITIAL POSITIONS

Topic: [The topic being debated]

Give your initial position on this topic from your specialized perspective.
- Speak in first person as your character
- Be specific and substantive (50-150 words)
- State your key concern, recommendation, or insight
- You'll respond to other council members in Round 2

Your perspective focuses on: [agent's domain]
```

Use the perspectives and available-agent selection in
[CouncilMembers.md](../CouncilMembers.md).

**Output each response as it completes:**

```markdown
### Round 1: Initial Positions

**🏛️ Architect (Serena):**
[Response]

**🎨 Designer (Aditi):**
[Response]

**⚙️ Engineer (Marcus):**
[Response]

**🔍 Researcher (Ava):**
[Response]
```

### Step 3: Round 2 - Responses & Challenges

Gather responses from the selected roles using the shared dispatch and fallback
contract. Give each the completed Round 1 transcript.

**Each agent prompt includes:**

```
You are [Agent Name], [brief role description].

COUNCIL DEBATE - ROUND 2: RESPONSES & CHALLENGES

Topic: [The topic being debated]

Here's what the council said in Round 1:
[Full Round 1 transcript]

Now respond to the other council members:
- Reference specific points they made ("I disagree with [Name]'s point about X...")
- Challenge assumptions or add nuance
- Build on points you agree with
- Maintain your specialized perspective
- 50-150 words

The value is in genuine intellectual friction—engage with their actual arguments.
```

**Output:**

```markdown
### Round 2: Responses & Challenges

**🏛️ Architect (Serena):**
[Response referencing others' points]

**🎨 Designer (Aditi):**
[Response referencing others' points]

**⚙️ Engineer (Marcus):**
[Response referencing others' points]

**🔍 Researcher (Ava):**
[Response referencing others' points]
```

### Step 4: Round 3 - Synthesis

Gather final positions from the selected roles using the shared dispatch and
fallback contract. Give each the completed Round 1 and Round 2 transcripts.

**Each agent prompt includes:**

```
You are [Agent Name], [brief role description].

COUNCIL DEBATE - ROUND 3: SYNTHESIS

Topic: [The topic being debated]

Full debate transcript so far:
[Round 1 + Round 2 transcripts]

Final synthesis from your perspective:
- Where does the council agree?
- Where do you still disagree with others?
- What's your final recommendation given the full discussion?
- 50-150 words

Be honest about remaining disagreements—forced consensus is worse than acknowledged tension.
```

**Output:**

```markdown
### Round 3: Synthesis

**🏛️ Architect (Serena):**
[Final synthesis]

**🎨 Designer (Aditi):**
[Final synthesis]

**⚙️ Engineer (Marcus):**
[Final synthesis]

**🔍 Researcher (Ava):**
[Final synthesis]
```

### Step 5: Council Synthesis

After all rounds complete, synthesize the debate:

```markdown
### Council Synthesis

**Areas of Convergence:**

- [Points where selected perspectives agree, with supporting evidence]
- [Shared concerns or recommendations]

**Remaining Disagreements:**

- [Points still contested between perspectives]
- [Trade-offs that couldn't be resolved]

**Recommended Path:**
[Based on evidence and weight of arguments, the recommended approach is...]
```

## Custom Council Members

Apply the user's requested composition using
[CouncilMembers.md](../CouncilMembers.md). That file owns the role mapping for
both workflows.

## Done

Debate complete. The transcript shows the full intellectual journey from initial positions through challenges to synthesis.
