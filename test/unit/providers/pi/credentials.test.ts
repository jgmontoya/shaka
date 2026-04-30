import { describe, expect, test } from "bun:test";
import { checkPiCredentials } from "../../../../src/providers/pi/credentials";

// Pi authenticates via three paths — `pi /login` writes ~/.pi/agent/auth.json,
// or the user sets ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN. Doctor surfaces
// a warning only when ALL three are absent (silent failure trap from Exp 43:
// headless Pi with no creds fails confusingly).

describe("checkPiCredentials", () => {
  test("ok when ANTHROPIC_API_KEY is set", () => {
    expect(
      checkPiCredentials({
        env: { ANTHROPIC_API_KEY: "sk-ant-xxx" },
        hasAuthFile: false,
      }),
    ).toEqual({ ok: true });
  });

  test("ok when ANTHROPIC_OAUTH_TOKEN is set", () => {
    expect(
      checkPiCredentials({
        env: { ANTHROPIC_OAUTH_TOKEN: "tok-xxx" },
        hasAuthFile: false,
      }),
    ).toEqual({ ok: true });
  });

  test("ok when ~/.pi/agent/auth.json exists (user ran `pi /login`)", () => {
    expect(
      checkPiCredentials({
        env: {},
        hasAuthFile: true,
      }),
    ).toEqual({ ok: true });
  });

  test("not ok with an actionable issue when nothing is set", () => {
    const result = checkPiCredentials({ env: {}, hasAuthFile: false });
    expect(result.ok).toBe(false);
    expect(result.issue).toContain("ANTHROPIC_API_KEY");
    expect(result.issue).toContain("/login");
  });

  test("treats empty-string env vars as absent", () => {
    const result = checkPiCredentials({
      env: { ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" },
      hasAuthFile: false,
    });
    expect(result.ok).toBe(false);
  });

  test("treats whitespace-only env vars as absent", () => {
    // A common shell mistake — `export ANTHROPIC_API_KEY=" "` from a stripped
    // copy-paste — would otherwise pass the truthy check and produce a false
    // "credentials found" in doctor output.
    const result = checkPiCredentials({
      env: { ANTHROPIC_API_KEY: "   ", ANTHROPIC_OAUTH_TOKEN: "\t\n" },
      hasAuthFile: false,
    });
    expect(result.ok).toBe(false);
  });
});
