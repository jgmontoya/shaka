import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCANNER_PATH = join(import.meta.dir, "../../../defaults/system/skills/AntiSlop/Tools/anti-slop-scanner.ts");

describe("anti-slop-scanner", () => {
  const testDir = join(tmpdir(), `shaka-test-antislop-${process.pid}`);

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("clean text passes with score 100", async () => {
    const cleanFile = join(testDir, "clean.md");
    await Bun.write(
      cleanFile,
      "Request processing happens in three stages, each handling one responsibility. " +
        "Validation comes first, checking input against the schema before anything else runs. " +
        "A transformation step converts the validated data into the internal format that downstream " +
        "consumers expect. Finally, the persistence layer writes results to the database. " +
        "Error handling wraps each stage independently, so a validation failure returns " +
        "a structured error with the field name and the constraint that was violated.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", cleanFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);
    expect(results[0].passesReview).toBe(true);
    expect(results[0].violations).toHaveLength(0);
  });

  test("detects banned words and deducts points", async () => {
    const slopFile = join(testDir, "slop.md");
    await Bun.write(
      slopFile,
      "We need to leverage robust solutions to navigate the complex landscape of modern development.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", slopFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeLessThan(100);
    expect(results[0].passesReview).toBe(false);

    const bannedWords = results[0].violations.filter(
      (v: { type: string }) => v.type === "banned_word",
    );
    expect(bannedWords.length).toBeGreaterThanOrEqual(3); // leverage, robust, landscape at minimum
  });

  test("detects cardinal sins (comparison structures)", async () => {
    const sinFile = join(testDir, "sin.md");
    await Bun.write(
      sinFile,
      "This approach works by focusing on outcomes rather than processes. " +
        "The system is not just fast, it's also reliable.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", sinFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const cardinalSins = results[0].violations.filter(
      (v: { type: string }) => v.type === "cardinal_sin",
    );
    expect(cardinalSins.length).toBeGreaterThanOrEqual(1);
    // Cardinal sins cost -20 each
    expect(results[0].score).toBeLessThanOrEqual(80);
  });

  test("detects banned constructions", async () => {
    const constructionFile = join(testDir, "construction.md");
    await Bun.write(
      constructionFile,
      "It's worth noting that the system handles errors gracefully. " +
        "At its core, the architecture prioritizes reliability. " +
        "The bottom line is that performance matters.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", constructionFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const constructions = results[0].violations.filter(
      (v: { type: string }) => v.type === "banned_construction",
    );
    expect(constructions.length).toBeGreaterThanOrEqual(3);
  });

  test("detects hedging patterns", async () => {
    const hedgeFile = join(testDir, "hedge.md");
    await Bun.write(
      hedgeFile,
      "Perhaps the best approach is to refactor the module. " +
        "It could be argued that performance matters more. " +
        "Some might argue that testing is optional. " +
        "One might think the system is stable enough already.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", hedgeFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const hedging = results[0].violations.filter(
      (v: { type: string }) => v.type === "hedging",
    );
    expect(hedging.length).toBeGreaterThanOrEqual(3);
  });

  test("detects AI tells (copula avoidance, vague attribution)", async () => {
    const tellFile = join(testDir, "tell.md");
    await Bun.write(
      tellFile,
      "The framework serves as a bridge between the old and new systems. " +
        "Experts say this approach is industry standard. " +
        "Studies show that testing reduces bugs by half.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", tellFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const aiTells = results[0].violations.filter(
      (v: { type: string }) => v.type === "ai_tell",
    );
    expect(aiTells.length).toBeGreaterThanOrEqual(2);
  });

  test("detects em dash violations", async () => {
    const dashFile = join(testDir, "dash.md");
    await Bun.write(
      dashFile,
      "The system -- as we will see -- handles errors gracefully. " +
        "Performance is good \u2014 but could be better.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", dashFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const dashes = results[0].violations.filter(
      (v: { type: string }) => v.type === "dash",
    );
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  test("provides qualitative scores for substantial content", async () => {
    // 200+ words of varied prose
    const proseFile = join(testDir, "prose.md");
    await Bun.write(
      proseFile,
      `Garbage collection in Go uses a concurrent, tri-color mark-and-sweep algorithm. That sentence is accurate but tells you nothing about why the design was chosen. Every garbage collector trades throughput for latency. Go chose low latency because its target workload is network servers, where tail latency matters more than raw throughput.

The collector runs concurrently with application goroutines. It does not stop the world for the entire collection cycle. Instead, it uses write barriers to track pointer mutations while the marker runs. The pause happens only during the initial stack scan and the final termination check. Both pauses are measured in microseconds, not milliseconds.

Memory allocation in Go uses a thread-local cache called mcache. Each processor gets its own mcache, so most allocations require no locking. When the mcache runs dry, it refills from a shared mcentral. The mcentral itself pulls from a global mheap that maps virtual memory from the operating system.

The GOGC environment variable controls collection frequency. Setting GOGC=100 means the collector triggers when heap size doubles since the last collection. Lower values collect more often, consuming more CPU but using less memory. Higher values collect less often, using more memory but freeing the CPU for application work.`,
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", proseFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results[0].qualitative).toBeDefined();
    expect(results[0].qualitative.directness).toBeGreaterThanOrEqual(1);
    expect(results[0].qualitative.rhythm).toBeGreaterThanOrEqual(1);
    expect(results[0].qualitative.trust).toBeGreaterThanOrEqual(1);
    expect(results[0].qualitative.density).toBeGreaterThanOrEqual(1);
    expect(results[0].qualitative.total).toBeGreaterThanOrEqual(4);
    expect(results[0].qualitative.maxTotal).toBe(40);
  });

  test("scans directory of files", async () => {
    await Bun.write(join(testDir, "file1.md"), "Clean text with no issues here.");
    await Bun.write(join(testDir, "file2.md"), "We must leverage robust solutions.");
    await Bun.write(join(testDir, "not-md.txt"), "This should be skipped.");

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", "--dir", testDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results).toHaveLength(2); // only .md files
  });

  test("handles stdin input", async () => {
    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", "--stdin"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write("The system uses strong encryption for all data at rest.");
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("stdin");
  });

  test("paragraph mode provides per-paragraph breakdown", async () => {
    const paraFile = join(testDir, "paragraphs.md");
    await Bun.write(
      paraFile,
      "The first paragraph is clean and simple.\n\n" +
        "The second paragraph contains a robust and seamless approach to the problem.\n\n" +
        "The third paragraph is direct and clear.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", "--paragraph", paraFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    expect(results[0].paragraphScores).toBeDefined();
    expect(results[0].paragraphScores.length).toBeGreaterThanOrEqual(2);
  });

  test("exits with code 1 when content fails", async () => {
    const failFile = join(testDir, "fail.md");
    await Bun.write(
      failFile,
      "In today's rapidly evolving digital landscape, we must leverage robust and seamless solutions " +
        "that utilize cutting-edge innovation. Furthermore, it's crucial to navigate the complex ecosystem " +
        "of stakeholder needs. The paradigm shift underscores the importance of holistic approaches. " +
        "Moreover, we must foster synergy rather than working in silos.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", failFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
  });

  test("exits with code 0 when content passes", async () => {
    const passFile = join(testDir, "pass.md");
    await Bun.write(
      passFile,
      "The system processes HTTP requests through three middleware layers. " +
        "Authentication happens first. Then validation. Then the handler runs. " +
        "Each layer can reject the request with a typed error. " +
        "The error includes the layer name and the specific check that failed.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", passFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
  });

  test("detects smart/curly quotes", async () => {
    const quoteFile = join(testDir, "quotes.md");
    await Bun.write(
      quoteFile,
      "The system is \u201Cfast\u201D and \u2018reliable\u2019.",
    );

    const proc = Bun.spawn(["bun", SCANNER_PATH, "--json", quoteFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const results = JSON.parse(output);
    const smartQuotes = results[0].violations.filter(
      (v: { text: string }) => v.text === "Smart/curly quote detected",
    );
    expect(smartQuotes.length).toBeGreaterThanOrEqual(2);
  });

  test("shows help text", async () => {
    const proc = Bun.spawn(["bun", SCANNER_PATH, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    expect(output).toContain("anti-slop-scanner");
    expect(output).toContain("Pass threshold: 95/100");
  });
});
