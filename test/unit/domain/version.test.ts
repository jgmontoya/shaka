import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  getCurrentVersion,
  isMajorUpgrade,
  parseSemver,
} from "../../../src/domain/version";

describe("parseSemver", () => {
  test("parses valid semver", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseSemver("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  test("returns null for invalid input", () => {
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("abc")).toBeNull();
  });
});

describe("isMajorUpgrade", () => {
  test("detects major version change", () => {
    expect(isMajorUpgrade("0.1.0", "1.0.0")).toBe(true);
    expect(isMajorUpgrade("1.9.9", "2.0.0")).toBe(true);
  });

  test("returns false for minor/patch changes", () => {
    expect(isMajorUpgrade("1.0.0", "1.1.0")).toBe(false);
    expect(isMajorUpgrade("1.0.0", "1.0.1")).toBe(false);
    expect(isMajorUpgrade("0.1.0", "0.2.0")).toBe(false);
  });

  test("returns false for same version", () => {
    expect(isMajorUpgrade("1.0.0", "1.0.0")).toBe(false);
  });

  test("returns false for downgrade", () => {
    expect(isMajorUpgrade("2.0.0", "1.0.0")).toBe(false);
  });

  test("returns false for invalid versions", () => {
    expect(isMajorUpgrade("bad", "1.0.0")).toBe(false);
    expect(isMajorUpgrade("1.0.0", "bad")).toBe(false);
  });
});

describe("compareSemver", () => {
  test("returns -1 when a < b", () => {
    expect(compareSemver("0.1.0", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
    expect(compareSemver("1.1.0", "1.1.1")).toBe(-1);
  });

  test("returns 1 when a > b", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
    expect(compareSemver("1.2.0", "1.1.0")).toBe(1);
    expect(compareSemver("1.1.2", "1.1.1")).toBe(1);
  });

  test("returns 0 when equal", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  test("returns 0 for invalid input", () => {
    expect(compareSemver("bad", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "bad")).toBe(0);
  });
});

describe("getCurrentVersion", () => {
  test("returns version from package.json", () => {
    const version = getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe("0.4.1");
  });
});
