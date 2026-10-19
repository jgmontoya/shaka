# Round Structure

How council debates progress through rounds.

## Three-Round Debate Structure

### Round 1 - Initial Positions

Each selected perspective establishes its initial position from the original
question and evidence, before reading the other positions. Follow the shared
[dispatch and fallback contract](SKILL.md#dispatch-and-fallback).

**Goal:** Surface diverse viewpoints before interaction.

### Round 2 - Responses & Challenges

Each perspective reads the completed Round 1 transcript and responds to specific points:

- "I disagree with Architect's point about X because..."
- "Building on Designer's concern about Y..."

**Goal:** Genuine intellectual friction through direct engagement.

### Round 3 - Synthesis & Convergence

Each perspective reads both completed earlier rounds and identifies:

- Where the council agrees
- Where they still disagree
- Their final recommendation given the full discussion

**Goal:** Surface convergence and remaining tensions honestly.

## The Value Is In Interaction

Not just collecting opinions - genuine challenges where:

- Architect challenges designer's assumption
- Engineer points out implementation cost
- Researcher cites precedent that changes framing
- Designer defends with user impact data

## Execution

Rounds are sequential. Within a round, run available agents concurrently only
within host capacity, or gather perspectives sequentially under the shared
dispatch contract. Duration depends on the question, evidence, and provider.
Disclose capacity limits and any local fallback instead of promising a fixed
duration or treating the default composition as a required agent count.
