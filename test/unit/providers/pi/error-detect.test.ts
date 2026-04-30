import { describe, expect, test } from "bun:test";
import { detectProviderError } from "../../../../src/providers/pi/error-detect";

// Pi exits 0 even when the provider returns 4xx/5xx (Exp 43). Both runPi and
// callPiCLI scan stdout for the error shape; this helper is the single
// source of truth for that detection.

describe("detectProviderError", () => {
  test("returns null for ordinary model output", () => {
    expect(detectProviderError("Hello, world.\nDONE\n")).toBeNull();
  });

  test("detects an Anthropic-style 401 error in stdout (Exp 43 probe5)", () => {
    const stdout = `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`;
    expect(detectProviderError(stdout)).toEqual({ code: 401, body: stdout });
  });

  test("detects an openai-codex-style 400 detail error in stdout (Exp 43)", () => {
    const stdout = `400 {"detail":"The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account."}`;
    expect(detectProviderError(stdout)).toEqual({ code: 400, body: stdout });
  });

  test("ignores leading model output and finds an error on a later line", () => {
    const stdout = `Some preamble\n401 {"type":"error","error":{"message":"bad key"}}\n`;
    const result = detectProviderError(stdout);
    expect(result?.code).toBe(401);
  });

  test("ignores 2xx/3xx lines that happen to look like the error shape", () => {
    // The original `\d{3}` matched ANY three-digit prefix. A model that
    // narrates "200 {\"type\":\"...\"}" or "302 {\"detail\":\"...\"}" inside
    // its own answer would be misclassified as a provider failure. Constrain
    // detection to actual 4xx/5xx error classes.
    const success = `200 {"type":"ok","detail":"all good"}`;
    expect(detectProviderError(success)).toBeNull();
    const redirect = `302 {"detail":"moved permanently"}`;
    expect(detectProviderError(redirect)).toBeNull();
    const informational = `100 {"type":"continue"}`;
    expect(detectProviderError(informational)).toBeNull();
  });

  test("detects 5xx server errors (not just 4xx)", () => {
    // Pi has only emitted 4xx in practice (Exp 43), but the contract is
    // "any provider error class" — 503/504/etc. should still surface.
    const stdout = `503 {"type":"error","error":{"message":"service unavailable"}}`;
    expect(detectProviderError(stdout)?.code).toBe(503);
  });
});
