/** Parse and validate the Markdown contract for compiled knowledge topics. */

import { parseFrontmatter } from "../domain/frontmatter";

export type TopicConfidence = "high" | "medium" | "low";

export interface CompiledTopicDecision {
  readonly text: string;
  readonly sourceSession: string;
}

export interface CompiledTopicPage {
  readonly title: string;
  readonly created: string;
  readonly updated: string;
  readonly confidence: TopicConfidence;
  readonly sources: string[];
  readonly summary: string;
  readonly body: string;
  readonly decisions: CompiledTopicDecision[];
}

export type TopicPageValidationIssueCode =
  | "empty-output"
  | "invalid-frontmatter"
  | "invalid-title"
  | "invalid-created"
  | "invalid-updated"
  | "invalid-confidence"
  | "invalid-sources"
  | "invalid-summary"
  | "source-set-mismatch"
  | "missing-decision-citation"
  | "unlisted-decision-source";

export interface TopicPageValidationIssue {
  readonly code: TopicPageValidationIssueCode;
  readonly message: string;
}

export type TopicPageValidationResult =
  | { readonly ok: true; readonly page: CompiledTopicPage }
  | { readonly ok: false; readonly issues: TopicPageValidationIssue[] };

function invalidTopicPage(
  code: TopicPageValidationIssueCode,
  message: string,
): TopicPageValidationResult {
  return { ok: false, issues: [{ code, message }] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConfidence(value: unknown): value is TopicConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function isSourceList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function extractDecisionBullets(body: string): string[] {
  const section = body.split(/^## Key Decisions\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return section.split("\n").flatMap((line) => line.match(/^\s*-\s+(.+)$/)?.[1] ?? []);
}

function extractDecisions(body: string): CompiledTopicDecision[] {
  return extractDecisionBullets(body).flatMap((bullet): CompiledTopicDecision[] => {
    const text = bullet.replace(/\s+\(source:\s*[^)]+\)\s*$/, "");
    return [...bullet.matchAll(/\bsource:\s*([^),]+)/g)].map((match) => ({
      text,
      sourceSession: match[1]?.trim() ?? "",
    }));
  });
}

export function validateCompiledTopicPage(raw: string): TopicPageValidationResult {
  if (!raw.trim()) {
    return invalidTopicPage("empty-output", "Empty compiled topic output.");
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    return invalidTopicPage(
      "invalid-frontmatter",
      "Invalid compiled topic output: frontmatter is missing or malformed.",
    );
  }

  const { frontmatter } = parsed;
  if (!isNonEmptyString(frontmatter.title)) {
    return invalidTopicPage("invalid-title", "Invalid compiled topic title.");
  }
  if (!isNonEmptyString(frontmatter.created)) {
    return invalidTopicPage("invalid-created", "Invalid compiled topic created date.");
  }
  if (!isNonEmptyString(frontmatter.updated)) {
    return invalidTopicPage("invalid-updated", "Invalid compiled topic updated date.");
  }
  if (!isConfidence(frontmatter.confidence)) {
    return invalidTopicPage("invalid-confidence", "Invalid compiled topic confidence.");
  }
  if (!isSourceList(frontmatter.sources)) {
    return invalidTopicPage("invalid-sources", "Invalid compiled topic sources.");
  }
  if (!isNonEmptyString(frontmatter.summary)) {
    return invalidTopicPage("invalid-summary", "Invalid compiled topic summary.");
  }

  const page: CompiledTopicPage = {
    title: frontmatter.title,
    created: frontmatter.created,
    updated: frontmatter.updated,
    confidence: frontmatter.confidence,
    sources: frontmatter.sources,
    summary: frontmatter.summary,
    body: parsed.body,
    decisions: extractDecisions(parsed.body),
  };
  return { ok: true, page };
}

export function parseCompiledTopicPage(raw: string): CompiledTopicPage | null {
  const result = validateCompiledTopicPage(raw);
  return result.ok ? result.page : null;
}

export function hasExactTopicSources(
  page: CompiledTopicPage,
  expectedSources: Iterable<string>,
): boolean {
  const actual = new Set(page.sources);
  const expected = new Set(expectedSources);
  return actual.size === expected.size && [...expected].every((source) => actual.has(source));
}

export function hasListedDecisionSources(page: CompiledTopicPage): boolean {
  const sources = new Set(page.sources);
  return page.decisions.every((decision) => sources.has(decision.sourceSession));
}

export function hasCompleteDecisionCitations(page: CompiledTopicPage): boolean {
  const bullets = extractDecisionBullets(page.body);
  return bullets.length > 0 && bullets.every((bullet) => /\bsource:\s*[^),]+/.test(bullet));
}

export function validateGeneratedTopicPage(
  raw: string,
  expectedSources: Iterable<string>,
): TopicPageValidationResult {
  const parsed = validateCompiledTopicPage(raw);
  if (!parsed.ok) return parsed;

  const issues: TopicPageValidationIssue[] = [];
  if (!hasExactTopicSources(parsed.page, expectedSources)) {
    issues.push({
      code: "source-set-mismatch",
      message: "Invalid compiled topic provenance: sources do not match the input fragments.",
    });
  }
  if (!hasCompleteDecisionCitations(parsed.page)) {
    issues.push({
      code: "missing-decision-citation",
      message: "Invalid compiled topic decision citation: every decision requires a source.",
    });
  }
  if (!hasListedDecisionSources(parsed.page)) {
    issues.push({
      code: "unlisted-decision-source",
      message: "Invalid compiled topic decision provenance: every cited source must be listed.",
    });
  }
  return issues.length > 0 ? { ok: false, issues } : parsed;
}
