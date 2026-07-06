import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const agentsRoot = resolve(import.meta.dir, "..", "..", "..", "defaults", "system", "agents");

describe("shipped agents", () => {
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
