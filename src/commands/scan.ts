/**
 * CLI handler for `shaka scan <file|--dir|--stdin>`.
 * Scans prose content for AI writing patterns (slop).
 */

import { Command } from "commander";
import { PASS_THRESHOLD, type ScanResult, formatResult, scanContent } from "../domain/slop-scanner";

async function scanFile(filepath: string, paragraphMode: boolean): Promise<ScanResult> {
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    console.error(`Error: File not found: ${filepath}`);
    process.exit(1);
  }
  const content = await file.text();
  return scanContent(content, filepath, { includeParagraphs: paragraphMode });
}

async function scanDirectory(dirpath: string, paragraphMode: boolean): Promise<ScanResult[]> {
  const dir = Bun.file(dirpath);
  if (!(await dir.exists())) {
    console.error(`Error: Directory not found: ${dirpath}`);
    process.exit(1);
  }

  const glob = new Bun.Glob("*.md");
  const results: ScanResult[] = [];

  for await (const filename of glob.scan({ cwd: dirpath })) {
    const filepath = `${dirpath}/${filename}`;
    const content = await Bun.file(filepath).text();
    results.push(scanContent(content, filepath, { includeParagraphs: paragraphMode }));
  }

  if (results.length === 0) {
    console.error(`Error: No Markdown files found in ${dirpath}`);
    process.exit(1);
  }

  return results;
}

async function scanStdin(paragraphMode: boolean): Promise<ScanResult> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const content = new TextDecoder().decode(Buffer.concat(chunks));
  return scanContent(content, "stdin", { includeParagraphs: paragraphMode });
}

function printAggregate(results: ScanResult[]): void {
  const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);
  const passingFiles = results.filter((r) => r.passesReview).length;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgDensity = results.reduce((sum, r) => sum + r.slopDensity, 0) / results.length;

  console.log(`\n${"=".repeat(60)}`);
  console.log("AGGREGATE SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`Files scanned: ${results.length}`);
  console.log(`Files passing (${PASS_THRESHOLD}+): ${passingFiles}/${results.length}`);
  console.log(`Average score: ${avgScore.toFixed(1)}/100`);
  console.log(`Average slop density: ${avgDensity.toFixed(2)}/100 words`);
  console.log(`Total violations: ${totalViolations}`);
}

export function createScanCommand(): Command {
  return new Command("scan")
    .description("Scan prose content for AI writing patterns (slop)")
    .argument("[file]", "File to scan")
    .option("--dir <path>", "Scan all .md files in directory")
    .option("--stdin", "Read content from stdin")
    .option("--json", "Output as JSON")
    .option("--summary", "Summary only (no violation details)")
    .option("-p, --paragraph", "Show per-paragraph breakdown")
    .action(async (file, options) => {
      let results: ScanResult[] = [];

      if (options.stdin) {
        results.push(await scanStdin(options.paragraph));
      } else if (options.dir) {
        results = await scanDirectory(options.dir, options.paragraph);
      } else if (file) {
        results.push(await scanFile(file, options.paragraph));
      } else {
        console.error("Error: No input specified. Use --help for usage.");
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const result of results) {
          console.log(formatResult(result, !options.summary));
        }
        if (results.length > 1) {
          printAggregate(results);
        }
      }

      const anyFailed = results.some((r) => !r.passesReview);
      process.exit(anyFailed ? 1 : 0);
    });
}
