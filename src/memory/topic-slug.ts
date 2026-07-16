/** Canonical identity rules for compiled knowledge topic filenames. */

import { dirname, join, resolve } from "node:path";

const TOPIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_TOPIC_SLUG = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const MAX_TOPIC_SLUG_LENGTH = 200;

/** Parse an already-canonical topic slug without changing its identity. */
export function parseTopicSlug(value: string): string | null {
  return value.length <= MAX_TOPIC_SLUG_LENGTH &&
    TOPIC_SLUG_PATTERN.test(value) &&
    !WINDOWS_RESERVED_TOPIC_SLUG.test(value)
    ? value
    : null;
}

/** Normalize benign model variation in a topic tag, then validate it strictly. */
export function topicSlugFromTag(value: string): string | null {
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
  return parseTopicSlug(normalized);
}

/** Return the canonical slug represented by a topic filename. */
export function parseTopicFilename(filename: string): string | null {
  if (!filename.endsWith(".md")) return null;
  return parseTopicSlug(filename.slice(0, -3));
}

/** Build a topic path only after proving it remains one direct child of the project. */
export function topicFilePath(knowledgeDir: string, slug: string): string {
  if (!parseTopicSlug(slug)) throw new Error(`Invalid topic slug: ${JSON.stringify(slug)}.`);
  const target = join(knowledgeDir, `${slug}.md`);
  if (dirname(resolve(target)) !== resolve(knowledgeDir)) {
    throw new Error(`Topic path escapes the knowledge directory: ${JSON.stringify(slug)}.`);
  }
  return target;
}
