#!/usr/bin/env bun
/**
 * SessionStart hook for Claude Code
 * Loads system context, user files, and recent session summaries.
 * Outputs additionalContext for the session.
 */

import { join } from "node:path";
import {
  getAssistantName,
  getPrincipalName,
  isSubagent,
  listSummaries,
  loadLearnings,
  loadShakaFile,
  loadSummary,
  renderEntry,
  resolveShakaHome,
  selectLearnings,
  selectRecentSummaries,
} from "shaka";

/** Hook trigger events - Shaka canonical names (provider configurers handle conversion) */
export const TRIGGER = ["session.start"] as const;
export const HOOK_VERSION = "0.5.0";

/** Max total characters for the memory section (~5KB) */
const MAX_MEMORY_CHARS = 5000;

/** Max characters for learnings context (~6KB) */
const MAX_LEARNINGS_CHARS = 6000;

/**
 * Resolve the defaults/user/ directory from the system/ symlink.
 *
 * SHAKA_HOME/system is always a symlink to <repo>/defaults/system.
 * The user templates live at <repo>/defaults/user/ — one level up
 * from the symlink target.
 *
 * Returns null if the symlink can't be resolved (shouldn't happen
 * in a properly initialized installation).
 */
async function resolveDefaultsUserDir(shakaHome: string): Promise<string | null> {
  try {
    const { readlink } = await import("node:fs/promises");
    const systemTarget = await readlink(join(shakaHome, "system"));
    // systemTarget is e.g. /path/to/shaka/defaults/system
    // defaults/user/ is at ../user relative to that
    return join(systemTarget, "..", "user");
  } catch {
    return null;
  }
}

/**
 * Check whether a user file is identical to its default plain-markdown template.
 *
 * Only compares against direct .md files in defaults/user/ (goals.md, etc.).
 * Files sourced from .eta templates (user.md, assistant.md) are always included
 * because they contain configured identity info that's useful as context.
 *
 * Returns true if the file matches its template verbatim (i.e. unmodified).
 * Returns false if no template exists or the content differs.
 */
async function isUnmodifiedTemplate(
  content: string,
  filename: string,
  defaultsUserDir: string,
): Promise<boolean> {
  const templatePath = join(defaultsUserDir, filename);
  const templateFile = Bun.file(templatePath);
  if (!(await templateFile.exists())) return false;

  const defaultContent = await templateFile.text();
  return content.trim() === defaultContent.trim();
}

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
async function loadLearnedKnowledge(shakaHome: string): Promise<string> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  try {
    const entries = await loadLearnings(memoryDir);
    if (entries.length === 0) return "";

    const selected = selectLearnings(entries, cwd, MAX_LEARNINGS_CHARS);
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
async function loadRecentSessions(shakaHome: string): Promise<string> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  try {
    const allSummaries = await listSummaries(memoryDir);
    if (allSummaries.length === 0) return "";

    const selected = selectRecentSummaries(allSummaries, cwd);
    if (selected.length === 0) return "";

    const sections: string[] = [];
    let totalChars = 0;

    for (const index of selected) {
      const summary = await loadSummary(index.filePath);
      if (!summary) continue;

      const section = `### ${summary.title}\n*${summary.metadata.date} | ${summary.metadata.provider}*\n\n${summary.body}`;

      if (totalChars + section.length > MAX_MEMORY_CHARS && sections.length > 0) {
        break;
      }

      sections.push(section);
      totalChars += section.length;
    }

    if (sections.length === 0) return "";

    return `## Recent Sessions\n\n${sections.join("\n\n---\n\n")}`;
  } catch {
    // Memory directory doesn't exist or can't be read — that's fine
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
  const learningsSection = await loadLearnedKnowledge(shakaHome);
  if (learningsSection) {
    contextParts.push(learningsSection);
    mark("Loaded learnings", t, `${learningsSection.length} chars`);
  } else {
    mark("No learnings to load", t);
  }

  // Load recent session summaries
  t = performance.now();
  const memorySections = await loadRecentSessions(shakaHome);
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
