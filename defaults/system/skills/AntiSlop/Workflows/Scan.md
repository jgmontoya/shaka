# Scan Workflow

Scan existing content for AI slop patterns and report violations.

## Steps

1. **Identify target**: Determine the file(s) or content to scan
2. **Run the scanner**: Execute `Tools/anti-slop-scanner.ts` against the target
3. **Interpret results**: Review the score, violation breakdown, and qualitative assessment
4. **Report**: Present findings with specific line numbers, violations, and suggested fixes

## When to Use

- After drafting prose content
- Before publishing or committing written content
- When reviewing AI-generated text for quality
- As part of a writing workflow's validation step

## Output Format

Present results as:

```
## Anti-Slop Scan: [filename]

**Score:** [N]/100 [PASS/FAIL]
**Word Count:** [N] | **Slop Density:** [N] violations/100 words

### Violations Found

[Grouped by type, with line numbers and suggestions]

### Qualitative Assessment

[If available: directness, rhythm, trust, density scores]
```

## Integration

Other workflows and commands can invoke this workflow to validate prose output before finalizing. The scanner exits with code 1 if the score is below the pass threshold (default: 95), making it suitable for automated pipelines.
