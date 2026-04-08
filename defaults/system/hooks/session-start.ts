#!/usr/bin/env bun
/**
 * SessionStart hook for Claude Code
 * Loads system context, user files, and recent session summaries.
 * Outputs additionalContext for the session.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  getAssistantName,
  getPrincipalName,
  isSubagent,
  isUnmodifiedTemplate,
  listSummaries,
  loadConfig,
  loadKnowledgeIndex,
  loadLearnings,
  loadShakaFile,
  renderEntry,
  renderSessionSection,
  resolveDefaultsUserDir,
  resolveShakaHome,
  selectLearnings,
  loadRollups,
  selectRecentSummaries,
} from "shaka";

/** Hook trigger events - Shaka canonical names (provider configurers handle conversion) */
export const TRIGGER = ["session.start"] as const;
export const HOOK_VERSION = "0.6.0";

/** Default max total characters for the memory section (~5KB) */
const DEFAULT_SESSIONS_BUDGET = 5000;

/** Default max characters for learnings context (~6KB) */
const DEFAULT_LEARNINGS_BUDGET = 6000;

/** Default recency window for learnings scoring */
const DEFAULT_RECENCY_WINDOW_DAYS = 90;

/**
 * Load all markdown files from user/ directory.
 * Skips plain-markdown files that are still identical to their default templates
 * to avoid injecting noise tokens into the session context.
 */
async function loadUserFiles(shakaHome: string): Promise<string[]> {
  const userDir = join(shakaHome, "user");
  const defaultsUserDir = await resolveDefaultsUserDir(shakaHome);
  const contents: string[] = [];

  try {
    const glob = new Bun.Glob("*.md");
    for await (const file of glob.scan({ cwd: userDir })) {
      const content = await Bun.file(join(userDir, file)).text();
      if (!content.trim()) continue;

      if (defaultsUserDir && (await isUnmodifiedTemplate(content, file, defaultsUserDir))) {
        console.error(`  ⏭ user/${file} (unmodified template, skipped)`);
        continue;
      }

      contents.push(content);
      console.error(`  ✓ user/${file}`);
    }
  } catch {
    // user/ directory doesn't exist yet - that's ok
  }

  return contents;
}

/**
 * Load learned knowledge for context.
 * Returns a formatted markdown section, or empty string if none available.
 */
async function loadLearnedKnowledge(
  shakaHome: string,
  budget: number,
  recencyWindowDays: number,
): Promise<string> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  try {
    const entries = await loadLearnings(memoryDir);
    if (entries.length === 0) return "";

    const selected = selectLearnings(entries, cwd, budget, recencyWindowDays);
    if (selected.length === 0) return "";

    const rendered = selected.map(renderEntry).join("\n\n---\n\n");
    return `## Learnings\n\n${rendered}`;
  } catch {
    return "";
  }
}

/**
 * Load recent session summaries for context.
 * Returns a formatted markdown section, or empty string if none available.
 */
async function loadRecentSessions(shakaHome: string, budget: number): Promise<string> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  try {
    const allSummaries = await listSummaries(memoryDir);
    const selected = selectRecentSummaries(allSummaries, cwd);
    return await renderSessionSection(selected, budget);
  } catch {
    // Memory directory doesn't exist or can't be read — that's fine
    return "";
  }
}

/**
 * Load rolling summaries for context.
 * Returns a formatted markdown section, or empty string if none available.
 */
async function loadRollingSummaries(shakaHome: string): Promise<string> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();
  try {
    return await loadRollups(memoryDir, cwd);
  } catch {
    return "";
  }
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

async function main() {
  const t0 = performance.now();
  const timings: string[] = [];

  function mark(label: string, startMs: number, detail = "") {
    const ms = elapsedMs(startMs);
    const line = `  [${ms}ms] ${label}${detail ? ` (${detail})` : ""}`;
    console.error(line);
    timings.push(line);
  }

  // Skip context loading for subagent sessions
  if (isSubagent()) {
    console.error("🤖 Subagent session - skipping context loading");
    process.exit(0);
  }

  const shakaHome = resolveShakaHome();
  const config = await loadConfig(shakaHome);
  const learningsBudget = config?.memory?.learnings_budget ?? DEFAULT_LEARNINGS_BUDGET;
  const sessionsBudget = config?.memory?.sessions_budget ?? DEFAULT_SESSIONS_BUDGET;
  const recencyWindowDays = config?.memory?.recency_window_days ?? DEFAULT_RECENCY_WINDOW_DAYS;

  // Clean up stale session-end temp files (from crashed workers)
  const memoryDir = join(shakaHome, "memory");
  try {
    const glob = new Bun.Glob(".session-end-input-*.json");
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for await (const file of glob.scan({ cwd: memoryDir })) {
      const filePath = join(memoryDir, file);
      const stat = await Bun.file(filePath).stat();
      if (stat && stat.mtimeMs < oneHourAgo) {
        await unlink(filePath).catch(() => {});
      }
    }
  } catch {
    /* memory dir might not exist yet */
  }

  const contextParts: string[] = [];

  // Load system reasoning framework (with customization override support)
  let t = performance.now();
  const reasoning = await loadShakaFile("system/base-reasoning-framework.md", shakaHome);
  if (reasoning) {
    contextParts.push(reasoning);
    mark("Loaded reasoning framework", t, `${reasoning.length} chars`);
  }

  // Load user files (skips unmodified plain-markdown templates)
  t = performance.now();
  const userFiles = await loadUserFiles(shakaHome);
  contextParts.push(...userFiles);
  mark("Loaded user files", t, `${userFiles.length} files`);

  // Load learnings (between user files and sessions — stable knowledge first)
  t = performance.now();
  const learningsSection = await loadLearnedKnowledge(
    shakaHome,
    learningsBudget,
    recencyWindowDays,
  );
  if (learningsSection) {
    contextParts.push(learningsSection);
    mark("Loaded learnings", t, `${learningsSection.length} chars`);
  } else {
    mark("No learnings to load", t);
  }

  // Load knowledge index (topic list with paths — LLM reads pages on demand)
  t = performance.now();
  const knowledgeEnabled = config?.memory?.knowledge_enabled ?? true;
  if (knowledgeEnabled) {
    try {
      const knowledgeIndex = await loadKnowledgeIndex(memoryDir, process.cwd());
      if (knowledgeIndex) {
        contextParts.push(knowledgeIndex);
        mark("Loaded knowledge index", t, `${knowledgeIndex.length} chars`);
      } else {
        mark("No knowledge base to load", t);
      }
    } catch {
      mark("Knowledge index load failed (fail-open)", t);
    }
  } else {
    mark("Knowledge base disabled", t);
  }

  // Load rolling summaries (compressed history between learnings and sessions)
  t = performance.now();
  const rollupsSection = await loadRollingSummaries(shakaHome);
  if (rollupsSection) {
    contextParts.push(rollupsSection);
    mark("Loaded rolling summaries", t, `${rollupsSection.length} chars`);
  } else {
    mark("No rolling summaries to load", t);
  }

  // Load recent session summaries
  t = performance.now();
  const memorySections = await loadRecentSessions(shakaHome, sessionsBudget);
  if (memorySections) {
    contextParts.push(memorySections);
    mark("Loaded session summaries", t, `${memorySections.length} chars`);
  } else {
    mark("No session summaries to load", t);
  }

  if (contextParts.length === 0) {
    console.error("⚠️ No context files loaded");
    process.exit(0);
  }

  // Get identity from config
  const [principalName, assistantName] = await Promise.all([
    getPrincipalName(shakaHome),
    getAssistantName(shakaHome),
  ]);

  // Get current date/time (uses system locale and timezone)
  const currentDate = new Date().toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  });

  // Join all context with separators
  const contextContent = contextParts.join("\n\n---\n\n");

  const totalChars = contextContent.length;

  const systemReminder = `<system-reminder>
SHAKA CONTEXT (Auto-loaded at Session Start)

📅 CURRENT DATE/TIME: ${currentDate}

## IDENTITY

- User: **${principalName}**
- Assistant: **${assistantName}**

---

${contextContent}

---

This context is now active.
</system-reminder>`;

  console.log(systemReminder);
  mark("Session-start hook total", t0, `${totalChars} chars context`);

  // Write timing to file for diagnostics (non-blocking, fail-silent)
  const timingPath = join(shakaHome, "memory", ".timing-session-start.log");
  Bun.write(timingPath, `${new Date().toISOString()}\n${timings.join("\n")}\n`).catch(() => {});
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  });
}
