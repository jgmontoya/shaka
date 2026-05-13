/**
 * `shaka doctor` provider-status output. Tests the contract between the
 * `cliInstalled` / `enabled` flags and what gets printed for each provider —
 * particularly the Pi credential check, which used to surface a warning even
 * when the user explicitly disabled Pi.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logProviderStatus } from "../../../src/commands/doctor";
import { PiProviderConfigurer } from "../../../src/providers/pi/configurer";
import type { InstallationStatus, ProviderConfigurer } from "../../../src/providers/types";

const SCOPED_PI_HOME = join(tmpdir(), `shaka-doctor-pi-${process.pid}`);

const OK_STATUS: InstallationStatus = {
  hooks: { ok: true },
  agents: { ok: true },
  skills: { ok: true },
  installedSkills: { ok: true },
  commands: { ok: true },
};

const captured: string[] = [];
const originalLog = console.log;
const savedEnv = { ...process.env };

function createProvider(overrides: Partial<ProviderConfigurer> = {}): ProviderConfigurer {
  return {
    name: "codex",
    label: "Codex",
    skillsDir: "/unused/skills",
    commands: {
      install: async () => {},
    },
    isInstalled: () => true,
    install: async () => ({ ok: true, value: undefined }),
    installCommands: async () => {},
    uninstall: async () => ({ ok: true, value: undefined }),
    checkInstallation: async () => OK_STATUS,
    ...overrides,
  };
}

beforeEach(async () => {
  captured.length = 0;
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  // Scope Pi's credential lookup to an empty temp dir — without this, the
  // developer's real ~/.pi/agent/auth.json (or PI_CODING_AGENT_DIR) makes
  // checkPiCredentials succeed, hiding the bug under test.
  await rm(SCOPED_PI_HOME, { recursive: true, force: true });
  await mkdir(SCOPED_PI_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = SCOPED_PI_HOME;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
});

afterEach(async () => {
  console.log = originalLog;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    // `process.env`'s type allows `undefined`; assigning it would land as
    // the literal string "undefined", so route those through delete.
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(SCOPED_PI_HOME, { recursive: true, force: true });
});

describe("logProviderStatus — Pi credential surface", () => {
  test("treats auth.json as missing when the path is a directory (Docker bind-mount foot-gun)", async () => {
    // docker-compose.yml mounts ~/.pi/agent/auth.json into containers; when
    // the host file is missing, Docker creates an empty *directory* at that
    // path. `Bun.file().size` returns a non-zero block size for directories
    // (verified upstream Bun issue), so a naive size>0 check returns true
    // and the warning gets silently suppressed even though no real auth
    // file exists.
    await mkdir(join(SCOPED_PI_HOME, "auth.json"), { recursive: true });
    const pi = new PiProviderConfigurer({
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });
    logProviderStatus(pi, true, OK_STATUS, true);

    const output = captured.join("\n");
    expect(output).toMatch(/Credentials:.*no credentials found/i);
  });

  test("does not print a Credentials line when Pi is disabled (even if creds are missing)", () => {
    // The user explicitly turned Pi off — doctor already prints "skipped
    // (not enabled)" for the install/agents/skills checks. The credential
    // warning should follow the same gate; otherwise a disabled provider
    // still complains about unrelated env state.
    const pi = new PiProviderConfigurer({
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });
    logProviderStatus(pi, true, OK_STATUS, false);

    const output = captured.join("\n");
    expect(output).not.toMatch(/Credentials:/i);
    expect(output).toMatch(/skipped \(not enabled\)/);
  });

  test("missing Pi credentials count as an issue (don't print ✗ then claim ✓ all systems operational)", () => {
    // Self-contradiction: the per-provider line says ✗ but the final
    // summary in `runDoctor` checks `hasIssues` to decide between "all
    // systems operational" and "issues found". Without flipping
    // hasIssues, doctor printed both lines and exited 0.
    const pi = new PiProviderConfigurer({
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });
    const hasIssues = logProviderStatus(pi, true, OK_STATUS, true);
    expect(hasIssues).toBe(true);
  });

  test("prints a Credentials line when Pi is enabled and all credentials are absent", () => {
    // Symmetric guard for the disabled-provider test above. beforeEach
    // already clears both env vars and scopes PI_CODING_AGENT_DIR to an
    // empty dir, so the missing-creds condition is satisfied.
    const pi = new PiProviderConfigurer({
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });
    logProviderStatus(pi, true, OK_STATUS, true);

    const output = captured.join("\n");
    expect(output).toMatch(/Credentials:/i);
    expect(output).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("checks credentials in the configurer's resolved Pi home", async () => {
    const configuredPiHome = join(SCOPED_PI_HOME, "configured-agent");
    await mkdir(configuredPiHome, { recursive: true });
    await Bun.write(join(configuredPiHome, "auth.json"), "{}");
    const pi = new PiProviderConfigurer({
      piHome: configuredPiHome,
      runSmokeLoad: async () => ({ exitCode: 0, stderr: "" }),
    });

    const hasIssues = logProviderStatus(pi, true, OK_STATUS, true);

    const output = captured.join("\n");
    expect(hasIssues).toBe(false);
    expect(output).toMatch(/Credentials:.*yes/i);
    expect(output).not.toMatch(/no credentials found/i);
  });
});

describe("logProviderStatus — provider health checks", () => {
  test("reports health hook failures as provider issues instead of throwing", () => {
    const provider = createProvider({
      checkHealth: () => {
        throw new Error("credential probe crashed");
      },
    });

    const hasIssues = logProviderStatus(provider, true, OK_STATUS, true);

    const output = captured.join("\n");
    expect(hasIssues).toBe(true);
    expect(output).toMatch(/Health:.*credential probe crashed/);
  });
});
