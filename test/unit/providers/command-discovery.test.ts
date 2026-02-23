import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCommands } from "../../../src/providers/command-discovery";

describe("discoverCommands", () => {
  const testHome = join(tmpdir(), `shaka-test-commands-${process.pid}`);

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await mkdir(join(testHome, "system", "commands"), { recursive: true });
    await mkdir(join(testHome, "customizations", "commands"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  test("discovers single-file command from system/", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Create a commit\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("commit");
    expect(commands[0]?.description).toBe("Create a commit");
    expect(commands[0]?.body).toBe("Body");
  });

  test("discovers commands from customizations/", async () => {
    await Bun.write(
      join(testHome, "customizations", "commands", "deploy.md"),
      "---\ndescription: Deploy app\n---\nDeploy body",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("deploy");
  });

  test("customization overrides system by name", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: System commit\n---\nSystem body",
    );
    await Bun.write(
      join(testHome, "customizations", "commands", "commit.md"),
      "---\ndescription: Custom commit\n---\nCustom body",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.description).toBe("Custom commit");
    expect(commands[0]?.sourcePath).toContain("customizations");
  });

  test("filters out disabled commands", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Create a commit\n---\nBody",
    );
    await Bun.write(
      join(testHome, "system", "commands", "review.md"),
      "---\ndescription: Review code\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome, ["commit"]);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("review");
  });

  test("reports error for missing description", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "bad.md"),
      "---\nsubtask: true\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Missing required field: description");
  });

  test("reports error for invalid command name", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "My Command.md"),
      "---\ndescription: Bad name\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid command name");
  });

  test("reports error for reserved name shaka", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "shaka.md"),
      "---\ndescription: Shaka command\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Reserved command name");
  });

  test("reports error for missing frontmatter", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "plain.md"),
      "Just some text without frontmatter",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("No frontmatter found");
  });

  test("parses optional fields", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      `---
description: Deploy app
argument-hint: <env>
model: sonnet
subtask: true
user-invocable: false
---
Deploy to $1`,
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.argumentHint).toBe("<env>");
    expect(commands[0]?.model).toBe("sonnet");
    expect(commands[0]?.subtask).toBe(true);
    expect(commands[0]?.userInvocable).toBe(false);
  });

  test("returns valid commands alongside errors", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "good.md"),
      "---\ndescription: Good command\n---\nBody",
    );
    await Bun.write(
      join(testHome, "system", "commands", "bad.md"),
      "---\nsubtask: true\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("good");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("bad");
  });

  test("handles empty commands directories", async () => {
    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("handles non-existent commands directories", async () => {
    const emptyHome = join(tmpdir(), `shaka-test-empty-${process.pid}`);
    await mkdir(emptyHome, { recursive: true });

    const { commands, errors } = await discoverCommands(emptyHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(0);

    await rm(emptyHome, { recursive: true, force: true });
  });

  test("ignores non-.md files", async () => {
    await Bun.write(join(testHome, "system", "commands", "readme.txt"), "not a command");
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("commit");
  });

  test("rejects name with leading hyphen", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "-bad.md"),
      "---\ndescription: Bad\n---\nBody",
    );

    const { errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid command name");
  });

  test("rejects name with trailing hyphen", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "bad-.md"),
      "---\ndescription: Bad\n---\nBody",
    );

    const { errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid command name");
  });

  test("rejects name with uppercase letters", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "BadName.md"),
      "---\ndescription: Bad\n---\nBody",
    );

    const { errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid command name");
  });

  test("rejects name exceeding 64 characters", async () => {
    const longName = "a".repeat(65);
    await Bun.write(
      join(testHome, "system", "commands", `${longName}.md`),
      "---\ndescription: Too long\n---\nBody",
    );

    const { errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid command name");
  });

  test("accepts valid hyphenated name", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "review-pr.md"),
      "---\ndescription: Review PRs\n---\nBody",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.name).toBe("review-pr");
  });

  test("treats empty body as valid", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "empty.md"),
      "---\ndescription: Empty body\n---\n",
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toBe("");
  });

  // ── cwd field ───────────────────────────────────────────────────────

  test("cwd absent → undefined (global)", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeUndefined();
  });

  test('cwd: "*" → undefined (global)', async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      '---\ndescription: Commit\ncwd: "*"\n---\nBody',
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeUndefined();
  });

  test('cwd: ["*"] → undefined (global, array form)', async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      '---\ndescription: Commit\ncwd:\n  - "*"\n---\nBody',
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeUndefined();
  });

  test("cwd: bare ~ → [homedir]", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "home.md"),
      '---\ndescription: Home\ncwd: "~"\n---\nBody',
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeArrayOfSize(1);
    expect(commands[0]?.cwd?.[0]).toBe(homedir());
  });

  test("cwd: string → [resolved] (tilde expanded)", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      "---\ndescription: Deploy\ncwd: ~/Projects/app\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeArrayOfSize(1);
    expect(commands[0]?.cwd?.[0]).not.toContain("~");
    expect(commands[0]?.cwd?.[0]).toContain(join("Projects", "app"));
  });

  test("cwd: string[] → [resolved...] (tilde expanded)", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "test.md"),
      "---\ndescription: Test\ncwd:\n  - ~/Projects/api\n  - ~/Projects/web\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toBeArrayOfSize(2);
    expect(commands[0]?.cwd?.[0]).toContain(join("Projects", "api"));
    expect(commands[0]?.cwd?.[1]).toContain(join("Projects", "web"));
  });

  test("cwd: absolute path passed through", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      "---\ndescription: Deploy\ncwd: /opt/my-app\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.cwd).toEqual(["/opt/my-app"]);
  });

  // ── providers field ─────────────────────────────────────────────────

  test("parses providers block with known providers", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "test-cmd.md"),
      `---
description: Test
providers:
  claude:
    model: opus
  opencode:
    model: anthropic/claude-sonnet-4-5
---
Body`,
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(errors).toHaveLength(0);
    expect(commands[0]?.providers?.claude).toEqual({ model: "opus" });
    expect(commands[0]?.providers?.opencode).toEqual({ model: "anthropic/claude-sonnet-4-5" });
  });

  test("providers absent → undefined", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "commit.md"),
      "---\ndescription: Commit\n---\nBody",
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.providers).toBeUndefined();
  });

  test("reports error for unknown provider in providers block", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "bad-provider.md"),
      `---
description: Bad
providers:
  gemini:
    model: fast
---
Body`,
    );

    const { commands, errors } = await discoverCommands(testHome);

    expect(commands).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('Unknown provider "gemini"');
  });

  test("providers block with partial overrides", async () => {
    await Bun.write(
      join(testHome, "system", "commands", "deploy.md"),
      `---
description: Deploy
model: sonnet
providers:
  claude:
    model: opus
---
Body`,
    );

    const { commands } = await discoverCommands(testHome);

    expect(commands[0]?.model).toBe("sonnet");
    expect(commands[0]?.providers?.claude).toEqual({ model: "opus" });
    expect(commands[0]?.providers?.opencode).toBeUndefined();
  });
});
