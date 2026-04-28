# QuickTest Workflow

Rapid hypothesis validation for time-sensitive decisions. Single hypothesis, fast execution.

## Process

### 1. State the Hypothesis

```markdown
**Hypothesis**: [Clear, testable statement]
**Prediction**: If true, then [measurable outcome]
**Test**: [How we'll check]
```

### 2. Quick Experiment

Execute minimal viable test:

- Identify fastest way to validate/invalidate
- Run single experiment
- Observe result

### 3. Result

```markdown
**Result**: [What happened]
**Verdict**: Supported / Refuted / Inconclusive
**Confidence**: High / Medium / Low
**Next**: [Action or follow-up]
```

## Output Format

```markdown
## Quick Hypothesis Test

**H**: [Hypothesis]
**P**: [Prediction]
**T**: [Test performed]
**R**: [Result observed]
**V**: ✓ Supported / ✗ Refuted / ? Inconclusive
**→**: [Next action]
```

## Example

```markdown
## Quick Hypothesis Test

**H**: The API timeout is causing the 500 errors
**P**: If true, increasing timeout will reduce 500s
**T**: Set timeout from 5s to 30s, monitor for 10 minutes
**R**: 500 errors dropped from 50/min to 2/min
**V**: ✓ Supported
**→**: Investigate why upstream is slow, set timeout to 15s as interim fix
```

## When to Use

- Need fast answer, not comprehensive analysis
- Single variable to test
- Time-constrained decisions
- Sanity checks before deeper investigation
