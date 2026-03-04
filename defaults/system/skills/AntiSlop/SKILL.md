---
name: AntiSlop
description: Detect and eliminate AI writing patterns (slop) from prose output. USE WHEN writing, review prose, check quality, anti-slop scan, detect AI patterns, clean up writing.
key: antislop
include_when: Writing prose content. Reviewing drafts. Quality checking written output.
---

## Customization

**Before executing, check for user customizations at:**
`${SHAKA_HOME}/customizations/skills/AntiSlop/`

If this directory exists, load and apply any PREFERENCES.md, configurations, or resources found there. These override default behavior. If the directory does not exist, proceed with skill defaults.

# AntiSlop Skill

A systematic framework for detecting and eliminating AI-generated writing patterns ("slop") from prose output. AI writing has distinctive patterns: predictable vocabulary, formulaic structures, significance inflation, and mechanical transitions. This skill provides rules, detection patterns, and a scanner tool to enforce quality.

## Definition of Slop

Content that reads as AI-generated, characterized by:

- Predictable vocabulary choices (the same 50 words LLMs overuse)
- Formulaic structures (hourglass shape, rule of three)
- Significance inflation (ordinary events described as pivotal/transformative)
- Mechanical transitions (Moreover, Furthermore, Additionally)
- Hedging and qualification instead of direct claims
- Synonym cycling instead of consistent terminology

## Workflow Routing

Route to the appropriate workflow based on the request.

**When executing a workflow, output this notification directly:**

```
Running the **WorkflowName** workflow in the **AntiSlop** skill to ACTION...
```

| Trigger | Workflow |
| --- | --- |
| Scan existing content for slop | `Workflows/Scan.md` |
| Apply anti-slop rules while writing | `Workflows/Write.md` |

## Quick Reference

### Banned Words (NEVER USE)

#### Tier 1 -- Dead Giveaways

delve, tapestry, testament, pivotal, multifaceted, realm, landscape (metaphorical), embark, beacon

#### Tier 2 -- Overused Adjectives

robust, crucial, vital, seamless, comprehensive, innovative, cutting-edge, revolutionary, unparalleled, meticulous, compelling, intricate, vibrant, nuanced, quiet (as descriptor)

#### Tier 3 -- Corporate Buzzwords

leverage, utilize, synergy, ecosystem, paradigm, stakeholder, holistic, proactive, empower, foster, facilitate, optimize, streamline, game-changing, best-in-class

#### Tier 4 -- Vague Intensifiers

significantly, substantially, considerably, notably, remarkably, particularly, especially, importantly, essentially, fundamentally

#### Tier 5 -- Additional AI Tells

genuine, straightforward, unlock, navigate (metaphorical), underscores, journey, arguably, excels, moreover, furthermore, additionally, dive into, merely, demonstrates, demonstrated, demonstrating, instructive, leveraging, leveraged, perhaps (as hedge), might (as hedge)

### Quick Replacements

| Banned | Use Instead |
| --- | --- |
| utilize / leverage | use |
| robust | strong, solid |
| seamless | smooth |
| innovative | new, novel |
| comprehensive | complete, full |
| facilitate | help, enable |
| optimize | improve |
| ecosystem | system, environment |
| journey | process, path |
| landscape | field, area |
| realm | domain, field |
| delve | examine, study |
| tapestry | mix, combination |
| pivotal | important, key |
| crucial | important, necessary |

### Banned Phrases

**Opening cliches:** "In today's fast-paced world", "In today's digital landscape", "Welcome to the world of", "Dive into", "Let's explore", "Join us as we"

**Transition zombies:** "Moreover,", "Furthermore,", "Additionally,", "In summary,", "In conclusion,", "In essence,", "It's important to note", "It's worth noting", "It bears mentioning", "Let's be clear", "To be clear", "Make no mistake", "Certainly!"

**Empty emphasis:** "At its core", "At the heart of", "The bottom line is", "The reality is", "The truth is", "And that's a [adjective] thing", "marks a shift", "represents a breakthrough"

**Fake depth:** "serves as" (when "is" works), "highlights the importance of", "underscores the need for", "reflects the growing", "showcases the potential", "demonstrates the value"

**Vague attribution:** "experts say", "observers note", "studies show", "reports indicate" (cite specifics or omit)

**Chatbot artifacts:** "I hope this helps", "Let me know if you need", "Certainly!"

### Banned Structures

- **Comparison structures:** "rather than", "not X, but Y", "less about X, more about Y", "It's not just X, it's Y", "Not only...but also"
- **Rule of three:** Forcing ideas into artificial triplets ("innovative, comprehensive, and transformative"). Pick the most accurate single descriptor.
- **Hourglass structure:** Broad opening, specifics, broad closing. Use: direct statement, evidence, conclusion.
- **Even paragraphing:** All paragraphs similar length. Vary based on content needs.
- **Same sentence rhythm:** Every sentence follows subject-verb-object. Mix short punchy claims with complex constructions.

### Banned Punctuation

- Em dashes as casual punctuation. Use commas or restructure.
- Curly/smart quotes. Use straight quotes only.
- Excessive colons, semicolons, and parenthetical asides.
- Exclamation marks in published prose. Reserve for direct quotes only.

### Sentence-Level Rewrites

When you catch yourself generating these, rewrite immediately:

| AI Generates | Rewrite To |
| --- | --- |
| "This is important because..." | State the reason directly |
| "There are several reasons..." | Name the first reason and argue it |
| "It should be noted that X" | X |
| "X plays a crucial role in Y" | X does Y |
| "This represents a significant..." | State what it IS, concretely |
| "In order to..." | "To..." |
| "[Topic] is a complex issue" | State the specific complexity |
| "When it comes to X" | Start with X directly |
| "X serves as Y" | "X is Y" |

### Copula Avoidance

Kill these constructions:

- "serves as a reminder" -> "is a reminder" (or just state the reminder)
- "acts as a bridge" -> "bridges" or "connects"
- "functions as a mechanism" -> "is" or use a verb

### AI Behavioral Patterns to Avoid

- **Significance inflation:** Treating ordinary events as pivotal/transformative
- **Superficial analysis verbs:** "highlighting", "reflecting", "showcasing"
- **Synonym cycling:** Pick one term for a concept and reuse it. Do NOT rotate synonyms to avoid repetition. WRONG: "The protocol uses encryption. This cryptographic approach enables privacy. The cipher system protects data." RIGHT: "The protocol uses encryption. Encryption enables privacy. Encryption protects data." If repetition sounds heavy, restructure the sentences instead of swapping synonyms.
- **Constant importance inflation:** State facts without inflating significance
- **Hedging and qualification:** Make direct claims
- **Generic attribution:** Cite specific sources or omit
- **Repeated sentence openings:** Consecutive sentences starting with the same word (anaphora without rhetorical purpose)
- **Rhetorical questions as argument:** State the point directly
- **Choppy equal-length sentences:** Vary sentence length deliberately

## The Acid Test

Would a real human expert say this out loud in conversation?

- If no: rewrite
- If maybe: simplify
- If yes: keep

## Scanner Tool

A CLI scanner is available at `Tools/anti-slop-scanner.ts` for automated detection:

```bash
# Scan a single file
bun ${SHAKA_HOME}/skills/AntiSlop/Tools/anti-slop-scanner.ts <file.md>

# Scan a directory
bun ${SHAKA_HOME}/skills/AntiSlop/Tools/anti-slop-scanner.ts --dir <path>

# Scan from stdin
bun ${SHAKA_HOME}/skills/AntiSlop/Tools/anti-slop-scanner.ts --stdin

# JSON output
bun ${SHAKA_HOME}/skills/AntiSlop/Tools/anti-slop-scanner.ts --json <file.md>

# Per-paragraph breakdown
bun ${SHAKA_HOME}/skills/AntiSlop/Tools/anti-slop-scanner.ts --paragraph <file.md>
```

The scanner scores content on a 100-point scale. A passing score is 95+.

### Scoring

| Violation Type | Points Deducted |
| --- | --- |
| Cardinal sins (comparison structures) | -20 each |
| Banned words | -2 each |
| Banned constructions | -2 each |
| AI tells | -3 each |
| Dash violations | -5 each |
| Rhythm issues | -5 each |
| Hedging | -2 each |

### Customizing the Scanner

Users can customize the scanner by placing an `anti-slop-overrides.json` file in their customizations directory (`${SHAKA_HOME}/customizations/skills/AntiSlop/`). The JSON file can contain:

```json
{
  "additionalBannedWords": {
    "word": "suggested replacement"
  },
  "additionalBannedConstructions": [
    { "pattern": "regex pattern", "name": "display name", "suggestion": "fix" }
  ],
  "passThreshold": 95
}
```

## Implementation Rules

1. This framework applies to all prose output (documentation, blog posts, comments, messages)
2. No exceptions for "professional" writing -- clarity beats corporate speak
3. Check before output -- run the detection checklist mentally
4. When in doubt, simplify

**Remember:** Real experts speak clearly. If it sounds like marketing copy or a corporate press release, it's slop. Write like a human who knows their field and respects their reader's intelligence.
