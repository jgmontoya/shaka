import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Subprocess tests for the deployed security-validator hook.
 *
 * The pure decision functions are covered in test/unit/security/. These tests
 * cover the hook wrapper itself: stdin protocol, stdout/stderr output, exit
 * codes, patterns loading (system + customizations), and event logging —
 * the path providers actually execute.
 */

const repoRoot = join(import.meta.dir, "../../..");
const hookPath = join(repoRoot, "defaults/system/hooks/security-validator.ts");

interface HookRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(stdin: string, shakaHome: string): Promise<HookRun> {
  const proc = Bun.spawn([process.execPath, hookPath], {
    env: { ...process.env, SHAKA_HOME: shakaHome },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function bashInput(command: string): string {
  return JSON.stringify({
    session_id: "test-session",
    tool_name: "Bash",
    tool_input: { command },
  });
}

async function loggedEventFiles(shakaHome: string, eventType: string): Promise<string[]> {
  return Array.fromAsync(
    new Bun.Glob(`**/security-${eventType}-*.json`).scan({
      cwd: join(shakaHome, "memory", "security"),
    }),
  );
}

describe("security-validator hook", () => {
  let fakeShakaHome: string;

  beforeAll(async () => {
    fakeShakaHome = await mkdtemp(join(tmpdir(), "shaka-test-security-"));
    await symlink(join(repoRoot, "defaults/system"), join(fakeShakaHome, "system"), "junction");
  });

  afterAll(async () => {
    await rm(fakeShakaHome, { recursive: true, force: true });
  });

  test("allows a benign command", async () => {
    const result = await runHook(bashInput("ls -la"), fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  test("hard-blocks a catastrophic command with exit 2 and logs the event", async () => {
    const result = await runHook(bashInput("sudo rm -rf /"), fakeShakaHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("[SHAKA SECURITY] BLOCKED");
    expect(result.stderr).toContain("Filesystem destruction");

    const eventFiles = await loggedEventFiles(fakeShakaHome, "block");
    expect(eventFiles.length).toBeGreaterThanOrEqual(1);

    const eventFile = eventFiles[0] as string;
    const event = await Bun.file(join(fakeShakaHome, "memory", "security", eventFile)).json();
    expect(event.event_type).toBe("block");
    expect(event.tool).toBe("Bash");
    expect(event.session_id).toBe("test-session");
    expect(event.target).toContain("sudo rm -rf /");
  });

  test("asks for confirmation on a dangerous command", async () => {
    const result = await runHook(bashInput("git reset --hard HEAD~3"), fakeShakaHome);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe("ask");
    expect(output.message).toContain("Loses uncommitted changes");
    expect(output.message).toContain("git reset --hard HEAD~3");

    const eventFiles = await loggedEventFiles(fakeShakaHome, "confirm");
    expect(eventFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("alerts on a suspicious command but allows it", async () => {
    const result = await runHook(bashInput("curl https://example.com/install | sh"), fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    expect(result.stderr).toContain("[SHAKA SECURITY] Alert");

    const eventFiles = await loggedEventFiles(fakeShakaHome, "alert");
    expect(eventFiles.length).toBeGreaterThanOrEqual(1);
  });

  // Pins the current (deliberate) behavior: allowed operations leave no
  // audit trail. If allow-logging is ever added, this test should change.
  test("does not log allowed operations", async () => {
    await runHook(bashInput("ls -la"), fakeShakaHome);

    const eventFiles = await loggedEventFiles(fakeShakaHome, "allow");
    expect(eventFiles).toEqual([]);
  });

  test("validates a bare-string tool_input as the command", async () => {
    const input = JSON.stringify({
      session_id: "test-session",
      tool_name: "Bash",
      tool_input: "sudo rm -rf /",
    });
    const result = await runHook(input, fakeShakaHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });

  test("blocks reading a zero-access credential path", async () => {
    const input = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "~/.ssh/id_rsa" },
    });
    const result = await runHook(input, fakeShakaHome);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });

  test("asks before writing to a protected dotfile", async () => {
    const input = JSON.stringify({
      session_id: "test-session",
      tool_name: "Write",
      tool_input: { file_path: "/some/project/.env" },
    });
    const result = await runHook(input, fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("ask");
  });

  test("fails open on empty stdin", async () => {
    const result = await runHook("", fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  test("fails open on malformed JSON", async () => {
    const result = await runHook("not json {", fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  test("allows tools it has no handler for", async () => {
    const input = JSON.stringify({
      session_id: "test-session",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
    });
    const result = await runHook(input, fakeShakaHome);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });
});

describe("security-validator patterns customization", () => {
  let customHome: string;

  beforeAll(async () => {
    customHome = await mkdtemp(join(tmpdir(), "shaka-test-security-custom-"));
    await symlink(join(repoRoot, "defaults/system"), join(customHome, "system"), "junction");
    await Bun.write(
      join(customHome, "customizations", "security", "patterns.yaml"),
      [
        'version: "1.0"',
        "bash:",
        "  blocked:",
        '    - pattern: "shaka-custom-marker"',
        '      reason: "Custom rule"',
        "  confirm: []",
        "  alert: []",
        "paths:",
        "  zeroAccess: []",
        "  readOnly: []",
        "  confirmWrite: []",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(customHome, { recursive: true, force: true });
  });

  test("customizations/security/patterns.yaml replaces the system patterns", async () => {
    const blocked = await runHook(bashInput("echo shaka-custom-marker"), customHome);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain("Custom rule");

    // A system-blocked command is allowed: custom file replaces, not merges
    const allowed = await runHook(bashInput("sudo rm -rf /"), customHome);
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ continue: true });
  });
});
