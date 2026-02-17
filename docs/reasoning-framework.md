# Base Reasoning Framework

Shaka uses a structured reasoning framework inspired by [PAI's Algorithm](https://github.com/danielmiessler/TheAlgorithm). It's loaded at session start via the `SessionStart` hook and injected into the AI's context.

## The 7 Phases

```text
OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN
```

| Phase   | Purpose                                                            |
| ------- | ------------------------------------------------------------------ |
| OBSERVE | Reverse-engineer the request — what's asked, implied, and unwanted |
| THINK   | Select capabilities, evaluate approaches                           |
| PLAN    | Finalize the approach                                              |
| BUILD   | Create artifacts                                                   |
| EXECUTE | Run the work                                                       |
| VERIFY  | Check every criterion with evidence                                |
| LEARN   | Capture what to improve next time                                  |

## Ideal State Criteria (ISC)

Before acting, the AI defines what success looks like as testable criteria:

- **Concise** (<15 words) — forces precision without word-counting
- **Binary yes/no** — testable in <2 seconds
- **State-based** — "X is true" not "do X"
- **Granular** — one concern per criterion
- **Anti-criteria** (≥1 required) — what must NOT happen

**Example:**

```text
Criterion: "All authentication tests pass after fix applied"
Anti-criterion: "No credentials exposed in git commit history"
```

The AI verifies all criteria before claiming "done." This prevents the common failure of solving one problem while creating another.

## Response Depth

Not every interaction needs the full 7-phase treatment. The framework supports three depth levels:

| Depth     | When                                      | Format                     |
| --------- | ----------------------------------------- | -------------------------- |
| FULL      | Problem-solving, implementation, analysis | All 7 phases with ISC      |
| ITERATION | Continuing/adjusting existing work        | Condensed: Change + Verify |
| MINIMAL   | Pure social: greetings, acknowledgments   | Header + Summary           |

Depth is determined automatically based on the request.

## Configuration

Enable or disable the reasoning framework in `config.json`:

```json
{ "reasoning": { "enabled": true } }
```

## Customization

To customize the framework:

1. Copy `system/base-reasoning-framework.md` to `customizations/base-reasoning-framework.md`
2. Edit your copy
3. Your version takes priority (Shaka's override system)

The system version is replaced on upgrades. Your customization is never touched.
