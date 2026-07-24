# Compact Task-Sized Red Team

## Outcome

Pressure-test the supplied claim, plan, architecture, or security design and
return:

1. the strongest fair steelman;
2. the strongest surviving counter-argument;
3. concrete findings supported by evidence suited to the task;
4. the reason the analysis stopped and any unresolved concern.

Reviewing a security claim or design is in scope. Active scanning, exploitation,
or access to systems outside the supplied material is not.

## Protocol

### Frame the review

State the core position and decompose only the claims and assumptions that can
fail independently. Keep the decomposition proportional to the task; claim
count is not a goal.

Identify what evidence would confirm or defeat the important claims. Separate
facts in the supplied material from assumptions and open questions.

### Size the work

Handle a narrow review locally. When several independent perspectives could
change the result and the active harness exposes agent delegation, use available
subagents for the initial passes, commonly two to four. Run them concurrently
when supported; otherwise dispatch them sequentially. Host capacity and the
user's budget are ceilings, never targets.

If subagents are unavailable, disabled, denied, exhausted, or blocked by nesting
limits, perform the same focused passes sequentially in the current agent. Do
not describe local passes as independent agents.

Choose perspectives that fit the task; do not fill a fixed roster. Before
synthesis, keep each initial perspective focused on the original material, its
assigned question, and the same evidence standard. Do not feed conclusions from
earlier passes into later ones.

### Synthesize

Compare the independent first passes after they finish. Prefer concrete
evidence, reproduction, violated constraints, and explicit logical gaps over
vote counts or rhetorical force. Similar conclusions based on different facts
may strengthen a finding. A well-supported lone finding must not be discarded
merely because other passes missed it.

Discard nitpicks and unsupported speculation. Explain whether the core position
is sound, sound only after changes, or unsound.

### Steelman

Produce exactly eight numbered points of 12-16 words. Reconstruct the strongest
version of the position, using its best evidence and assumptions. Each point
must stand alone and the sequence must form a coherent case.

### Counter-argument

Produce exactly eight numbered points of 12-16 words. Attack the steelman, not a
weaker substitute. Surface hidden assumptions, counterexamples, invalid causal
steps, and second-order effects. Lead to the strongest decision-relevant
objection.

### Stop

Stop when another pass is unlikely to change the decision, the available work
is exhausted, or the host or user budget is reached. State the applicable stop
reason and unresolved concerns. State whether the review used subagents or
sequential local passes. There is no required review-pass count or minimum
runtime.
