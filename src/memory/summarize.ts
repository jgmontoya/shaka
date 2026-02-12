/**
 * Session summarization: prompt building and output parsing.
 *
 * buildSummarizationPrompt — creates the extraction prompt for inference.
 * parseSummaryOutput — parses the LLM's markdown+frontmatter response.
 *
 * Neither function performs I/O. The inference call lives in the hook (Commit 6).
 */

import { parse as parseYaml } from "yaml";
import { buildExtractionPromptSection } from "./learnings";
import type { NormalizedMessage } from "./transcript";

export interface SessionMetadata {
  readonly date: string;
  readonly cwd: string;
  readonly provider: "claude" | "opencode";
  readonly sessionId: string;
}

export interface SessionSummary {
  readonly metadata: SessionMetadata;
  readonly tags: string[];
  readonly title: string;
  readonly body: string;
}

/**
 * Build a prompt that asks the LLM to extract structured information
 * from a coding session transcript, including reusable learnings.
 */
export function buildSummarizationPrompt(
  messages: NormalizedMessage[],
  metadata: SessionMetadata,
  existingLearningTitles: string[] = [],
): string {
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  const learningsSection = buildExtractionPromptSection(existingLearningTitles);

  return `You are analyzing a coding session transcript. Extract structured information.

<transcript>
${transcript}
</transcript>

Extract:
1. A 2-3 sentence summary of what was accomplished
2. Key technical decisions made and their rationale
3. Files created, modified, or deleted
4. Problems encountered and how they were resolved
5. Unresolved questions or next steps
6. 3-5 keyword tags for searchability
${learningsSection}

Format as markdown with YAML frontmatter:

---
date: ${metadata.date}
cwd: ${metadata.cwd}
tags: [tag1, tag2, tag3]
provider: ${metadata.provider}
session_id: ${metadata.sessionId}
---

# {descriptive title}

## Summary
...

## Decisions
- ...

## Files Modified
- ...

## Problems Solved
- ...

## Open Questions
- ...

## Next Steps
- ...

## Learnings

### (category) Title

Body (1-3 sentences).`;
}

/**
 * Parse the LLM's summary output into a structured SessionSummary.
 *
 * Expects markdown with YAML frontmatter delimited by `---`.
 * Returns null if the output is unparseable or missing required fields.
 */
export function parseSummaryOutput(raw: string): SessionSummary | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip code fences if present (LLMs wrap output in ```markdown, ```yaml, etc.)
  const stripped = trimmed.replace(/^```\w*\n/, "").replace(/\n```$/, "");

  // Extract frontmatter between --- delimiters
  const frontmatterMatch = stripped.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const yamlStr = frontmatterMatch[1];
  const markdownBody = frontmatterMatch[2];
  if (!yamlStr || markdownBody === undefined) return null;

  // Parse YAML frontmatter
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlStr);
  } catch {
    return null;
  }

  if (!frontmatter || typeof frontmatter !== "object") return null;

  // Validate required metadata fields
  const metadata = extractMetadata(frontmatter);
  if (!metadata) return null;

  // Extract tags
  const tags = extractTags(frontmatter);

  // Extract title from first # heading
  const title = extractTitle(markdownBody);
  if (!title) return null;

  // Body is everything after the title line
  const body = extractBody(markdownBody, title);

  return { metadata, tags, title, body };
}

function extractMetadata(frontmatter: Record<string, unknown>): SessionMetadata | null {
  const date = String(frontmatter.date ?? "");
  const cwd = String(frontmatter.cwd ?? "");
  const provider = String(frontmatter.provider ?? "");
  const sessionId = String(frontmatter.session_id ?? "");

  if (!date || !cwd || !provider || !sessionId) return null;
  if (provider !== "claude" && provider !== "opencode") return null;

  return { date, cwd, provider, sessionId };
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractBody(markdown: string, title: string): string {
  // Find the title line and take everything after it
  const titleLine = `# ${title}`;
  const titleIndex = markdown.indexOf(titleLine);
  if (titleIndex === -1) return stripLearningsSection(markdown.trim());

  const afterTitle = markdown.slice(titleIndex + titleLine.length);
  return stripLearningsSection(afterTitle.trim());
}

/**
 * Remove the ## Learnings section from the body.
 * Learnings are extracted separately by parseExtractedLearnings()
 * and stored in learnings.md, not in session summary files.
 */
function stripLearningsSection(body: string): string {
  return body.replace(/\n*## Learnings[\s\S]*$/, "").trim();
}
