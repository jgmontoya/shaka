# Verifying Shaka changes

Choose checks for the behavior you changed. Use the existing fixtures and commands,
then report what they establish and what remains unverified.

## Repository checks

Run `just check` before handing off a change. It delegates to `bun run check`:
TypeScript, Biome on the whole repository (`src/`, `scripts/`, `test/`, and
`defaults/`), the provider dependency gate, and the Bun test suite. Tests relax
two Biome rules: non-null assertions are allowed, and so is `delete`, which test
teardown uses to restore unset environment variables and properties. Other
architecture tripwires remain advisory; their warnings do not fail this gate.

`just test-hermetic` runs the same Bun unit and integration suite used
by the repository check. Generated-provider tests are included in that suite;
their separate recipe is useful for focused work. Avoid repeating overlapping
suites unless a change, failure, or unresolved concern calls for it.

## Choose the relevant proof

| Changed surface | Focused command | What it proves and where it stops |
| --- | --- | --- |
| Session-start context and `doctor --context` | `bun test test/unit/hooks/session-start.test.ts test/unit/memory/storage.test.ts test/unit/commands/context-measurement.test.ts` | Runs the deployed hook against isolated fixtures and checks the emitted context, including related-session selection. Renderer tests verify exact budget boundaries, counted titles/metadata/bodies, excluded outer wrappers, and the first oversized summary. Diagnostic measurements are tested separately. |
| Provider dependency boundaries | `bun test test/unit/architecture-check.test.ts`; `bun run architecture:check` | Checks module declarations, type imports, and literal `import()` targets against shared-code and cross-provider boundaries. Generic provider helpers, registry wiring, and same-provider internals remain valid. It does not prove runtime dispatch or classify computed import targets. |
| Provider installation, generated commands, and tool bridges | `just test-generated-artifacts` | Checks generated artifacts, schemas, and adapter contracts. Add affected provider and `test/unit/commands/reload.test.ts` cases when changing reload behavior. Generated loads do not establish acceptance by a live provider. |
| Memory search through the domain API, CLI, and MCP | `bun test test/integration/memory/retrieval-corpus.test.ts` | Checks retrieval, scope, evidence paths, and read-only access against the same fixtures. Fixture cost ceilings are regression checks, not a production context-budget policy. |
| Security decisions and event logs | `bun test test/unit/security test/unit/hooks/security-validator.test.ts` | Checks validation rules and the deployed security hook. It does not establish that every live provider dispatches that hook. |
| `shaka run` and autoresearch control flow | `bun test test/unit/services/workflow-runner.test.ts test/unit/services/autoresearch.test.ts` | Checks workflow and optimization decisions with controlled subprocess and provider boundaries. It does not prove authenticated execution by an installed provider. |

The README and CLI help remain the full command inventory. Update the affected
row here when a behavior contract or verification command changes.

## When to use provider E2E tests

For changes to provider dispatch or installation behavior, also run the affected
Docker recipe: `just e2e-claude`, `just e2e-opencode`, `just e2e-codex`, or
`just e2e-pi`. These build the provider environment and run its E2E script. They
require Docker and any credentials needed by the live sections. Inspect the
Docker Compose configuration and E2E scripts for credential mounts and
environment forwarding before running them, and keep secrets out of evidence.

`just e2e-pi` checks installation, offline extension loading, and deterministic
behavior. It does not assert authenticated live sessions or live Pi dispatch;
report those claims as UNVERIFIED unless a separate live check establishes them.

Read the output for skips and authentication warnings. A successful script exit
does not prove a live section that skipped. Report each applicable claim as
PASS, FAIL, or UNVERIFIED, and name the missing prerequisite for unverified claims.
Documentation changes and synthetic session-context fixtures do not require a
live model call.

## Report what was verified

In review and verification reports, state:

- the head commit and comparison base, and any uncommitted paths included;
- each check's command and result, attributed to the checkout where it ran;
- skipped checks and missing prerequisites, as UNVERIFIED.

A test run on one checkout does not verify a diff reviewed elsewhere. After
further edits, re-run the checks whose inputs changed before reusing a result.

## Maintain verification without weakening the promise

Distinguish documentation drift, a harness gap, and a product regression. Correct
documentation that describes the wrong interface. Extend a harness that cannot
exercise a supported path. Report broken product behavior and fix it with a
regression test; do not weaken the documented promise to obtain a pass.

Re-run an affected path after changing its harness or command. Clean up only the
processes and temporary state the verification started. Preserve named, sanitized
proof artifacts through cleanup.
