/**
 * Interactive consolidation for `shaka memory consolidate`.
 *
 * Delegates all consolidation passes to `../../memory/consolidation`,
 * then handles interactive promotion prompts and user-facing output.
 */

import { join } from "node:path";
import { runFullConsolidation } from "../../memory/consolidation";
import {
  type LearningEntry,
  appendToArchive,
  findPromotionCandidates,
  loadLearnings,
  markNonglobal,
  promoteToGlobal,
  renderEntry,
  renderLearnings,
  writeLearnings,
} from "../../memory/learnings";
import { promptUser } from "./index";

export async function runConsolidation(memoryDir: string): Promise<void> {
  let entries = await loadLearnings(memoryDir);
  const originalCount = entries.length;
  const content = renderLearnings(entries);

  console.log(
    `learnings.md has ${originalCount} entries (${content.length} chars). Consolidating...`,
  );

  // Backup before any changes
  const backupPath = join(memoryDir, "learnings.backup.md");
  await Bun.write(backupPath, content);
  console.log(`Backup written to ${backupPath}`);

  const result = await runFullConsolidation(entries);
  entries = result.entries;

  if (result.deduplicatedCount > 0) {
    console.log(`Merged ${result.deduplicatedCount} duplicate(s).`);
  }
  if (result.contradictionsResolved > 0) {
    console.log(`Resolved ${result.contradictionsResolved} contradiction(s).`);
  }

  if (result.compoundsCreated > 0) {
    console.log(`Created ${result.compoundsCreated} compound(s).`);
  } else {
    console.log("No condensation candidates found.");
  }

  // Interactive: CWD-to-global promotion
  entries = await promptForPromotions(entries);

  // Write active set first, then archive — ensures source entries don't
  // appear in both active and archive if the process is interrupted.
  await writeLearnings(memoryDir, entries);
  if (result.archived.length > 0) {
    await appendToArchive(memoryDir, result.archived);
    console.log(`Archived ${result.archived.length} source entries.`);
  }
  console.log(`\nDone. ${originalCount} -> ${entries.length} entries.`);
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
