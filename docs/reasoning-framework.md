# Base Reasoning Framework

Shaka uses a structured reasoning framework inspired by [PAI's Algorithm](https://github.com/danielmiessler/TheAlgorithm). The default startup hook includes it in main-session context. The separate prompt-submit hook reminds the agent which response depth to use.

## The 7 Phases

```text
OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN
```

| Phase   | Purpose                                                            |
| ------- | ------------------------------------------------------------------ |
| OBSERVE | Identify the requested outcome and its boundaries                   |
| THINK   | Select capabilities, evaluate approaches                           |
| PLAN    | Finalize the approach                                              |
| BUILD   | Create artifacts                                                   |
| EXECUTE | Run the work                                                       |
| VERIFY  | Check every criterion with evidence                                |
| LEARN   | Capture what to improve next time                                  |

## Ideal State Criteria (ISC)

Before acting, the AI defines what success looks like as testable criteria:

- **Concise** (<15 words)
- **Binary yes/no** (testable in <2 seconds)
- **State-based** (describes the outcome)
- **Granular** (one concern per criterion)
- **Anti-criteria** (at least one outcome to avoid)

**Example:**

```text
Criterion: "All authentication tests pass after fix applied"
Anti-criterion: "No credentials exposed in git commit history"
```

## Verification

In FULL and ITERATION, the agent looks for the project's existing checks and
reports each material claim as PASS or FAIL with the observed result, or
UNVERIFIED with the missing prerequisite. A failed assertion is FAIL. Checks
that can run independently still go ahead. For runtime claims, the agent
checks the result and side effects through the public interface.

## Response Depth

Not every interaction needs the full 7-phase treatment. The framework supports three depth levels:

| Depth     | When                                      | Format                     |
| --------- | ----------------------------------------- | -------------------------- |
| FULL      | Problem-solving, implementation, analysis | All 7 phases with ISC      |
| ITERATION | Continuing/adjusting existing work        | Condensed: Change + Verify |
| MINIMAL   | Pure social: greetings, acknowledgments   | Header + Summary           |

Depth is determined automatically based on the request.

## Configuration

`reasoning.enabled` remains in `config.json` for compatibility. The default
startup and prompt-submit hooks ignore this setting.

## Customization

To customize the framework:

1. Copy `system/base-reasoning-framework.md` to `customizations/base-reasoning-framework.md`
2. Edit your copy
3. Keep any shipped sections you want in your copy. The default startup hook
   uses the entire custom file in place of the shipped file.

Upgrades replace the shipped version and leave your custom file intact.
If you use a customized framework or startup hook, adopt the new guidance in
your own copy.

Run `shaka doctor --context` to see which framework file the built-in startup
loader selects and whether it is empty or missing.
