# Write Workflow

Apply anti-slop rules while writing prose content. This workflow is invoked when the assistant is producing written output and needs to enforce quality standards inline.

## Steps

1. **Load rules**: Internalize the banned words, phrases, structures, and behavioral patterns from the SKILL.md reference
2. **Pre-write check**: Before each paragraph, silently decide: what is the one claim, what grounds it, what is the landing sentence
3. **Draft with enforcement**: While writing, actively avoid all banned patterns. If you catch yourself generating a banned pattern, rewrite immediately
4. **Per-paragraph self-check**: After each paragraph, verify:
   - One claim per paragraph
   - Grounded in concrete example, not just abstraction
   - Final sentence lands with force or advances the argument
   - Zero banned words, no hedging, no rhetorical questions
   - Sentence lengths vary, no three same-length in sequence
   - Flows from the previous paragraph without mechanical transitions
5. **Final validation**: Run the complete content through the scanner tool if available, or perform a manual check against the full banned list

## Key Principles

- **State what things ARE.** Open with a bold claim or concrete scenario.
- **Vary sentence length deliberately.** Short sentences land hard because the long ones earned them.
- **Paragraphs are as long as they need to be.** Do not artificially shorten them.
- **Pick one term and reuse it.** Do not cycle synonyms.
- **Make direct claims.** No hedging, no qualification, no rhetorical questions.

## Integration

This workflow should be combined with any user-defined writing voice or style rules found in customizations. The anti-slop rules are the floor; user style rules add domain-specific preferences on top.
