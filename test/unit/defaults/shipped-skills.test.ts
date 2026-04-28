import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const skillsRoot = resolve(import.meta.dir, "..", "..", "..", "defaults", "system", "skills");
const forbiddenProviderPaths = ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode"];

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? collectFiles(path) : path;
    }),
  );
  return files.flat();
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    throw new Error("Missing frontmatter");
  }

  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must parse to an object");
  }

  return parsed as Record<string, unknown>;
}

describe("shipped skills", () => {
  test("use names that match their directory names", async () => {
    const skillDirs = await readdir(skillsRoot, { withFileTypes: true });

    for (const dirent of skillDirs) {
      if (!dirent.isDirectory()) continue;

      const skillPath = join(skillsRoot, dirent.name, "SKILL.md");
      const content = await Bun.file(skillPath).text();
      const frontmatter = parseFrontmatter(content);

      expect(frontmatter.name).toBe(dirent.name);
    }
  });

  test("avoid provider-specific absolute skill paths", async () => {
    const skillFiles = (await collectFiles(skillsRoot)).filter((path) => path.endsWith(".md"));
    const offenders: string[] = [];

    for (const path of skillFiles) {
      const content = await Bun.file(path).text();
      if (forbiddenProviderPaths.some((pattern) => content.includes(pattern))) {
        offenders.push(relative(skillsRoot, path));
      }
    }

    expect(offenders).toEqual([]);
  });

  test("use lowercase assets references", async () => {
    const skillFiles = (await collectFiles(skillsRoot)).filter((path) => path.endsWith(".md"));
    const offenders: string[] = [];

    for (const path of skillFiles) {
      const relativePath = relative(skillsRoot, path);
      const content = await Bun.file(path).text();
      if (relativePath.includes("/Assets/") || content.includes("Assets/")) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});
