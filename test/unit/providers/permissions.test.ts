import { describe, expect, test } from "bun:test";
import {
  CLAUDE_PERMISSION_DEFAULTS,
  OPENCODE_PERMISSION_DEFAULTS,
  type ClaudePermissions,
  hasExistingOpencodePermissions,
  mergeClaudePermissions,
} from "../../../src/providers/permissions";

describe("permissions", () => {
  describe("CLAUDE_PERMISSION_DEFAULTS", () => {
    test("has non-empty allow list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.allow.length).toBeGreaterThan(0);
    });

    test("includes Bash in allow list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.allow).toContain("Bash");
    });

    test("includes mcp wildcard in allow list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.allow).toContain("mcp__*");
    });

    test("has empty deny list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.deny).toEqual([]);
    });

    test("has non-empty ask list with safety guards", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.ask.length).toBeGreaterThan(0);
    });

    test("guards rm -rf / in ask list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.ask).toContain("Bash(rm -rf /)");
    });

    test("guards force push in ask list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.ask).toContain("Bash(git push --force:*)");
    });

    test("guards SSH key reads in ask list", () => {
      expect(CLAUDE_PERMISSION_DEFAULTS.ask).toContain("Read(~/.ssh/id_*)");
    });
  });

  describe("OPENCODE_PERMISSION_DEFAULTS", () => {
    test("allows edit", () => {
      expect(OPENCODE_PERMISSION_DEFAULTS.edit).toBe("allow");
    });

    test("allows bash", () => {
      expect(OPENCODE_PERMISSION_DEFAULTS.bash).toBe("allow");
    });
  });

  describe("hasExistingOpencodePermissions", () => {
    test("returns false for empty object", () => {
      expect(hasExistingOpencodePermissions({})).toBe(false);
    });

    test("returns true when permission is defined", () => {
      expect(hasExistingOpencodePermissions({ permission: { edit: "ask" } })).toBe(true);
    });
  });

  describe("mergeClaudePermissions", () => {
    test("adds Shaka defaults to empty permissions", () => {
      const result = mergeClaudePermissions({});
      expect(result.allow).toEqual(CLAUDE_PERMISSION_DEFAULTS.allow);
      expect(result.ask).toEqual(CLAUDE_PERMISSION_DEFAULTS.ask);
      expect(result.deny).toEqual([]);
    });

    test("unions allow lists without duplicates", () => {
      const existing: ClaudePermissions = {
        allow: ["Bash", "CustomTool"],
        deny: [],
        ask: [],
      };
      const result = mergeClaudePermissions(existing);
      expect(result.allow).toContain("CustomTool");
      expect(result.allow).toContain("Bash");
      expect(result.allow).toContain("Read");
      // No duplicates
      expect(result.allow.filter((x) => x === "Bash")).toHaveLength(1);
    });

    test("unions ask lists without duplicates", () => {
      const existing: ClaudePermissions = {
        allow: [],
        deny: [],
        ask: ["Bash(rm -rf /)", "Bash(custom-dangerous:*)"],
      };
      const result = mergeClaudePermissions(existing);
      expect(result.ask).toContain("Bash(custom-dangerous:*)");
      expect(result.ask).toContain("Bash(rm -rf /)");
      expect(result.ask.filter((x) => x === "Bash(rm -rf /)")).toHaveLength(1);
    });

    test("preserves existing deny rules", () => {
      const existing: ClaudePermissions = {
        allow: [],
        deny: ["WebFetch", "WebSearch"],
        ask: [],
      };
      const result = mergeClaudePermissions(existing);
      expect(result.deny).toEqual(["WebFetch", "WebSearch"]);
    });

    test("does not add deny rules from defaults", () => {
      const result = mergeClaudePermissions({});
      expect(result.deny).toEqual([]);
    });
  });
});
