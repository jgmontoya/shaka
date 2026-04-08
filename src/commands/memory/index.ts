/**
 * CLI handler for `shaka memory` command.
 * Subcommands: search, list, consolidate, review, compile.
 */

import { join } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../../domain/config";
import { type LearningEntry, loadLearnings } from "../../memory/learnings";
import { type SearchFilter, searchMemory } from "../../memory/search";
import { type SummaryIndex, listSummaries } from "../../memory/storage";
import { runCompile } from "./compile";
import { runConsolidation } from "./consolidate";
import { runReview } from "./review";

function resolveMemoryDir(): string {
  const shakaHome = resolveShakaHome({
    SHAKA_HOME: process.env.SHAKA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  });
  return join(shakaHome, "memory");
}

export function createMemoryCommand(): Command {
  const memory = new Command("memory").description("Search and browse session memory");

  memory
    .command("search <query>")
    .description("Search session summaries and learnings for a query")
    .option(
      "--category <category>",
      "Filter learnings by category (correction/preference/pattern/fact)",
    )
    .option("--cwd <path>", "Filter by working directory (substring match)")
    .option("--type <type>", "Filter by result type (session/learning)")
    .action(async (query: string, options: { category?: string; cwd?: string; type?: string }) => {
      const memoryDir = resolveMemoryDir();

      const filter: SearchFilter | undefined =
        options.category || options.cwd || options.type
          ? {
              category: options.category,
              cwd: options.cwd,
              type: options.type as "session" | "learning" | undefined,
            }
          : undefined;

      const results = await searchMemory(query, memoryDir, filter);

      if (results.length === 0) {
        console.log(`No results for "${query}"`);
        return;
      }

      console.log(
        `Found ${results.length} result${results.length > 1 ? "s" : ""} for "${query}":\n`,
      );

      for (const result of results) {
        const typeLabel = result.type === "learning" ? "[learning]" : "[session]";
        console.log(`  ${result.date}  ${typeLabel} ${result.title}`);
        if (result.tags.length > 0) {
          console.log(`           tags: ${result.tags.join(", ")}`);
        }
        console.log(`           ${result.snippet}`);
        console.log();
      }
    });

  memory
    .command("list")
    .description("List recent session summaries")
    .option("-n, --limit <count>", "Number of summaries to show", "10")
    .action(async (options: { limit: string }) => {
      const memoryDir = resolveMemoryDir();

      const summaries = await listSummaries(memoryDir);

      if (summaries.length === 0) {
        console.log("No session summaries found.");
        return;
      }

      const parsed = Number.parseInt(options.limit, 10);
      const limit = Math.min(parsed > 0 ? parsed : 10, summaries.length);
      const shown = summaries.slice(0, limit);

      console.log(
        `${summaries.length} session${summaries.length > 1 ? "s" : ""} total, showing ${shown.length}:\n`,
      );

      for (const s of shown) {
        console.log(`  ${s.date}  ${s.title}`);
        if (s.tags.length > 0) {
          console.log(`           tags: ${s.tags.join(", ")}`);
        }
        console.log(`           ${s.provider} | ${s.cwd}`);
        console.log();
      }
    });

  memory
    .command("consolidate")
    .description("Consolidate learnings: merge duplicates, resolve contradictions")
    .action(async () => {
      const memoryDir = resolveMemoryDir();
      await runConsolidation(memoryDir);
    });

  memory
    .command("review")
    .description("Interactively review, filter, and delete learnings")
    .option("--prune", "AI-assisted quality assessment: flag low-quality entries for review")
    .option("--filter <text>", "Pre-filter learnings by text (matches CWDs, titles, body)")
    .action(async (options: { prune?: boolean; filter?: string }) => {
      const memoryDir = resolveMemoryDir();
      await runReview(memoryDir, options);
    });

  memory
    .command("compile")
    .description("Compile knowledge from session summaries into topic pages")
    .option("--bootstrap", "Retroactively extract knowledge from historical sessions")
    .option("--dry-run", "Show what would be processed without making changes")
    .option("--batch-size <n>", "Sessions per LLM call (default 5)")
    .option("--limit <n>", "Max sessions to process")
    .action(
      async (options: {
        bootstrap?: boolean;
        dryRun?: boolean;
        batchSize?: string;
        limit?: string;
      }) => {
        const memoryDir = resolveMemoryDir();
        const cwd = process.cwd();
        await runCompile(memoryDir, cwd, options);
      },
    );

  memory
    .command("stats")
    .description("Show memory system health at a glance")
    .action(async () => {
      const memoryDir = resolveMemoryDir();
      const [learnings, summaries] = await Promise.all([
        loadLearnings(memoryDir),
        listSummaries(memoryDir),
      ]);
      printLearningsStats(learnings);
      printSessionsStats(summaries);
    });

  return memory;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>, sep = "  |  "): string {
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(sep);
}

function printLearningsStats(learnings: LearningEntry[]): void {
  console.log(`Learnings: ${learnings.length} total`);
  if (learnings.length === 0) return;

  const cats = countBy(learnings, (e) => e.category);
  const globalCount = learnings.filter((e) => e.cwds.includes("*")).length;

  console.log(`  ${formatCounts(cats)}`);
  console.log(`  global: ${globalCount}  |  project-scoped: ${learnings.length - globalCount}`);

  const cwdFreq = countBy(
    learnings.flatMap((e) => e.cwds.filter((c) => c !== "*")),
    (c) => c,
  );
  const topCwds = Object.entries(cwdFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([path, count]) => `${path} (${count})`)
    .join(", ");
  if (topCwds) console.log(`  top CWDs: ${topCwds}`);

  const lastExtraction = learnings.reduce((latest, e) => {
    const last = e.exposures[e.exposures.length - 1];
    return last && last.date > latest ? last.date : latest;
  }, "");
  if (lastExtraction) console.log(`\nLast extraction: ${lastExtraction}`);
}

function printSessionsStats(summaries: SummaryIndex[]): void {
  console.log(`\nSessions: ${summaries.length} summaries`);
  if (summaries.length === 0) return;

  const dates = summaries.map((s) => s.date).sort();
  console.log(`  date range: ${dates[0]} — ${dates[dates.length - 1]}`);

  const providers = countBy(summaries, (s) => s.provider);
  const provLine = Object.entries(providers)
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  console.log(`  providers: ${provLine}`);
}

export function promptUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("y");

  return new Promise((resolve) => {
    process.stdout.write(question);
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(data.trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
