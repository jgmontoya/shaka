import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseTopicSlug, topicFilePath, topicSlugFromTag } from "../../../src/memory/topic-slug";

test("topic tags normalize benign model variation without stripping punctuation", () => {
  expect(topicSlugFromTag("  Ａｕｔｈ   System  ")).toBe("auth-system");
  expect(topicSlugFromTag("`auth-system`")).toBeNull();
  expect(topicSlugFromTag("auth/system")).toBeNull();
  expect(topicSlugFromTag("auth_system")).toBeNull();
  expect(topicSlugFromTag("café")).toBeNull();
});

test("canonical topic slugs exclude every Windows device basename", () => {
  const reserved = [
    "con",
    "prn",
    "aux",
    "nul",
    ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
  ];

  for (const slug of reserved) expect(parseTopicSlug(slug)).toBeNull();
  expect(parseTopicSlug("console")).toBe("console");
});

test("topicFilePath rejects values that are not canonical topic slugs", () => {
  expect(() => topicFilePath("/memory/knowledge/project", "../outside")).toThrow(
    'Invalid topic slug: "../outside".',
  );
  expect(topicFilePath("/memory/knowledge/project", "auth-system")).toBe(
    join("/memory/knowledge/project", "auth-system.md"),
  );
});
