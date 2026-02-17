/**
 * CLI handler for `shaka memory` command.
 * Subcommands: search, list, consolidate, review.
 */

import { join } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../../domain/config";
import { searchMemory } from "../../memory/search";
import { listSummaries } from "../../memory/storage";
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
    .action(async (query: string) => {
      const memoryDir = resolveMemoryDir();

      const results = await searchMemory(query, memoryDir);

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

  return memory;
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
