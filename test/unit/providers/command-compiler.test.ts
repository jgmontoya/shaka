import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DiscoveredCommand } from "../../../src/providers/command-discovery";
import {
  compileForClaude,
  compileForCodex,
  compileForOpencode,
} from "../../../src/providers/command-compiler";

function makeCommand(overrides: Partial<DiscoveredCommand> = {}): DiscoveredCommand {
  return {
    name: "commit",
    description: "Create a commit",
    body: "Analyze staged changes.\n\n$ARGUMENTS",
    sourcePath: "/home/test/.config/shaka/system/commands/commit.md",
    ...overrides,
  };
}

describe("compileForClaude", () => {
  test("produces correct SKILL.md path", () => {
    const targetDir = join("/home", "test", ".claude", "skills");
    const result = compileForClaude(makeCommand(), targetDir);
    expect(result.path).toBe(join(targetDir, "commit", "SKILL.md"));
  });

  test("maps description to frontmatter", () => {
    const result = compileForClaude(makeCommand(), "/home/test/.claude/skills");
    expect(result.content).toContain("description: Create a commit");
  });

  test("maps argument-hint", () => {
    const cmd = makeCommand({ argumentHint: "<message>" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("argument-hint: <message>");
  });

  test("maps model", () => {
    const cmd = makeCommand({ model: "opus" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("model: opus");
  });

  test("maps subtask to context: fork", () => {
    const cmd = makeCommand({ subtask: true });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("context: fork");
    expect(result.content).not.toContain("subtask");
  });

  test("maps user-invocable", () => {
    const cmd = makeCommand({ userInvocable: false });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("user-invocable: false");
  });

  test("defaults user-invocable to true", () => {
    const result = compileForClaude(makeCommand(), "/home/test/.claude/skills");
    expect(result.content).toContain("user-invocable: true");
  });

  test("decrements positional args ($1 -> $0, $2 -> $1)", () => {
    const cmd = makeCommand({ body: "Migrate $1 from $2 to $3" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("Migrate $0 from $1 to $2");
  });

  test("leaves $0 untouched (does not produce $-1)", () => {
    const cmd = makeCommand({ body: "Use $0 and $1" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("Use $0 and $0");
    expect(result.content).not.toContain("$-1");
  });

  test("does not decrement $ARGUMENTS", () => {
    const cmd = makeCommand({ body: "Review: $ARGUMENTS" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("Review: $ARGUMENTS");
  });

  test("skips $N inside shell injection blocks", () => {
    const cmd = makeCommand({ body: "Run: !`awk '{print $1}'`\nThen use $1" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    // $1 inside !`...` should be preserved, $1 outside should be decremented
    expect(result.content).toContain("!`awk '{print $1}'`");
    expect(result.content).toContain("Then use $0");
  });

  test("auto-appends $ARGUMENTS when no arg references", () => {
    const cmd = makeCommand({ body: "Just do something" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("Just do something\n\n$ARGUMENTS");
  });

  test("does not auto-append when $ARGUMENTS is present", () => {
    const cmd = makeCommand({ body: "Do: $ARGUMENTS" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    const bodyPart = result.content.split("---\n").slice(-1)[0] ?? "";
    // Should only contain one $ARGUMENTS
    expect(bodyPart.match(/\$ARGUMENTS/g)?.length).toBe(1);
  });

  test("does not auto-append when $N is present", () => {
    const cmd = makeCommand({ body: "Deploy $1" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).not.toContain("$ARGUMENTS");
  });

  test("auto-appends $ARGUMENTS when $N only appears in shell injection blocks", () => {
    const cmd = makeCommand({ body: "Run: !`awk '{print $1}'`" });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("$ARGUMENTS");
  });
});

describe("compileForOpencode", () => {
  test("produces correct flat file path", () => {
    const targetDir = join("/home", "test", ".config", "opencode", "commands");
    const result = compileForOpencode(makeCommand(), targetDir);
    expect(result.path).toBe(join(targetDir, "commit.md"));
  });

  test("maps description to frontmatter", () => {
    const result = compileForOpencode(makeCommand(), "/home/test/.config/opencode/commands");
    expect(result.content).toContain("description: Create a commit");
  });

  test("maps model", () => {
    const cmd = makeCommand({ model: "anthropic/claude-sonnet-4-5" });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).toContain("model: anthropic/claude-sonnet-4-5");
  });

  test("maps subtask", () => {
    const cmd = makeCommand({ subtask: true });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).toContain("subtask: true");
  });

  test("drops argument-hint (opencode does not support it)", () => {
    const cmd = makeCommand({ argumentHint: "<message>" });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).not.toContain("argument-hint");
  });

  test("drops user-invocable (always true in opencode)", () => {
    const cmd = makeCommand({ userInvocable: false });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).not.toContain("user-invocable");
  });

  test("copies body verbatim (no $N translation)", () => {
    const cmd = makeCommand({ body: "Deploy $1 to $2" });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).toContain("Deploy $1 to $2");
  });

  test("auto-appends $ARGUMENTS when no arg references", () => {
    const cmd = makeCommand({ body: "Just do something" });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).toContain("Just do something\n\n$ARGUMENTS");
  });

  test("does not auto-append when $ARGUMENTS is present", () => {
    const cmd = makeCommand({ body: "Do: $ARGUMENTS" });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    const bodyPart = result.content.split("---\n").slice(-1)[0] ?? "";
    expect(bodyPart.match(/\$ARGUMENTS/g)?.length).toBe(1);
  });
});

describe("compileForCodex", () => {
  test("produces SKILL.md path inside named directory", () => {
    const targetDir = join("/home", "test", ".agents", "skills");
    const result = compileForCodex(makeCommand(), targetDir);
    expect(result.path).toBe(join(targetDir, "commit", "SKILL.md"));
  });

  test("maps description and argument-hint into description", () => {
    const cmd = makeCommand({ argumentHint: "<message>" });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    expect(result.content).toContain("description:");
    expect(result.content).toContain("<message>");
  });

  test("replaces $ARGUMENTS with natural-language instruction", () => {
    const cmd = makeCommand({ body: "Review this: $ARGUMENTS" });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    expect(result.content).not.toContain("$ARGUMENTS");
    expect(result.content).toContain("Interpret the user's message");
  });

  test("replaces positional args with ordinal descriptions", () => {
    const cmd = makeCommand({ body: "Deploy $1 to $2" });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    expect(result.content).not.toContain("$1");
    expect(result.content).not.toContain("$2");
    expect(result.content).toContain("first argument");
    expect(result.content).toContain("second argument");
  });

  test("preserves $N inside shell injection blocks", () => {
    const cmd = makeCommand({ body: "Run: !`awk '{print $1}'`\n\nAnalyze $1" });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    // $1 inside shell block preserved, $1 outside replaced
    expect(result.content).toContain("!`awk '{print $1}'`");
    expect(result.content).toContain("first argument");
  });

  test("auto-appends $ARGUMENTS before replacing when no arg references", () => {
    const cmd = makeCommand({ body: "Just do something" });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    // Should have been auto-appended then replaced
    expect(result.content).toContain("Interpret the user's message");
  });

  test("drops model, subtask, user-invocable from frontmatter", () => {
    const cmd = makeCommand({ model: "opus", subtask: true, userInvocable: false });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    expect(result.content).not.toContain("model:");
    expect(result.content).not.toContain("subtask:");
    expect(result.content).not.toContain("user-invocable:");
  });

  test("applies codex provider overrides", () => {
    const cmd = makeCommand({
      providers: { codex: { description: "Codex-specific" } },
    });
    const result = compileForCodex(cmd, "/home/test/.agents/skills");
    expect(result.content).toContain("description: Codex-specific");
  });
});

describe("provider overrides", () => {
  test("claude override merges model", () => {
    const cmd = makeCommand({
      model: "sonnet",
      providers: { claude: { model: "opus" } },
    });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("model: opus");
    expect(result.content).not.toContain("model: sonnet");
  });

  test("opencode override merges model", () => {
    const cmd = makeCommand({
      model: "sonnet",
      providers: { opencode: { model: "anthropic/claude-sonnet-4-5" } },
    });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(result.content).toContain("model: anthropic/claude-sonnet-4-5");
    expect(result.content).not.toContain("model: sonnet");
  });

  test("overrides don't leak between providers", () => {
    const cmd = makeCommand({
      model: "sonnet",
      providers: { claude: { model: "opus" } },
    });
    const result = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    // opencode should use base model, not claude override
    expect(result.content).toContain("model: sonnet");
    expect(result.content).not.toContain("model: opus");
  });

  test("claude override merges description", () => {
    const cmd = makeCommand({
      providers: { claude: { description: "Claude-specific description" } },
    });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("description: Claude-specific description");
  });

  test("no overrides uses base fields", () => {
    const cmd = makeCommand({ model: "sonnet" });
    const claudeResult = compileForClaude(cmd, "/home/test/.claude/skills");
    const opcodeResult = compileForOpencode(cmd, "/home/test/.config/opencode/commands");
    expect(claudeResult.content).toContain("model: sonnet");
    expect(opcodeResult.content).toContain("model: sonnet");
  });

  test("claude override for subtask → context: fork", () => {
    const cmd = makeCommand({
      providers: { claude: { subtask: true } },
    });
    const result = compileForClaude(cmd, "/home/test/.claude/skills");
    expect(result.content).toContain("context: fork");
  });
});
