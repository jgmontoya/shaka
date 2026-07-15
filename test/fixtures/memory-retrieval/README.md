# Memory retrieval corpus

This privacy-safe corpus is the deterministic contract for Shaka's current memory search and
session-start knowledge context. Normal `bun test` runs it through the domain search API, CLI,
and MCP tool.

The corpus deliberately records one known limitation: a zero-overlap paraphrase does not match
substring search. That case is an honest baseline, not a desired semantic-retrieval behavior.
Changing the search backend must improve that baseline without weakening exact lookup, project
scope, archive visibility, evidence paths, maximum-result limits, or read-only behavior.

Context cases report discovery and character cost separately. Their ceilings are regression
guards for these fixtures; they are not production context budgets or a selection policy.
