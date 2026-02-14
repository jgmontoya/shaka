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
 * Handles multiple LLM output variations:
 * - Standard: ---\nYAML\n---\nbody
 * - Code-fenced: ```yaml\nYAML\n```\nbody (single or double-wrapped)
 * - Single delimiter: ```yaml\nYAML\n---\nbody (missing opening ---)
 * - Embedded: SHAKA wrapper with ---\nYAML\n---\nbody inside
 *
 * Returns null if the output is unparseable or missing required fields.
 */
export function parseSummaryOutput(raw: string): SessionSummary | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip up to 2 layers of code fences (LLMs may double-wrap: ```markdown + ```yaml)
  let stripped = trimmed;
  for (let i = 0; i < 2; i++) {
    stripped = stripped.replace(/^```\w*\n/, "").replace(/\n```$/, "");
  }

  const found = findFrontmatter(stripped);
  if (!found) return null;

  // Validate required metadata fields
  const metadata = extractMetadata(found.frontmatter);
  if (!metadata) return null;

  // Extract tags
  const tags = extractTags(found.frontmatter);

  // Extract title from first # heading
  const title = extractTitle(found.body);
  if (!title) return null;

  // Body is everything after the title line
  const body = extractBody(found.body, title);

  return { metadata, tags, title, body };
}

interface FrontmatterFound {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Find and parse YAML frontmatter from LLM output.
 * Tries strategies in order: at-start delimiters, then embedded search.
 */
function findFrontmatter(content: string): FrontmatterFound | null {
  // At-start strategies: try fast regex matches first
  const atStart =
    // Standard: ---\nYAML\n---\nbody
    content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/) ??
    // Code-fence-as-delimiter: raw YAML ending with ``` (after outer fence strip)
    content.match(/^([a-z_]\w*:[\s\S]*?)\n```\n*([\s\S]*)$/) ??
    // Single --- delimiter: raw YAML ending with --- (opening --- replaced by ```yaml)
    content.match(/^([a-z_]\w*:[\s\S]*?)\n---\n*([\s\S]*)$/);

  if (atStart?.[1]) {
    const parsed = tryParseYaml(atStart[1]);
    if (parsed) return { frontmatter: parsed, body: atStart[2] ?? "" };
  }

  // Embedded: search all ---...--- pairs for valid YAML frontmatter.
  // Needed when the LLM wraps output in SHAKA algorithm format with the
  // frontmatter buried inside BUILD/EXECUTE/VERIFY sections.
  return findEmbeddedFrontmatter(content);
}

/**
 * Search for valid YAML frontmatter between any ---...--- pair in the content.
 * Validates each candidate by checking for required keys (date, session_id).
 */
function findEmbeddedFrontmatter(content: string): FrontmatterFound | null {
  const delimiter = "\n---\n";
  const positions: number[] = [];
  let idx = content.indexOf(delimiter);
  while (idx !== -1) {
    positions.push(idx);
    idx = content.indexOf(delimiter, idx + delimiter.length);
  }

  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i] ?? 0;
    const end = positions[i + 1] ?? 0;
    const yamlStr = content.slice(start + delimiter.length, end);
    if (!yamlStr.includes("date:") || !yamlStr.includes("session_id:")) continue;

    const parsed = tryParseYaml(yamlStr);
    if (!parsed || !("date" in parsed) || !("session_id" in parsed)) continue;

    const body = content.slice(end + delimiter.length);
    return { frontmatter: parsed, body };
  }

  return null;
}

function tryParseYaml(str: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(str);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Not valid YAML
  }
  return null;
}

function extractMetadata(frontmatter: Record<string, unknown>): SessionMetadata | null {
  const date = String(frontmatter.date ?? "");
  const cwd = String(frontmatter.cwd ?? "");
  const provider = String(frontmatter.provider ?? "");
  const sessionId = String(frontmatter.session_id ?? "");

  if (!date || !cwd || !provider || !sessionId) return null;

  // Normalize provider to known values. The hook overrides metadata with
  // original values anyway, so we accept any non-empty provider string here
  // to avoid rejecting valid summaries when the LLM echoes non-standard values
  // (e.g. "openrouter/anthropic/claude-haiku-4.5").
  const normalizedProvider: "claude" | "opencode" = provider === "claude" ? "claude" : "opencode";

  return { date, cwd, provider: normalizedProvider, sessionId };
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
