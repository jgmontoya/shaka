/**
 * Consolidation orchestration for `shaka memory consolidate`.
 *
 * Runs duplicate detection, contradiction resolution, and interactive
 * CWD-to-global promotion. Each pass delegates to pure functions in
 * `../../memory/consolidation` and persists results via `writeLearnings()`.
 */

import { join } from "node:path";
import { inference } from "../../inference";
import {
  applyDuplicateMerges,
  buildContradictionPrompt,
  buildDuplicatePrompt,
  parseContradictionOutput,
  parseDuplicateOutput,
  resolveContradictions,
} from "../../memory/consolidation";
import {
  type LearningEntry,
  findPromotionCandidates,
  loadLearnings,
  markNonglobal,
  promoteToGlobal,
  renderEntry,
  renderLearnings,
  writeLearnings,
} from "../../memory/learnings";
import { promptUser } from "./index";

const CONSOLIDATION_THRESHOLD = 20;

export async function runConsolidation(memoryDir: string): Promise<void> {
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
