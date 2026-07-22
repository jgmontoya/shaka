/**
 * Interactive consolidation for `shaka memory consolidate`.
 *
 * Delegates all consolidation passes to `../../memory/consolidation`,
 * then handles automatic generalization, interactive scope review, and user-facing output.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { runFullConsolidation } from "../../memory/consolidation";
import {
  type LearningScopeState,
  effectiveSourceCwds,
  findCommonAncestorCandidate,
  normalizeCwdPath,
  reviewScopeWidening,
} from "../../memory/learning-scope";
import {
  commitConsolidationIfUnchanged,
  prepareLearningStoreForMutation,
} from "../../memory/learning-store";
import {
  type LearningEntry,
  findScopeReviewCandidates,
  findUniqueLearningMatch,
  generalizeLearningScopes,
  renderEntry,
} from "../../memory/learnings";
import { promptUser } from "./index";

type PromptFunction = (question: string) => Promise<string>;

export interface ConsolidationInteraction {
  readonly forbiddenAncestorRoots?: readonly string[];
  readonly isTTY?: boolean;
  readonly prompt?: PromptFunction;
}

export async function runConsolidation(
  memoryDir: string,
  interaction: ConsolidationInteraction = {},
): Promise<void> {
  const home = normalizeCwdPath(homedir());
  const forbiddenRoots = interaction.forbiddenAncestorRoots ?? (home ? [home] : []);
  const readiness = await prepareLearningStoreForMutation(memoryDir, ["active", "archive"]);
  const document = readiness.active?.document;
  if (!document) throw new Error("Active learning readiness was not established");
  const originalEntries = document.entries;
  let entries = originalEntries;
  const originalCount = entries.length;
  const content = document.sourceText;

  console.log(
    `learnings.md has ${originalCount} entries (${content.length} chars). Consolidating...`,
  );

  // Backup before any changes
  const backupPath = join(memoryDir, "learnings.backup.md");
  await Bun.write(backupPath, content);
  console.log(`Backup written to ${backupPath}`);

  const result = await runFullConsolidation(entries);
  entries = result.entries;

  const generalization = generalizeLearningScopes(entries, forbiddenRoots);
  entries = generalization.entries;

  if (result.deduplicatedCount > 0) {
    console.log(`Merged ${result.deduplicatedCount} duplicate(s).`);
  }
  if (result.duplicateScopeNarrowedCount > 0) {
    console.log(`Narrowed ${result.duplicateScopeNarrowedCount} duplicate scope(s).`);
  }
  if (result.unresolvedDuplicateCount > 0) {
    console.log(`Left ${result.unresolvedDuplicateCount} duplicate group(s) unresolved.`);
  }
  if (result.duplicateOverlapNoopCount > 0) {
    console.log(`Skipped ${result.duplicateOverlapNoopCount} overlapping duplicate proposal(s).`);
  }
  if (result.contradictionsResolved > 0) {
    console.log(`Resolved ${result.contradictionsResolved} contradiction(s).`);
  }
  if (result.unresolvedContradictionCount > 0) {
    console.log(`Left ${result.unresolvedContradictionCount} contradiction(s) unresolved.`);
  }
  if (result.contradictionOverlapNoopCount > 0) {
    console.log(
      `Skipped ${result.contradictionOverlapNoopCount} overlapping contradiction proposal(s).`,
    );
  }

  if (result.compoundsCreated > 0) {
    console.log(`Created ${result.compoundsCreated} compound(s).`);
  } else {
    console.log("No condensation candidates found.");
  }

  if (generalization.generalized > 0) {
    console.log(`Generalized ${generalization.generalized} learning scope(s).`);
  }

  // Interactive: optional broader scope review
  entries = await promptForScopeWidening(entries, {
    ...interaction,
    forbiddenAncestorRoots: forbiddenRoots,
  });

  const committed = await commitConsolidationIfUnchanged(memoryDir, {
    expectedActive: originalEntries,
    activeReplacement: entries,
    archiveEntries: result.archived,
  });
  if (!committed) {
    console.log("Learnings changed during consolidation. No changes were written; run it again.");
    return;
  }
  if (result.archived.length > 0) {
    console.log(`Archived ${result.archived.length} source entries.`);
  }
  console.log(`\nDone. ${originalCount} -> ${entries.length} entries.`);
}

function scopeState(entry: LearningEntry): LearningScopeState {
  return {
    cwds: entry.cwds,
    nonglobal: entry.nonglobal,
    ...(entry.promotionEvidence ? { promotionEvidence: entry.promotionEvidence } : {}),
  };
}

function withScopeState(entry: LearningEntry, state: LearningScopeState): LearningEntry {
  const { promotionEvidence: _previousEvidence, ...entryWithoutEvidence } = entry;
  return {
    ...entryWithoutEvidence,
    cwds: [...state.cwds],
    nonglobal: state.nonglobal,
    ...(state.promotionEvidence ? { promotionEvidence: state.promotionEvidence } : {}),
  };
}

function evidenceSources(entry: LearningEntry): readonly string[] {
  return entry.promotionEvidence ? effectiveSourceCwds(entry.promotionEvidence) : entry.cwds;
}

function showScopeEvidence(entry: LearningEntry): void {
  const evidence = entry.promotionEvidence;
  console.log(`  Active: ${entry.cwds.join(", ")}`);
  console.log(`  Sources: ${evidence?.sourceCwds.join(", ") ?? entry.cwds.join(", ")}`);
  console.log(`  Excluded: ${evidence?.excludedCwds.join(", ") || "none"}`);
}

type WideningChoice = "ancestor" | "global" | "keep" | "skip" | "quit";

function parseWideningChoice(answer: string): WideningChoice | "view" | undefined {
  const choices: Readonly<Record<string, WideningChoice | "view">> = {
    a: "ancestor",
    g: "global",
    k: "keep",
    q: "quit",
    s: "skip",
    v: "view",
  };
  return choices[answer];
}

async function askForWideningChoice(
  candidate: LearningEntry,
  ancestor: string | undefined,
  ask: PromptFunction,
): Promise<WideningChoice> {
  while (true) {
    const ancestorOption = ancestor ? "[a] use ancestor  " : "";
    const answer = (
      await ask(
        `  ${ancestorOption}[g] make global  [k] keep current  [v] evidence  [s] skip  [q] quit: `,
      )
    )
      .trim()
      .toLowerCase();
    const choice = parseWideningChoice(answer);
    if (choice === "view") {
      showScopeEvidence(candidate);
      continue;
    }
    if (choice === "ancestor" && !ancestor) {
      console.log("  No safe common ancestor is available.");
      continue;
    }
    if (choice) return choice;
    console.log("  Unknown choice.");
  }
}

function applyWideningChoice(
  candidate: LearningEntry,
  choice: Exclude<WideningChoice, "skip" | "quit">,
  ancestor: string | undefined,
  forbiddenRoots: readonly string[],
): LearningEntry | undefined {
  const scopeChoice =
    choice === "ancestor" && ancestor
      ? { kind: "confirmed-ancestor" as const, cwd: ancestor, forbiddenRoots }
      : choice === "global"
        ? { kind: "global" as const }
        : { kind: "keep-current" as const };
  const transition = reviewScopeWidening(scopeState(candidate), candidate.exposures, scopeChoice);
  if (!transition.ok) {
    console.log(`  Scope unchanged: ${transition.issue.message}`);
    return undefined;
  }
  console.log(`  Scope set to: ${transition.state.cwds.join(", ")}`);
  return withScopeState(candidate, transition.state);
}

async function reviewWideningCandidate(
  result: LearningEntry[],
  candidate: LearningEntry,
  ask: PromptFunction,
  forbiddenRoots: readonly string[],
): Promise<"continue" | "quit"> {
  const match = findUniqueLearningMatch(result, candidate);
  if (match.status === "ambiguous") {
    console.log(`\n  Skipping ${candidate.title}: identical persisted entries are ambiguous.`);
    return "continue";
  }
  if (match.status === "stale") return "continue";

  console.log(`\n  ${renderEntry(candidate).split("\n").slice(0, 4).join("\n  ")}`);
  const candidateAncestor = findCommonAncestorCandidate(evidenceSources(candidate), forbiddenRoots);
  const ancestor =
    candidate.cwds.length === 1 && candidate.cwds[0] === candidateAncestor
      ? undefined
      : candidateAncestor;
  showScopeEvidence(candidate);
  console.log(`  Proposed ancestor: ${ancestor ?? "none"}`);
  const choice = await askForWideningChoice(candidate, ancestor, ask);
  if (choice === "quit") return "quit";
  if (choice === "skip") return "continue";

  const updated = applyWideningChoice(candidate, choice, ancestor, forbiddenRoots);
  if (updated) result[match.index] = updated;
  return "continue";
}

export async function promptForScopeWidening(
  entries: LearningEntry[],
  interaction: ConsolidationInteraction = {},
): Promise<LearningEntry[]> {
  const candidates = findScopeReviewCandidates(entries);
  const isTTY = interaction.isTTY ?? process.stdin.isTTY === true;
  if (candidates.length === 0 || !isTTY) return entries;
  const ask = interaction.prompt ?? promptUser;
  const forbiddenRoots = interaction.forbiddenAncestorRoots ?? [];

  console.log("\n--- Interactive: learning scope review ---");

  const result = [...entries];

  for (const candidate of candidates) {
    const outcome = await reviewWideningCandidate(result, candidate, ask, forbiddenRoots);
    if (outcome === "quit") return result;
  }

  return result;
}
