import { describe, expect, test } from "bun:test";
import { renderStatus, shouldRenderWidget } from "../../../src/services/autoresearch-widget";

describe("renderStatus", () => {
  test("shows iter / kept / discarded and baseline→best with current metric", () => {
    const out = renderStatus({
      iter: 5,
      kept: 2,
      discarded: 3,
      baseline: 100,
      best: 42.5,
      currentMetric: 38.2,
    });
    expect(out).toContain("iter 5");
    expect(out).toContain("kept 2");
    expect(out).toContain("disc 3");
    expect(out).toContain("100");
    expect(out).toContain("42.5");
    expect(out).toContain("38.2");
  });

  test("renders a single line — no newlines inside", () => {
    const out = renderStatus({
      iter: 1,
      kept: 0,
      discarded: 0,
      baseline: 1,
      best: 1,
      currentMetric: 1,
    });
    expect(out).not.toContain("\n");
  });

  test("is deterministic across equal inputs (pure function)", () => {
    const state = {
      iter: 7,
      kept: 1,
      discarded: 6,
      baseline: 50,
      best: 25,
      currentMetric: 30,
    };
    expect(renderStatus(state)).toBe(renderStatus(state));
  });

  // Defensive: the type says `number` but before the first benchmark completes,
  // runtime drift could put NaN into baseline/best/currentMetric. Rendering
  // "best NaN (base NaN)" would be embarrassing. Use a sentinel instead.
  test("renders a sentinel for non-finite metric values", () => {
    const out = renderStatus({
      iter: 0,
      kept: 0,
      discarded: 0,
      baseline: Number.NaN,
      best: Number.POSITIVE_INFINITY,
      currentMetric: Number.NEGATIVE_INFINITY,
    });
    expect(out).toContain("best — (base —) | cur —");
  });
});

describe("shouldRenderWidget", () => {
  test("true for a real TTY with a non-dumb TERM", () => {
    expect(shouldRenderWidget({ isTTY: true, term: "xterm-256color" })).toBe(true);
  });

  test("false when stdout is not a TTY (piped or redirected)", () => {
    expect(shouldRenderWidget({ isTTY: false, term: "xterm-256color" })).toBe(false);
  });

  test("false when TERM=dumb (CI environments that pass TTY but strip ANSI)", () => {
    expect(shouldRenderWidget({ isTTY: true, term: "dumb" })).toBe(false);
  });

  test("tolerates missing TERM (treated as unknown, not dumb)", () => {
    expect(shouldRenderWidget({ isTTY: true, term: undefined })).toBe(true);
  });
});
