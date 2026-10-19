import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../../../src/domain/frontmatter";

const councilRoot = resolve(import.meta.dir, "../../../defaults/system/skills/council");
const agentsRoot = resolve(import.meta.dir, "../../../defaults/system/agents");

function headingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading = ""] of content.matchAll(/^#+\s+(.+)$/gm)) {
    anchors.add(
      heading
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
    );
  }
  return anchors;
}

describe("council skill", () => {
  test("maps each role to a shipped agent with that capability", async () => {
    const members = await Bun.file(join(councilRoot, "CouncilMembers.md")).text();
    const rows = [...members.matchAll(/\| `([\w-]+)` \| `(\w+)` \|/g)];
    expect(rows.length).toBeGreaterThan(0);

    for (const [, capability, name] of rows) {
      const agent = Bun.file(join(agentsRoot, `${name}.md`));
      expect(await agent.exists(), `${name} is not a shipped agent`).toBe(true);
      expect(parseFrontmatter(await agent.text())?.frontmatter.capability).toBe(capability);
    }
  });

  test("links resolve to existing documents and headings", async () => {
    const paths = (await readdir(councilRoot, { recursive: true })).filter((path) =>
      path.endsWith(".md"),
    );

    for (const path of paths) {
      const content = await Bun.file(join(councilRoot, path)).text();
      for (const [, target = "", anchor] of content.matchAll(
        /\[[^\]]+\]\(([^)#]+\.md)(?:#([^)]+))?\)/g,
      )) {
        const linked = Bun.file(resolve(councilRoot, dirname(path), target));
        expect(await linked.exists(), `${path} links to missing ${target}`).toBe(true);
        if (anchor) {
          expect(
            headingAnchors(await linked.text()).has(anchor),
            `${path} → ${target}#${anchor}`,
          ).toBe(true);
        }
      }
    }
  });
});
