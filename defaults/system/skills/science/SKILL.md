---
name: science
description: Applies hypothesis-test-analyze loops to narrow uncertainty with evidence. Use when a problem is iterative, multiple hypotheses are plausible, or experimentation is the right way to learn.
key: science
include_when: Iterative problem. Experimentation needed. Multiple hypotheses to test.
---

# science skill

Apply the scientific method with hypothesis formation, controlled testing, and analysis of results. Ideal for problems that require systematic experimentation.

## Workflow Routing

Route to the appropriate workflow based on the request.

| Trigger                       | Workflow                   |
| ----------------------------- | -------------------------- |
| Full scientific investigation | `Workflows/Investigate.md` |
| Quick hypothesis test         | `Workflows/QuickTest.md`   |

## Quick Reference

| Workflow        | Purpose                      | Output                                          |
| --------------- | ---------------------------- | ----------------------------------------------- |
| **Investigate** | Full scientific method cycle | Hypothesis → Experiment → Analysis → Conclusion |
| **QuickTest**   | Rapid hypothesis validation  | Single hypothesis → Test → Result               |

## The Six-Step Method

```
┌─────────────────────────────────────────────────────────┐
│  STEP 1: OBSERVE                                         │
│  Gather data about the current state                     │
│  What do we know? What patterns exist?                   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  STEP 2: HYPOTHESIZE                                     │
│  Form testable predictions                               │
│  "If X, then Y because Z"                                │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  STEP 3: DESIGN                                          │
│  Create experiments with controls                        │
│  What will you measure? What's the control?              │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  STEP 4: EXECUTE                                         │
│  Run experiments systematically                          │
│  Document everything, avoid bias                         │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  STEP 5: ANALYZE                                         │
│  Interpret results objectively                           │
│  Did results support or refute hypothesis?               │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  STEP 6: ITERATE                                         │
│  Refine hypotheses based on findings                     │
│  New questions → New cycle                               │
└─────────────────────────────────────────────────────────┘
```

## When to Use

- **Debugging**: "Something is wrong but I don't know what" → Form hypotheses, test systematically
- **Performance**: "It's slow but why?" → Hypothesize bottlenecks, measure each
- **Behavior**: "Users aren't converting" → Hypothesize causes, A/B test
- **Architecture**: "Will this scale?" → Hypothesize limits, load test

## Output Format

```markdown
## Scientific Analysis: [Topic]

### Observation

- **Current State**: [What we know]
- **Patterns**: [What we notice]
- **Anomalies**: [What's unexpected]

### Hypotheses

| #   | Hypothesis    | Testable Prediction  | Priority     |
| --- | ------------- | -------------------- | ------------ |
| 1   | [If X then Y] | [Measurable outcome] | High/Med/Low |

### Experiment Design

- **Variable**: [What we're changing]
- **Control**: [What stays constant]
- **Measurement**: [How we'll know]

### Results

| Hypothesis | Prediction | Actual     | Supported?     |
| ---------- | ---------- | ---------- | -------------- |
| H1         | [Expected] | [Observed] | Yes/No/Partial |

### Conclusion

- **Finding**: [What we learned]
- **Confidence**: [How certain]
- **Next Steps**: [Follow-up experiments or actions]
```

## Integration

**Works well with:**

- **first-principles** - Deconstruct before hypothesizing
- **Engineer** - Implement experiments
- **QATester** - Validate results

## Examples

**Example 1: Performance debugging**

```
"Why is the API slow on Mondays?"
→ Observe: Response times spike 3x on Monday mornings
→ Hypothesize: H1: Cache cold after weekend. H2: Traffic spike. H3: Batch jobs.
→ Test: Monitor cache hits, traffic volume, job scheduler
→ Result: H1 supported - cache hit rate drops from 95% to 40%
```

**Example 2: User behavior**

```
"Why aren't users completing onboarding?"
→ Observe: 60% drop-off at step 3
→ Hypothesize: H1: Form too long. H2: Unclear instructions. H3: Bug.
→ Test: Session recordings, form analytics, error logs
→ Result: H2 supported - users pause 30+ seconds at field X
```

---

**Last Updated:** 2026-02-02
