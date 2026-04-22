import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseFrontmatter } from "../../../src/domain/frontmatter";

/**
 * Drift guard: the autoresearch-setup agent body (installed into each
 * provider's agents directory at init time) must match the
 * AutoresearchSetup SKILL body byte-for-byte. Plan content policy:
 * "one source of truth, installed into two provider-specific paths."
 */

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const agentPath = resolve(repoRoot, "defaults/system/agents/autoresearch-setup.md");
const skillPath = resolve(repoRoot, "defaults/system/skills/AutoresearchSetup/SKILL.md");

describe("autoresearch-setup agent file", () => {
  test("body below frontmatter matches AutoresearchSetup SKILL body byte-for-byte", async () => {
    const agentRaw = await Bun.file(agentPath).text();
    const skillRaw = await Bun.file(skillPath).text();

    const agentParsed = parseFrontmatter(agentRaw);
    const skillParsed = parseFrontmatter(skillRaw);

    expect(agentParsed).not.toBeNull();
    expect(skillParsed).not.toBeNull();
    expect(agentParsed?.body).toBe(skillParsed?.body ?? "");
  });

  test("frontmatter grants autonomous setup permissions with network denied", async () => {
    const agentRaw = await Bun.file(agentPath).text();
    const parsed = parseFrontmatter(agentRaw);
    expect(parsed).not.toBeNull();

    const fm = parsed?.frontmatter ?? {};
    expect(fm.name).toBe("autoresearch-setup");

    // Claude Code: deny network-reaching tools explicitly.
    const claudePerms = fm.permissions as { deny?: string[] } | undefined;
    expect(Array.isArray(claudePerms?.deny)).toBe(true);
    expect(claudePerms?.deny).toContain("WebFetch(domain:*)");
    expect(claudePerms?.deny).toContain("WebSearch");

    // Opencode: primary agent with edit + bash allowed (not the inference
    // sub-agent's "*: deny" shape — this is the opposite role).
    expect(fm.mode).toBe("primary");
    const ocPerms = fm.permission as Record<string, string> | undefined;
    expect(ocPerms?.edit).toBe("allow");
    expect(ocPerms?.bash).toBe("allow");
    expect(ocPerms?.webfetch).toBe("deny");
    expect(ocPerms?.websearch).toBe("deny");
  });
});
