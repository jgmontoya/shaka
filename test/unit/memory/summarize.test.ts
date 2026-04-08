import { describe, expect, test } from "bun:test";
import {
  type SessionMetadata,
  type SessionSummary,
  buildSummarizationPrompt,
  parseSummaryOutput,
  parseExtractedKnowledge,
  type KnowledgeFragment,
} from "../../../src/memory/summarize";
import type { NormalizedMessage } from "../../../src/memory/transcript";

const sampleMetadata: SessionMetadata = {
  date: "2026-02-09",
  cwd: "/projects/myapp",
  provider: "claude",
  sessionId: "ses-abc123",
};

const sampleMessages: NormalizedMessage[] = [
  { role: "user", content: "Fix the auth bug in login.ts" },
  {
    role: "assistant",
    content: "I found the issue. The token validation was skipping expiry checks.\n[Tool: Edit]",
  },
  { role: "user", content: "Run the tests" },
  { role: "assistant", content: "All 42 tests pass.\n[Tool: Bash]" },
];

/** A realistic LLM summary output with proper frontmatter */
const validSummaryOutput = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [auth, bug-fix, testing]
provider: claude
session_id: ses-abc123
---

# Fix auth token expiry validation

## Summary
Fixed a bug in login.ts where token validation was skipping expiry checks. All 42 tests pass after the fix.

## Decisions
- Used strict expiry comparison instead of lenient check

## Files Modified
- src/auth/login.ts

## Problems Solved
- Token expiry validation was being skipped, allowing expired tokens

## Open Questions
- Should we add refresh token support?
`;

describe("Summarize", () => {
  describe("buildSummarizationPrompt", () => {
    test("includes transcript messages in output", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("Fix the auth bug in login.ts");
      expect(prompt).toContain("token validation was skipping expiry checks");
      expect(prompt).toContain("[Tool: Bash]");
    });

    test("includes metadata in template", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("2026-02-09");
      expect(prompt).toContain("/projects/myapp");
      expect(prompt).toContain("claude");
      expect(prompt).toContain("ses-abc123");
    });

    test("includes message roles", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("user:");
      expect(prompt).toContain("assistant:");
    });

    test("asks for YAML frontmatter in output format", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("---");
      expect(prompt).toContain("tags:");
    });

    test("handles empty messages array", () => {
      const prompt = buildSummarizationPrompt([], sampleMetadata);
      expect(prompt).toContain("2026-02-09");
      // Should still produce a valid prompt, just with empty transcript
    });

    test("works with opencode provider", () => {
      const metadata: SessionMetadata = { ...sampleMetadata, provider: "opencode" };
      const prompt = buildSummarizationPrompt(sampleMessages, metadata);
      expect(prompt).toContain("opencode");
    });

    test("includes learnings extraction section", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("## Learnings");
      expect(prompt).toContain("Do NOT extract");
      expect(prompt).toContain("DO extract");
    });

    test("includes existing learning titles when provided", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata, [
        "Use Bun.file()",
        "No emojis",
      ]);
      expect(prompt).toContain("- Use Bun.file()");
      expect(prompt).toContain("- No emojis");
    });

    test("shows placeholder when no existing learnings", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata, []);
      expect(prompt).toContain("No existing learnings yet.");
    });

    test("includes knowledge extraction section", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("## Knowledge");
      expect(prompt).toContain("SUBSTANTIVE");
      expect(prompt).toContain("DURABLE");
      expect(prompt).toContain("NON-OBVIOUS");
      expect(prompt).toContain("Topics:");
    });

    test("includes existing topic titles when provided", () => {
      const prompt = buildSummarizationPrompt(
        sampleMessages,
        sampleMetadata,
        [],
        ["auth-system", "deployment-pipeline"],
      );
      expect(prompt).toContain("auth-system");
      expect(prompt).toContain("deployment-pipeline");
    });

    test("knowledge section distinguishes behavioral nudges from domain knowledge", () => {
      const prompt = buildSummarizationPrompt(sampleMessages, sampleMetadata);
      expect(prompt).toContain("behavioral nudges");
      expect(prompt).toContain("Learnings");
    });
  });

  describe("parseSummaryOutput", () => {
    test("parses valid summary with all sections", () => {
      const result = parseSummaryOutput(validSummaryOutput);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-09");
      expect(result?.metadata.cwd).toBe("/projects/myapp");
      expect(result?.metadata.provider).toBe("claude");
      expect(result?.metadata.sessionId).toBe("ses-abc123");
      expect(result?.tags).toEqual(["auth", "bug-fix", "testing"]);
      expect(result?.title).toBe("Fix auth token expiry validation");
    });

    test("body contains the markdown content after the title", () => {
      const result = parseSummaryOutput(validSummaryOutput);
      expect(result).not.toBeNull();
      expect(result?.body).toContain("## Summary");
      expect(result?.body).toContain("## Decisions");
      expect(result?.body).toContain("## Files Modified");
      expect(result?.body).toContain("## Problems Solved");
      expect(result?.body).toContain("## Open Questions");
    });

    test("body does not include the title heading", () => {
      const result = parseSummaryOutput(validSummaryOutput);
      expect(result).not.toBeNull();
      expect(result?.body).not.toContain("# Fix auth token expiry validation");
    });

    test("returns null for empty input", () => {
      expect(parseSummaryOutput("")).toBeNull();
    });

    test("returns null for input without frontmatter", () => {
      expect(parseSummaryOutput("Just some text without frontmatter")).toBeNull();
    });

    test("returns null for input with invalid frontmatter", () => {
      const bad = `---
not: [valid: yaml: {{
---
# Title
Body text`;
      expect(parseSummaryOutput(bad)).toBeNull();
    });

    test("returns null when required frontmatter fields are missing", () => {
      const missingFields = `---
tags: [test]
---
# Title
Body`;
      expect(parseSummaryOutput(missingFields)).toBeNull();
    });

    test("tolerates missing optional body sections", () => {
      const minimal = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

# Minimal session

## Summary
Did some work.
`;
      const result = parseSummaryOutput(minimal);
      expect(result).not.toBeNull();
      expect(result?.title).toBe("Minimal session");
      expect(result?.body).toContain("## Summary");
    });

    test("handles tags as empty array", () => {
      const noTags = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: []
provider: opencode
session_id: ses-xyz789
---

# Session with no tags

## Summary
Quick session.
`;
      const result = parseSummaryOutput(noTags);
      expect(result).not.toBeNull();
      expect(result?.tags).toEqual([]);
    });

    test("handles frontmatter with extra whitespace", () => {
      const extraSpace = `---
date:   "2026-02-09"
cwd:    /projects/myapp
tags:   [test, spaces]
provider:  claude
session_id:  ses-abc123
---

# Spaced out

## Summary
Works with extra spaces.
`;
      const result = parseSummaryOutput(extraSpace);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-09");
      expect(result?.tags).toEqual(["test", "spaces"]);
    });

    test("handles frontmatter where date is not quoted", () => {
      const unquotedDate = `---
date: 2026-02-09
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

# Unquoted date

## Summary
Date without quotes.
`;
      const result = parseSummaryOutput(unquotedDate);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-09");
    });

    test("handles output wrapped in markdown code fences", () => {
      const fenced = `\`\`\`markdown
---
date: 2026-02-09
cwd: /projects/myapp
tags: [auth, bug-fix]
provider: claude
session_id: ses-abc123
---

# Fix auth token expiry

## Summary
Fixed the token expiry bug.

## Decisions
- Used strict comparison
\`\`\``;
      const result = parseSummaryOutput(fenced);
      expect(result).not.toBeNull();
      expect(result?.title).toBe("Fix auth token expiry");
      expect(result?.tags).toEqual(["auth", "bug-fix"]);
    });

    test("handles output wrapped in yaml code fences", () => {
      const fenced = `\`\`\`yaml
---
date: 2026-02-09
cwd: /projects/myapp
tags: [memory]
provider: claude
session_id: ses-yaml-test
---

# Yaml fenced output

## Summary
Works with yaml language tag.
\`\`\``;
      const result = parseSummaryOutput(fenced);
      expect(result).not.toBeNull();
      expect(result?.title).toBe("Yaml fenced output");
    });

    test("handles output wrapped in plain code fences", () => {
      const fenced = `\`\`\`
---
date: 2026-02-09
cwd: /projects/myapp
tags: [test]
provider: opencode
session_id: ses-xyz789
---

# Plain fenced output

## Summary
Works without language tag.
\`\`\``;
      const result = parseSummaryOutput(fenced);
      expect(result).not.toBeNull();
      expect(result?.title).toBe("Plain fenced output");
    });

    test("strips ## Learnings section from body", () => {
      const withLearnings = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

# Session with learnings

## Summary
Did some work.

## Decisions
- Chose option A.

## Learnings

### (correction) Use Bun.file()

This project uses Bun runtime.

### (preference) No emojis

User prefers no emojis.
`;
      const result = parseSummaryOutput(withLearnings);
      expect(result).not.toBeNull();
      expect(result?.body).toContain("## Summary");
      expect(result?.body).toContain("## Decisions");
      expect(result?.body).not.toContain("## Learnings");
      expect(result?.body).not.toContain("Use Bun.file()");
      expect(result?.body).not.toContain("No emojis");
    });

    test("strips ## Learnings but preserves ## Knowledge after it", () => {
      const withBoth = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

# Session with both sections

## Summary
Did some work.

## Learnings

### (correction) Use Bun.file()

This project uses Bun runtime.

## Knowledge

### Auth System

The auth layer uses JWT with rotating refresh tokens.
Topics: auth, architecture
`;
      const result = parseSummaryOutput(withBoth);
      expect(result).not.toBeNull();
      expect(result?.body).toContain("## Summary");
      expect(result?.body).not.toContain("## Learnings");
      expect(result?.body).not.toContain("Use Bun.file()");
      // Knowledge section stays in the body — compilation reads it from session files
      expect(result?.body).toContain("## Knowledge");
      expect(result?.body).toContain("Auth System");
    });

    test("strips Learnings but preserves Knowledge regardless of order", () => {
      const knowledgeFirst = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

# Session with reversed order

## Summary
Did some work.

## Decisions
- Chose option A.

## Knowledge

### Deploy Pipeline

Docker to ECS with blue-green.
Topics: deployment

## Learnings

### (pattern) Use atomic writes

Always use tmp + rename.
`;
      const result = parseSummaryOutput(knowledgeFirst);
      expect(result).not.toBeNull();
      expect(result?.body).toContain("## Summary");
      expect(result?.body).toContain("## Decisions");
      expect(result?.body).toContain("## Knowledge");
      expect(result?.body).toContain("Deploy Pipeline");
      expect(result?.body).not.toContain("## Learnings");
      expect(result?.body).not.toContain("Use atomic writes");
    });

    test("handles LLM using ```yaml code fence instead of --- frontmatter", () => {
      const codeFenceFrontmatter = `\`\`\`yaml
date: 2026-02-09
cwd: /projects/myapp
tags: [drafts, schema]
provider: opencode
session_id: ses-abc123
\`\`\`

# Drafts Feature Implementation Plan

## Summary
Created a drafts specification.

## Decisions
- Used autoincrement id column
`;
      const result = parseSummaryOutput(codeFenceFrontmatter);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-09");
      expect(result?.metadata.cwd).toBe("/projects/myapp");
      expect(result?.metadata.provider).toBe("opencode");
      expect(result?.tags).toEqual(["drafts", "schema"]);
      expect(result?.title).toBe("Drafts Feature Implementation Plan");
      expect(result?.body).toContain("## Summary");
    });

    test("handles double-wrapped output (outer markdown + inner yaml fence)", () => {
      const doubleWrapped = `\`\`\`markdown
\`\`\`yaml
date: 2026-02-09
cwd: /projects/myapp
tags: [auth]
provider: claude
session_id: ses-abc123
\`\`\`

# Fix auth flow

## Summary
Fixed the auth flow.
\`\`\``;
      const result = parseSummaryOutput(doubleWrapped);
      expect(result).not.toBeNull();
      expect(result?.title).toBe("Fix auth flow");
      expect(result?.metadata.provider).toBe("claude");
    });

    test("handles ```yaml with single --- delimiter (no opening ---)", () => {
      const singleDash = `\`\`\`yaml
date: 2026-02-12
cwd: /projects/myapp
tags: [review, architecture]
provider: opencode
session_id: ses-xyz789
---

# Pattern Alignment Review

## Summary
Conducted pattern analysis.

## Decisions
- Used autoincrement id
`;
      const result = parseSummaryOutput(singleDash);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-12");
      expect(result?.title).toBe("Pattern Alignment Review");
      expect(result?.body).toContain("## Summary");
    });

    test("handles SHAKA-wrapped output with embedded frontmatter", () => {
      const shakaWrapped = `🤖 SHAKA ═══════════════════════════════════
   Task: Extract session info

━━━ 👁️ OBSERVE ━━━ 1/7
Some observation text.

━━━ 🔨 BUILD ━━━ 4/7

---
date: 2026-02-10
cwd: /projects/myapp
tags: [inference, agent]
provider: opencode
session_id: ses-build123
---

# Fix Spurious File Creation

## Summary
Fixed spurious file creation issue.

## Decisions
- Used custom agent approach

━━━ ✅ VERIFY ━━━ 6/7
All good.`;
      const result = parseSummaryOutput(shakaWrapped);
      expect(result).not.toBeNull();
      expect(result?.metadata.date).toBe("2026-02-10");
      expect(result?.title).toBe("Fix Spurious File Creation");
      expect(result?.body).toContain("## Summary");
      expect(result?.body).toContain("## Decisions");
      // SHAKA wrapper sections after the summary should be stripped or included
      // The body captures everything after the title within the frontmatter block
    });

    test("normalizes non-standard provider values", () => {
      const nonStandardProvider = `---
date: 2026-02-10
cwd: /projects/myapp
tags: [test]
provider: openrouter/anthropic/claude-haiku-4.5
session_id: ses-abc123
---

# Session with custom provider

## Summary
Works with non-standard provider string.
`;
      const result = parseSummaryOutput(nonStandardProvider);
      expect(result).not.toBeNull();
      expect(result?.metadata.provider).toBe("opencode");
      expect(result?.title).toBe("Session with custom provider");
    });

    test("returns null when title heading is missing", () => {
      const noTitle = `---
date: "2026-02-09"
cwd: /projects/myapp
tags: [test]
provider: claude
session_id: ses-abc123
---

Just body text without a heading.
`;
      expect(parseSummaryOutput(noTitle)).toBeNull();
    });
  });

  describe("parseExtractedKnowledge", () => {
    const metadata = { date: "2026-04-15", cwd: "/projects/myapp", sessionHash: "abc12345" };

    test("extracts fragments from a well-formed Knowledge section", () => {
      const raw = `## Summary
Some summary text.

## Knowledge

### Auth Middleware Architecture

The auth layer uses JWT with rotating refresh tokens. Session state is stateless
on the server side — all state lives in the token.
Topics: auth, architecture, scaling

### Why FTS5 Over Vector Search

FTS5 was chosen for memory search because it's deterministic.
Topics: search, architecture-decisions
`;
      const fragments = parseExtractedKnowledge(raw, metadata);
      expect(fragments).toHaveLength(2);
      expect(fragments[0]?.title).toBe("Auth Middleware Architecture");
      expect(fragments[0]?.body).toContain("JWT with rotating refresh tokens");
      expect(fragments[0]?.topics).toEqual(["auth", "architecture", "scaling"]);
      expect(fragments[0]?.sourceSession).toBe("abc12345");
      expect(fragments[1]?.title).toBe("Why FTS5 Over Vector Search");
      expect(fragments[1]?.topics).toEqual(["search", "architecture-decisions"]);
    });

    test("returns empty array when no Knowledge section exists", () => {
      const raw = `## Summary\nSome summary.\n\n## Learnings\n\n### (fact) Something\n\nA fact.`;
      expect(parseExtractedKnowledge(raw, metadata)).toEqual([]);
    });

    test("returns empty array when Knowledge section is empty", () => {
      const raw = `## Summary\nSome summary.\n\n## Knowledge\n`;
      expect(parseExtractedKnowledge(raw, metadata)).toEqual([]);
    });

    test("handles fragment without Topics line", () => {
      const raw = `## Knowledge

### Orphan Fragment

This fragment has no topics line.
`;
      const fragments = parseExtractedKnowledge(raw, metadata);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.title).toBe("Orphan Fragment");
      expect(fragments[0]?.topics).toEqual([]);
      expect(fragments[0]?.body).toContain("no topics line");
    });

    test("stops at the next ## heading after Knowledge", () => {
      const raw = `## Knowledge

### Something Useful

Useful content.
Topics: useful

## Learnings

### (correction) Not a knowledge fragment

This should not be parsed as knowledge.
`;
      const fragments = parseExtractedKnowledge(raw, metadata);
      expect(fragments).toHaveLength(1);
      expect(fragments[0]?.title).toBe("Something Useful");
    });

    test("normalizes topic tags to lowercase and trimmed", () => {
      const raw = `## Knowledge

### Mixed Case Tags

Content here.
Topics: Auth, ARCHITECTURE, Scaling
`;
      const fragments = parseExtractedKnowledge(raw, metadata);
      expect(fragments[0]?.topics).toEqual(["auth", "architecture", "scaling"]);
    });
  });
});
