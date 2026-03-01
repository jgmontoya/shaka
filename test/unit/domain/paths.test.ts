import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde, normalizeCwd } from "../../../src/domain/paths";

describe("expandTilde", () => {
  test("bare ~ → homedir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  test("~/path → homedir/path", () => {
    expect(expandTilde("~/Projects/app")).toBe(join(homedir(), "Projects", "app"));
  });

  test("absolute path passed through", () => {
    expect(expandTilde("/opt/my-app")).toBe("/opt/my-app");
  });

  test("relative path passed through", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  test("~user not expanded (only ~/)", () => {
    expect(expandTilde("~user/foo")).toBe("~user/foo");
  });
});

describe("normalizeCwd", () => {
  test("undefined → undefined", () => {
    expect(normalizeCwd(undefined)).toBeUndefined();
  });

  test("null → undefined", () => {
    expect(normalizeCwd(null)).toBeUndefined();
  });

  test('"*" → undefined', () => {
    expect(normalizeCwd("*")).toBeUndefined();
  });

  test("string → [resolved]", () => {
    const result = normalizeCwd("~/Projects");
    expect(result).toBeArrayOfSize(1);
    expect(result![0]).toBe(join(homedir(), "Projects"));
  });

  test("absolute string → [string]", () => {
    expect(normalizeCwd("/opt/app")).toEqual(["/opt/app"]);
  });

  test("string[] → [resolved...]", () => {
    const result = normalizeCwd(["~/a", "~/b"]);
    expect(result).toBeArrayOfSize(2);
    expect(result![0]).toBe(join(homedir(), "a"));
    expect(result![1]).toBe(join(homedir(), "b"));
  });

  test('["*"] → undefined', () => {
    expect(normalizeCwd(["*"])).toBeUndefined();
  });

  test("mixed array filters non-strings and *", () => {
    const result = normalizeCwd(["~/a", "*", 42, "~/b"]);
    expect(result).toEqual([join(homedir(), "a"), join(homedir(), "b")]);
  });

  test("number → undefined", () => {
    expect(normalizeCwd(42)).toBeUndefined();
  });

  test("boolean → undefined", () => {
    expect(normalizeCwd(true)).toBeUndefined();
  });
});
