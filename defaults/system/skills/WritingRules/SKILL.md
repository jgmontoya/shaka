---
name: WritingRules
description: Anti-slop writing constraints. USE WHEN writing prose, blog posts, social media, documentation, explanations.
key: writingrules
include_when: Output is prose for humans — blog posts, social media, docs, emails, explanations. NOT for code, commits, or terminal output.
---

# WritingRules Skill

Style constraints for clear, direct writing. When included, apply these rules to all prose output in the current response.

**No workflows or routing needed.** When INCLUDED in the Thinking Tools Assessment, apply all rules below to every prose artifact produced.

---

## Core Principle

Write like a human expert talking to a peer. If it sounds like marketing copy or a corporate press release, rewrite it.

**The acid test:** Would a real human expert say this out loud in conversation?

- If no: rewrite
- If maybe: simplify
- If yes: keep

---

## Banned Words

### Dead Giveaways (never use)

delve, tapestry, testament, pivotal, multifaceted, realm, landscape (metaphorical), embark, beacon

### Overused Adjectives

robust, crucial, vital, seamless, comprehensive, innovative, cutting-edge, revolutionary, unparalleled, meticulous, compelling, intricate, vibrant, quiet (as descriptor), nuanced

### Corporate Buzzwords

leverage, utilize, synergy, ecosystem, paradigm, stakeholder, holistic, proactive, empower, foster, facilitate, optimize, streamline, game-changing, best-in-class

### Vague Intensifiers

significantly, substantially, considerably, notably, remarkably, particularly, especially, importantly, essentially, fundamentally, genuinely, honestly, literally

---

## Banned Phrases

### Opening Cliches

- "In today's fast-paced world"
- "In today's digital landscape"
- "In today's ever-evolving"
- "Welcome to the world of"
- "Dive into"
- "Let's explore"
- "Join us as we"

### Transition Zombies

- "Moreover,"
- "Furthermore,"
- "Additionally,"
- "In summary,"
- "In conclusion,"
- "In essence,"
- "It's important to note"
- "It's worth noting"
- "It bears mentioning"
- "Let's be clear"
- "To be clear"
- "Make no mistake"
- "Certainly!"

### Empty Emphasis

- "At its core"
- "At the heart of"
- "The bottom line is"
- "The reality is"
- "The truth is"
- "And that's a [adjective] thing"
- "marks a shift"
- "represents a breakthrough"
- "Full stop."
- "Let that sink in."

### Fake Depth

- "serves as" (when "is" works)
- "highlights the importance of"
- "underscores the need for"
- "reflects the growing"
- "showcases the potential"
- "demonstrates the value"

### Rhetorical Setups

- "What if [reframe]?"
- "Here's what I mean:"
- "Here's the thing:"
- "Think about it:"
- "And that's okay."
- "I promise"

These announce insight instead of delivering it. Make the point. Let readers draw conclusions.

---

## Structural Patterns to Avoid

**Rule of Three:** Don't string three adjectives together. Pick the most accurate single descriptor.

**Hourglass Structure:** Don't open broad, narrow to specifics, close broad. Instead: direct statement, evidence, conclusion.

**Even Paragraphing:** Vary paragraph length based on content needs.

**Same Sentence Rhythm:** Mix short punchy claims with complex constructions. Don't repeat subject-verb-object.

**Dramatic Fragmentation:** Don't use sentence fragments for manufactured profundity. "X. That's it. That's the thing." and "This unlocks something. Freedom." are presentation tricks. Write complete sentences.

---

## Forbidden Comparison Structures

- "rather than"
- "not X, but Y"
- "less about X, more about Y"
- "It's not just X, it's Y"
- "Not only...but also"
- "Not because X. Because Y."
- "X isn't the problem. Y is."
- "It feels like X. It's actually Y."

State Y directly. Drop the negation.

---

## AI Behavioral Patterns to Avoid

**Synonym Cycling:** Pick one term for a concept and use it consistently. If the repetition sounds heavy, restructure the sentences instead of swapping synonyms.

**Importance Inflation:** State facts without inflating significance.

**Hedging:** Make direct claims.

**Generic Attribution:** Cite specific sources or omit.

**False Agency:** Don't give inanimate objects human verbs. AI does this to avoid naming actors.

| Slop | Fix |
| --- | --- |
| "a complaint becomes a fix" | "the team fixed it that week" |
| "the decision emerges" | "the lead decided" |
| "the data tells us" | "we read the data and concluded" |
| "the culture shifts" | "people changed how they worked" |
| "the market rewards" | "buyers pay for it" |

Name the human. If no specific person fits, use "you."

**Narrator-from-a-Distance:** Don't float above the scene like a documentarian. Put the reader in the room.

| Slop | Fix |
| --- | --- |
| "Nobody designed this." | "You don't sit down one day and decide to..." |
| "This happens because..." | "You hit this when..." |
| "People tend to..." | "You'll find that..." |

---

## Punctuation

Use straight quotes and straight apostrophes, not curly. No em dashes. They are one of the most consistent AI tells. Use commas or periods instead.

---

## Replacements

| Instead of    | Use                  |
| ------------- | -------------------- |
| utilize       | use                  |
| leverage      | use                  |
| delve into    | examine, explore     |
| robust        | strong, solid        |
| seamless      | smooth, integrated   |
| innovative    | new, novel           |
| comprehensive | complete, full       |
| facilitate    | help, enable         |
| optimize      | improve              |
| stakeholder   | [specific role]      |
| ecosystem     | system, environment  |
| journey       | process, path        |
| landscape     | field, area          |
| realm         | domain, field        |
| tapestry      | mix, combination     |
| pivotal       | important, key       |
| crucial       | important, necessary |
| navigate      | handle               |
| unpack        | explain              |
| lean into     | accept, embrace      |

---

## Examples

**Before:** Here's the thing: what makes great documentation isn't just clarity, it's empathy. The conversation shifts when teams genuinely start to lean into user feedback. And that's a good thing.

**After:** Great documentation explains things from the reader's position. Teams that read user feedback write better docs.

**Before:** The implications are significant. This fundamentally represents a breakthrough in how organizations navigate the complexities of distributed systems.

**After:** Distributed systems got easier to run. Here's what changed.

**Before:** Nobody designed this system to fail. It happens because people tend to optimize for speed, not resilience. Not always. Not perfectly. But consistently.

**After:** You build for speed because the deadline is Friday. Resilience gets cut from the sprint. The system breaks under load and you spend the weekend fixing it.

---

## Automated Validation

Use `shaka scan` to check prose files for violations:

```bash
shaka scan <file.md>            # Scan a file
shaka scan --dir <path>         # Scan all .md files in a directory
echo "text" | shaka scan --stdin  # Scan from stdin
shaka scan --json <file.md>     # JSON output (for CI)
```

Scores content on a 100-point scale. Pass threshold: 80+.

---

_Override by placing a custom `SKILL.md` in your `customizations/skills/WritingRules/` directory._
