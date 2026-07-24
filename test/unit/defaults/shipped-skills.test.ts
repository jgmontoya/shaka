import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const skillsRoot = resolve(import.meta.dir, "..", "..", "..", "defaults", "system", "skills");
const repositoryRoot = resolve(skillsRoot, "..", "..", "..");
const forbiddenProviderPaths = ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode"];
const redTeamRoot = join(skillsRoot, "red-team");
const parallelAnalysisPath = join(redTeamRoot, "Workflows", "ParallelAnalysis.md");
const redTeamDocumentPaths = [
  join(redTeamRoot, "SKILL.md"),
  join(redTeamRoot, "Philosophy.md"),
  join(redTeamRoot, "Integration.md"),
  parallelAnalysisPath,
  join(redTeamRoot, "Workflows", "AdversarialValidation.md"),
];

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
  test("ships the canonical task-sized red-team workflow", async () => {
    const bytes = new Uint8Array(await Bun.file(parallelAnalysisPath).arrayBuffer());
    const content = new TextDecoder().decode(bytes);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

    expect(bytes.byteLength).toBe(2_997);
    expect(sha256).toBe("2ba8b3bbde365000fefadbb3663dfad9b02e8388976d59d9a123fd6565599783");
    expect(content).toContain("Keep the decomposition proportional to the task");
    expect(content).toMatch(/the\s+user's budget/);
    expect(content).toMatch(/State the applicable stop\s+reason and unresolved concerns/);
    expect(content).toMatch(/There is no required review-pass count or minimum\s+runtime/);
    expect(content).toMatch(/Active scanning, exploitation,\s+or access/);
  });

  test("uses subagents when available and declares an honest local fallback", async () => {
    const content = await Bun.file(parallelAnalysisPath).text();

    expect(content).toMatch(
      /active harness exposes agent delegation,\s+use available\s+subagents for the initial passes/,
    );
    expect(content).toMatch(
      /Run them concurrently\s+when supported; otherwise dispatch them sequentially/,
    );
    expect(content).toMatch(
      /If subagents are unavailable, disabled, denied, exhausted, or blocked by nesting\s+limits/,
    );
    expect(content).toMatch(/Do\s+not describe local passes as independent agents/);
    expect(content).toMatch(/State whether the review used subagents or\s+sequential local passes/);
    expect(content).not.toMatch(/\b(?:spawn_agent|Task tool|Agent tool|subagent_type)\b/);
  });

  test("aligns shipped red-team documentation with the task-sized contract", async () => {
    const documents = await Promise.all(
      redTeamDocumentPaths.map(async (path) => ({
        path: relative(redTeamRoot, path),
        content: await Bun.file(path).text(),
      })),
    );
    const skill = documents.find(({ path }) => path === "SKILL.md")?.content ?? "";
    const integration = documents.find(({ path }) => path === "Integration.md")?.content ?? "";
    const adversarialValidation =
      documents.find(({ path }) => path === join("Workflows", "AdversarialValidation.md"))
        ?.content ?? "";
    const readme = await Bun.file(join(repositoryRoot, "README.md")).text();
    const validatePlan = await Bun.file(join(skillsRoot, "validate-plan", "SKILL.md")).text();
    const forbiddenPatterns = [
      { name: "fixed 24-claim decomposition", pattern: /\b24 atomic (?:claims|pieces)\b/i },
      { name: "fixed 32-agent roster", pattern: /\b32[- ]agents?\b/i },
      { name: "provider-specific Task tool", pattern: /\bTask tool\b/i },
      { name: "provider-specific general-purpose dispatch", pattern: /\bgeneral-purpose\b/i },
      {
        name: "unshipped skill reference",
        pattern: /`(?:storyexplanation|extractalpha|research|xpost)`/i,
      },
    ];
    const offenders = documents.flatMap(({ path, content }) =>
      forbiddenPatterns
        .filter(({ pattern }) => pattern.test(content))
        .map(({ name }) => `${path}: ${name}`),
    );

    expect(offenders).toEqual([]);
    expect(skill).toContain("Workflows/ParallelAnalysis.md");
    expect(skill).toContain("Workflows/AdversarialValidation.md");
    expect(skill).toContain("Philosophy.md");
    expect(skill).toContain("Integration.md");
    expect(await Bun.file(join(redTeamRoot, "Workflows", "ParallelAnalysis.md")).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(redTeamRoot, "Workflows", "AdversarialValidation.md")).exists(),
    ).toBe(true);
    expect(integration).not.toMatch(/`(?:storyexplanation|extractalpha|research|xpost)`/i);
    expect(adversarialValidation).toContain("`ParallelAnalysis.md`");
    expect(adversarialValidation).not.toContain("`parallelAnalysis.md`");
    expect(adversarialValidation).not.toContain("`Tree-of-thought.md`");
    expect(readme).toMatch(
      /\|\s*red-team\s*\|\s*Evidence-backed adversarial analysis and steelmanning\s*\|/,
    );
    expect(readme).not.toMatch(/\|\s*red-team\s*\|[^|\n]*32 agents/i);
    expect(validatePlan).not.toContain("32-agent adversarial attack");
    expect(validatePlan).toContain("If a sibling workflow says `Task`");
    expect(validatePlan).toContain("Shaka capability names (`research`");
  });

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
