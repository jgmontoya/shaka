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

significantly, substantially, considerably, notably, remarkably, particularly, especially, importantly, essentially, fundamentally

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

### Fake Depth

- "serves as" (when "is" works)
- "highlights the importance of"
- "underscores the need for"
- "reflects the growing"
- "showcases the potential"
- "demonstrates the value"

---

## Structural Patterns to Avoid

**Rule of Three:** Don't string three adjectives together. Pick the most accurate single descriptor.

**Hourglass Structure:** Don't open broad, narrow to specifics, close broad. Instead: direct statement, evidence, conclusion.

**Even Paragraphing:** Vary paragraph length based on content needs.

**Same Sentence Rhythm:** Mix short punchy claims with complex constructions. Don't repeat subject-verb-object.

---

## Forbidden Comparison Structures

- "rather than"
- "not X, but Y"
- "less about X, more about Y"
- "It's not just X, it's Y"
- "Not only...but also"

---

## AI Behavioral Patterns to Avoid

**Synonym Cycling:** Pick one term for a concept and use it consistently. If the repetition sounds heavy, restructure the sentences instead of swapping synonyms.

**Importance Inflation:** State facts without inflating significance.

**Hedging:** Make direct claims.

**Generic Attribution:** Cite specific sources or omit.

---

## Punctuation

Use straight quotes and straight apostrophes, not curly. Limit em dash usage.

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
