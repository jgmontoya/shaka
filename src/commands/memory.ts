/**
 * CLI handler for `shaka memory` command.
 * Search, list, and consolidate session memory and learnings.
 */

import { join } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import { inference } from "../inference";
import {
  type LearningEntry,
  applyDuplicateMerges,
  buildContradictionPrompt,
  buildDuplicatePrompt,
  findPromotionCandidates,
  loadLearnings,
  markNonglobal,
  parseContradictionOutput,
  parseDuplicateOutput,
  promoteToGlobal,
  renderEntry,
  renderLearnings,
  resolveContradictions,
  writeLearnings,
} from "../memory/learnings";
import { searchMemory } from "../memory/search";
import { listSummaries } from "../memory/storage";

const CONSOLIDATION_THRESHOLD = 20;

function resolveMemoryDir(): string {
  const shakaHome = resolveShakaHome({
    SHAKA_HOME: process.env.SHAKA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  });
  return join(shakaHome, "memory");
}

/**
 * Creates the `shaka memory` command with subcommands: search, list, consolidate.
 *
 * The `consolidate` subcommand merges duplicates, resolves contradictions, and
 * auto-promotes learnings seen across 3+ CWDs to global scope (cwd: *) in
 * non-TTY environments. In a TTY, promotion is interactive (Y/n per candidate).
 */
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

      const limit = Math.min(Number.parseInt(options.limit, 10) || 10, summaries.length);
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

  return memory;
}

async function runConsolidation(memoryDir: string): Promise<void> {
  let entries = await loadLearnings(memoryDir);

  if (entries.length < CONSOLIDATION_THRESHOLD) {
    console.log(
      `learnings.md has ${entries.length} entries. No consolidation needed (threshold: ${CONSOLIDATION_THRESHOLD}).`,
    );
    return;
  }

  const originalCount = entries.length;
  const content = renderLearnings(entries);
  console.log(
    `learnings.md has ${originalCount} entries (${content.length} chars). Consolidating...`,
  );

  // Backup before any changes
  const backupPath = join(memoryDir, "learnings.backup.md");
  await Bun.write(backupPath, content);
  console.log(`Backup written to ${backupPath}`);

  // Pass 1: Duplicate detection
  console.log("\n--- Pass 1: Duplicate detection ---");
  entries = await deduplicateEntries(entries);

  // Pass 2: Contradiction detection
  console.log("\n--- Pass 2: Contradiction detection ---");
  entries = await resolveEntryContradictions(entries);

  // Interactive: CWD-to-global promotion
  entries = await promptForPromotions(entries);

  // Write final result
  await writeLearnings(memoryDir, entries);
  console.log(`\nDone. ${originalCount} -> ${entries.length} entries.`);
}

async function deduplicateEntries(entries: LearningEntry[]): Promise<LearningEntry[]> {
  const prompt = buildDuplicatePrompt(entries);
  const result = await inference({ userPrompt: prompt, timeout: 30000 });

  if (!result.success || !result.text) {
    console.log("Duplicate detection inference failed. Skipping.");
    return entries;
  }

  const groups = parseDuplicateOutput(result.text);
  if (groups.length === 0) {
    console.log("No duplicates found.");
    return entries;
  }

  const merged = applyDuplicateMerges(entries, groups);
  console.log(`Merged ${groups.length} duplicate group(s). Reduced to ${merged.length} entries.`);
  return merged;
}

async function resolveEntryContradictions(entries: LearningEntry[]): Promise<LearningEntry[]> {
  const prompt = buildContradictionPrompt(entries);
  const result = await inference({ userPrompt: prompt, timeout: 30000 });

  if (!result.success || !result.text) {
    console.log("Contradiction detection inference failed. Skipping.");
    return entries;
  }

  const pairs = parseContradictionOutput(result.text);
  if (pairs.length === 0) {
    console.log("No contradictions found.");
    return entries;
  }

  const resolved = resolveContradictions(entries, pairs);
  const removedCount = entries.length - resolved.length;
  console.log(
    `Resolved ${pairs.length} contradiction(s)${removedCount > 0 ? ` (${removedCount} entries removed)` : ""}.`,
  );
  return resolved;
}

async function promptForPromotions(entries: LearningEntry[]): Promise<LearningEntry[]> {
  const candidates = findPromotionCandidates(entries);
  if (candidates.length === 0) return entries;

  console.log("\n--- Interactive: CWD-to-global promotion ---");

  const result = [...entries];

  for (const candidate of candidates) {
    const idx = result.findIndex((e) => e === candidate);
    if (idx === -1) continue;

    console.log(`\n  ${renderEntry(candidate).split("\n").slice(0, 4).join("\n  ")}`);
    console.log(`  CWDs: ${candidate.cwds.join(", ")}`);

    const answer = await promptUser("Promote to global (cwd: *)? [Y/n] ");
    const decline = answer.trim().toLowerCase() === "n";

    result[idx] = decline ? markNonglobal(candidate) : promoteToGlobal(candidate);

    if (decline) {
      console.log("  Marked as nonglobal (won't be prompted again).");
    } else {
      console.log("  Promoted to cwd: *");
    }
  }

  return result;
}

function promptUser(question: string): Promise<string> {
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
