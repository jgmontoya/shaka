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

export function parseCompiledTopicPage(raw: string): CompiledTopicPage | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;

  const { frontmatter } = parsed;
  if (
    !isNonEmptyString(frontmatter.title) ||
    !isNonEmptyString(frontmatter.created) ||
    !isNonEmptyString(frontmatter.updated) ||
    !isConfidence(frontmatter.confidence) ||
    !isSourceList(frontmatter.sources) ||
    !isNonEmptyString(frontmatter.summary)
  ) {
    return null;
  }

  return {
    title: frontmatter.title,
    created: frontmatter.created,
    updated: frontmatter.updated,
    confidence: frontmatter.confidence,
    sources: frontmatter.sources,
    summary: frontmatter.summary,
    body: parsed.body,
    decisions: extractDecisions(parsed.body),
  };
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
