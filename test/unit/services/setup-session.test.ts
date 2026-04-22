import { test, expect } from "bun:test";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildOpencodeArgs,
} from "../../../src/services/setup-session";

test("buildClaudeArgs returns claude argv with positional objective and --append-system-prompt", () => {
  expect(buildClaudeArgs("make it fast", "SKILL BODY")).toEqual([
    "claude",
    "make it fast",
    "--append-system-prompt",
    "SKILL BODY",
  ]);
});

test("buildOpencodeArgs returns opencode argv with --prompt and --agent shaka/autoresearch-setup", () => {
  expect(buildOpencodeArgs("make it fast")).toEqual([
    "opencode",
    "--prompt",
    "make it fast",
    "--agent",
    "shaka/autoresearch-setup",
  ]);
});

test("buildCodexArgs prepends skill body to the objective as a single positional prompt", () => {
  expect(buildCodexArgs("make it fast", "SKILL BODY")).toEqual([
    "codex",
    "SKILL BODY\n\n## Objective\n\nmake it fast",
  ]);
});
