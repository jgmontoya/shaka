import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const agentsRoot = resolve(import.meta.dir, "..", "..", "..", "defaults", "system", "agents");

async function readAgent(name: string): Promise<string> {
  return (await Bun.file(join(agentsRoot, `${name}.md`)).text()).replace(/\s+/g, " ");
}

describe("shipped agents", () => {
  test("Engineer follows project architecture and testing policy without extra approval gates", async () => {
    const content = await readAgent("Engineer");

    expect(content).toMatch(/Project conventions override/);
    expect(content).toMatch(/TDD unless.*opts out.*tests do not make sense/);
    expect(content).toMatch(/approval only when.*user or project/);
    expect(content).not.toMatch(/every feature.{0,50}standalone library/i);
    expect(content).not.toMatch(/every library.{0,50}CLI/i);
    expect(content).not.toMatch(/tests? must be approved before implementation/i);
  });

  test("Architect derives interfaces and scale from demonstrated requirements", async () => {
    const content = await readAgent("Architect");

    expect(content).toMatch(/caller usage/i);
    expect(content).toMatch(/verified requirements/);
    expect(content).toMatch(/measured bottlenecks/);
    expect(content).toMatch(/approval only when.*user or project/);
    expect(content).not.toMatch(/\b3[-–]5.year|\b10x\b|maximum.{0,20}three projects/i);
    expect(content).not.toMatch(/MUST.{0,20}(?:plan mode|EnterPlanMode)/i);
  });

  test("QA requires evidence for the affected surface and reports unavailable capabilities", async () => {
    const content = await readAgent("QATester");

    expect(content).toMatch(/Do not assume.*installed/);
    expect(content).toMatch(/browser evidence/);
    expect(content).toMatch(/unit test alone does not establish/);
    expect(content).toMatch(/CLI and API work/);
    expect(content).toMatch(/missing capability.*UNVERIFIED/);
    expect(content).not.toMatch(/browser-automation|Stagehand/i);
  });

  test("research uses authorized tools and reports access limits without sandbox bypasses", async () => {
    const content = await readAgent("CodexResearcher");

    expect(content).toMatch(/project instructions/);
    expect(content).toMatch(/remains unknown/);
    expect(content).toMatch(/Don't bypass the sandbox/);
    expect(content).not.toMatch(
      /--dangerously-bypass-approvals-and-sandbox|--sandbox\s+danger-full-access/,
    );
  });

  // Claude Code rejects bare "mcp__*" in allow rules (the server must be
  // named, with globs only in the tool position), so shipping it grants
  // nothing and trips /doctor. Same contract as CLAUDE_PERMISSION_DEFAULTS.
  test("ship no bare mcp wildcard in permission rules", async () => {
    const offenders: string[] = [];

    for (const entry of await readdir(agentsRoot)) {
      if (!entry.endsWith(".md")) continue;
      const content = await Bun.file(join(agentsRoot, entry)).text();
      if (content.includes('"mcp__*"')) {
        offenders.push(entry);
      }
    }

    expect(offenders).toEqual([]);
  });
});
