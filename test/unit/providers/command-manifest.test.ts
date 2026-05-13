import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest } from "../../../src/providers/command-manifest";

describe("command-manifest", () => {
  const testHome = join(tmpdir(), `shaka-test-manifest-${process.pid}`);

  beforeEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    await mkdir(testHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  test("returns empty manifest when file does not exist", async () => {
    const manifest = await readManifest(testHome);
    expect(manifest).toEqual({ global: [], scoped: {} });
  });

  test("reads existing manifest", async () => {
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: ["commit", "review-pr"] }),
    );

    const manifest = await readManifest(testHome);
    expect(manifest.global).toEqual(["commit", "review-pr"]);
  });

  test("write and read roundtrip", async () => {
    const manifest = { global: ["commit", "deploy"], scoped: {} };
    await writeManifest(testHome, manifest);

    const read = await readManifest(testHome);
    expect(read).toEqual(manifest);
  });

  test("overwrites existing manifest", async () => {
    await writeManifest(testHome, { global: ["old"], scoped: {} });
    await writeManifest(testHome, { global: ["new"], scoped: {} });

    const read = await readManifest(testHome);
    expect(read.global).toEqual(["new"]);
  });

  test("returns empty scoped when file does not exist", async () => {
    const manifest = await readManifest(testHome);
    expect(manifest.scoped).toEqual({});
  });

  test("stores and reads scoped paths with resolved paths", async () => {
    const manifest = {
      global: ["commit"],
      scoped: {
        "/Users/j/Projects/app": ["deploy"],
        "/Users/j/Projects/api": ["integration-tests", "deploy"],
      },
    };
    await writeManifest(testHome, manifest);

    const read = await readManifest(testHome);
    expect(read.scoped).toEqual(manifest.scoped);
  });

  test("reads legacy manifest without scoped field", async () => {
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: ["commit"] }),
    );

    const manifest = await readManifest(testHome);
    expect(manifest.global).toEqual(["commit"]);
    expect(manifest.scoped).toEqual({});
  });

  test("rejects invalid command names in a manifest", async () => {
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: ["../escape"], scoped: {} }),
    );

    await expect(readManifest(testHome)).rejects.toThrow("Invalid command manifest");
  });

  test("rejects a non-array global field in a manifest", async () => {
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: "commit", scoped: {} }),
    );

    await expect(readManifest(testHome)).rejects.toThrow(
      "Invalid command manifest global: expected array",
    );
  });

  test("rejects a non-array scoped field in a manifest", async () => {
    await Bun.write(
      join(testHome, "commands-manifest.json"),
      JSON.stringify({ global: [], scoped: { "/tmp/app": "deploy" } }),
    );

    await expect(readManifest(testHome)).rejects.toThrow(
      'Invalid command manifest scoped["/tmp/app"]: expected array',
    );
  });
});
