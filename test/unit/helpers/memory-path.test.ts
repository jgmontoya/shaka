import { describe, expect, test } from "bun:test";
import { dirname, isAbsolute, normalize, parse, resolve } from "node:path";
import { testCwd, testCwdInput, testCwds } from "../../helpers/memory-path";

describe("testCwd", () => {
  test("builds canonical native paths while preserving the logical hierarchy", () => {
    const parent = testCwd("/company/project");
    const child = testCwd("/company/project/repository");

    expect(isAbsolute(parent)).toBe(true);
    expect(normalize(parent)).toBe(parent);
    expect(dirname(child)).toBe(parent);
  });

  test("maps the logical root to the current filesystem root", () => {
    expect(testCwd("/")).toBe(parse(process.cwd()).root);
  });

  test("builds ordered path collections", () => {
    expect(testCwds("/company/a", "/company/b")).toEqual([
      testCwd("/company/a"),
      testCwd("/company/b"),
    ]);
  });

  test("can preserve non-canonical input for normalization tests", () => {
    expect(testCwdInput("/company/../project/")).not.toBe(testCwd("/project"));
    expect(resolve(testCwdInput("/company/../project/"))).toBe(testCwd("/project"));
  });
});
