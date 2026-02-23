/**
 * Context measurement for `shaka doctor --context`.
 *
 * Uses the real selection/scoring/rendering logic from the SessionStart hook
 * to produce accurate context injection measurements.
 *
 * Architecture: collectMeasurements() returns structured data (testable),
 * printMeasurement() handles all presentation (thin layer).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getAssistantName,
  getPrincipalName,
  isUnmodifiedTemplate,
  loadConfig,
  loadShakaFile,
  resolveDefaultsUserDir,
  resolveShakaHome,
} from "../domain/config";
import { loadLearnings, renderEntry, selectLearnings } from "../memory/learnings";
import { loadRollups } from "../memory/rollups";
import { listSummaries, renderSessionSection, selectRecentSummaries } from "../memory/storage";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Component {
  name: string;
  chars: number;
  detail: string;
  hook: string;
}

export interface LearningsComponent extends Component {
  totalOnDisk: number;
  entryCount: number;
  selectedCount: number;
  budget: number;
}

export interface SessionsComponent extends Component {
  totalOnDisk: number;
  fileCount: number;
  selectedCount: number;
  budget: number;
}

export interface UserFileComponent extends Component {
  skipped: boolean;
}

export interface RollupsComponent extends Component {
  totalOnDisk: number;
}

export interface FormatReminderComponents {
  full: Component;
  iteration: Component;
  minimal: Component;
  classificationPrompt: Component;
}

export interface ContextMeasurement {
  shakaHome: string;
  framework: Component;
  identity: Component;
  userFiles: UserFileComponent[];
  learnings: LearningsComponent;
  sessions: SessionsComponent;
  rollups: RollupsComponent;
  formatReminder: FormatReminderComponents;
  security: Component;
  separators: Component;
  sessionStartTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "0%";
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function bar(fraction: number, width = 30): string {
  const f = Number.isFinite(fraction) ? fraction : 0;
  const filled = Math.max(0, Math.min(width, Math.round(f * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

async function fileCharCount(path: string): Promise<number> {
  try {
    const f = Bun.file(path);
    return (await f.exists()) ? (await f.text()).length : 0;
  } catch {
    return 0;
  }
}

async function fileText(path: string): Promise<string> {
  try {
    const f = Bun.file(path);
    return (await f.exists()) ? await f.text() : "";
  } catch {
    return "";
  }
}

// ─── Measurement functions ───────────────────────────────────────────────────

async function measureFramework(shakaHome: string): Promise<Component> {
  const content = await loadShakaFile("system/base-reasoning-framework.md", shakaHome);
  return {
    name: "Reasoning Framework",
    chars: content?.length ?? 0,
    detail: "system/base-reasoning-framework.md (via loadShakaFile, respects customizations)",
    hook: "SessionStart",
  };
}

async function measureIdentityHeader(shakaHome: string): Promise<Component> {
  const [principalName, assistantName] = await Promise.all([
    getPrincipalName(shakaHome),
    getAssistantName(shakaHome),
  ]);
  const currentDate = new Date().toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  });

  const header = `<system-reminder>
SHAKA CONTEXT (Auto-loaded at Session Start)

📅 CURRENT DATE/TIME: ${currentDate}

## IDENTITY

- User: **${principalName}**
- Assistant: **${assistantName}**

---

`;

  const footer = "\n\n---\n\nThis context is now active.\n</system-reminder>";

  return {
    name: "Identity + Wrapper",
    chars: header.length + footer.length,
    detail: "system-reminder tags, date/time, identity block, separators",
    hook: "SessionStart",
  };
}

async function measureUserFiles(shakaHome: string): Promise<UserFileComponent[]> {
  const userDir = join(shakaHome, "user");
  const defaultsUserDir = await resolveDefaultsUserDir(shakaHome);
  const components: UserFileComponent[] = [];

  try {
    const files = (await readdir(userDir)).filter((f) => f.endsWith(".md")).sort();

    for (const file of files) {
      const content = await fileText(join(userDir, file));
      if (!content.trim()) continue;

      let skipped = false;
      if (defaultsUserDir) {
        skipped = await isUnmodifiedTemplate(content, file, defaultsUserDir);
      }

      components.push({
        name: `user/${file}${skipped ? " (SKIPPED)" : ""}`,
        chars: skipped ? 0 : content.length,
        detail: skipped
          ? "unmodified template → not injected"
          : `${content.split("\n").length} lines`,
        hook: "SessionStart",
        skipped,
      });
    }
  } catch {
    // user dir doesn't exist
  }

  return components;
}

async function measureLearnings(shakaHome: string): Promise<LearningsComponent> {
  const config = await loadConfig(shakaHome);
  const budget = config?.memory?.learnings_budget ?? 6000;
  const recencyWindowDays = config?.memory?.recency_window_days ?? 90;
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  let totalOnDisk = 0;
  let entryCount = 0;
  let selectedCount = 0;
  let injectedChars = 0;

  try {
    const entries = await loadLearnings(memoryDir);
    entryCount = entries.length;

    const learningsPath = join(memoryDir, "learnings.md");
    totalOnDisk = await fileCharCount(learningsPath);

    const selected = selectLearnings(entries, cwd, budget, recencyWindowDays);
    selectedCount = selected.length;

    if (selected.length > 0) {
      const rendered = selected.map(renderEntry).join("\n\n---\n\n");
      const section = `## Learnings\n\n${rendered}`;
      injectedChars = section.length;
    }
  } catch {
    // no learnings
  }

  return {
    name: "Learnings",
    chars: injectedChars,
    detail: `${selectedCount}/${entryCount} entries selected (${fmt(totalOnDisk)} chars on disk), budget: ${fmt(budget)} chars`,
    hook: "SessionStart",
    totalOnDisk,
    entryCount,
    selectedCount,
    budget,
  };
}

async function measureSessions(shakaHome: string): Promise<SessionsComponent> {
  const config = await loadConfig(shakaHome);
  const budget = config?.memory?.sessions_budget ?? 5000;
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  let totalOnDisk = 0;
  let fileCount = 0;
  let selectedCount = 0;
  let injectedChars = 0;

  try {
    const allSummaries = await listSummaries(memoryDir);
    fileCount = allSummaries.length;

    for (const s of allSummaries) {
      totalOnDisk += await fileCharCount(s.filePath);
    }

    const selected = selectRecentSummaries(allSummaries, cwd);
    selectedCount = selected.length;

    const rendered = await renderSessionSection(selected, budget);
    injectedChars = rendered.length;
  } catch {
    // no sessions
  }

  return {
    name: "Session Summaries",
    chars: injectedChars,
    detail: `${selectedCount}/${fileCount} sessions selected (${fmt(totalOnDisk)} chars on disk), budget: ${fmt(budget)} chars`,
    hook: "SessionStart",
    totalOnDisk,
    fileCount,
    selectedCount,
    budget,
  };
}

async function measureRollups(shakaHome: string): Promise<RollupsComponent> {
  const memoryDir = join(shakaHome, "memory");
  const cwd = process.cwd();

  let injectedChars = 0;
  let totalOnDisk = 0;

  try {
    const rendered = await loadRollups(memoryDir, cwd);
    injectedChars = rendered.length;

    const rollupsDir = join(memoryDir, "rollups");
    try {
      const projects = await readdir(rollupsDir);
      for (const proj of projects) {
        const projDir = join(rollupsDir, proj);
        for (const period of ["daily", "weekly", "monthly"] as const) {
          totalOnDisk += await fileCharCount(join(projDir, `${period}.md`));
        }
      }
    } catch {
      // no rollups dir
    }
  } catch {
    // no rollups
  }

  return {
    name: "Rolling Summaries",
    chars: injectedChars,
    detail: `${fmt(totalOnDisk)} chars on disk, ${fmt(injectedChars)} chars injected for CWD (no budget cap)`,
    hook: "SessionStart",
    totalOnDisk,
  };
}

async function measureFormatReminder(shakaHome: string): Promise<FormatReminderComponents> {
  const templatesDir = join(shakaHome, "system", "templates");

  const fullRaw = await fileText(join(templatesDir, "reminder-full.eta"));
  const iterRaw = await fileText(join(templatesDir, "reminder-iteration.eta"));
  const minRaw = await fileText(join(templatesDir, "reminder-minimal.eta"));
  const classRaw = await fileText(join(templatesDir, "classification-prompt.eta"));

  const stripEta = (s: string) => s.replace(/<%[\s\S]*?%>/g, "").trim();

  const typicalCapLine = "• Engineer → Engineer (subagent_type=Engineer)\n";
  const typicalToolLine = "• Council — Multi-agent debate for complex decisions\n";
  const fullRendered =
    stripEta(fullRaw).length + typicalCapLine.length * 2 + typicalToolLine.length * 2;

  return {
    full: {
      name: "Format Reminder (FULL)",
      chars: fullRendered,
      detail: "Depth enforcement + capability/thinking hints",
      hook: "UserPromptSubmit",
    },
    iteration: {
      name: "Format Reminder (ITERATION)",
      chars: stripEta(iterRaw).length + typicalCapLine.length,
      detail: "Condensed iteration format reminder",
      hook: "UserPromptSubmit",
    },
    minimal: {
      name: "Format Reminder (MINIMAL)",
      chars: stripEta(minRaw).length,
      detail: "Minimal header-only format reminder",
      hook: "UserPromptSubmit",
    },
    classificationPrompt: {
      name: "Classification Prompt (AI inference)",
      chars: classRaw.length,
      detail: "Sent to inference model (NOT injected into conversation — internal cost only)",
      hook: "UserPromptSubmit (internal)",
    },
  };
}

async function measureSecurityValidator(shakaHome: string): Promise<Component> {
  const chars = await fileCharCount(join(shakaHome, "system", "security", "patterns.yaml"));
  return {
    name: "Security Patterns",
    chars: 0,
    detail: `patterns.yaml (${fmt(chars)} chars) loaded internally, NOT injected into context`,
    hook: "PreToolUse (internal)",
  };
}

function measureSeparators(partCount: number): Component {
  const sep = "\n\n---\n\n";
  const count = Math.max(0, partCount - 1);
  return {
    name: "Section Separators",
    chars: sep.length * count,
    detail: `"\\n\\n---\\n\\n" × ${count} parts`,
    hook: "SessionStart",
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Collect all context measurements using real selection/scoring logic.
 * Returns structured data — no side effects, no console output.
 */
export async function collectMeasurements(shakaHome: string): Promise<ContextMeasurement> {
  const framework = await measureFramework(shakaHome);
  const identity = await measureIdentityHeader(shakaHome);
  const userFiles = await measureUserFiles(shakaHome);
  const learnings = await measureLearnings(shakaHome);
  const sessions = await measureSessions(shakaHome);
  const rollups = await measureRollups(shakaHome);
  const formatReminder = await measureFormatReminder(shakaHome);
  const security = await measureSecurityValidator(shakaHome);

  const injectedUserFiles = userFiles.filter((f) => !f.skipped);
  const partCount =
    (framework.chars > 0 ? 1 : 0) +
    injectedUserFiles.length +
    (learnings.chars > 0 ? 1 : 0) +
    (rollups.chars > 0 ? 1 : 0) +
    (sessions.chars > 0 ? 1 : 0);
  const separators = measureSeparators(partCount);

  const allComponents = [
    framework,
    identity,
    ...userFiles,
    learnings,
    rollups,
    sessions,
    separators,
  ];
  const sessionStartTotal = allComponents.reduce((sum, c) => sum + c.chars, 0);

  return {
    shakaHome,
    framework,
    identity,
    userFiles,
    learnings,
    sessions,
    rollups,
    formatReminder,
    security,
    separators,
    sessionStartTotal,
  };
}

// ─── Presentation ────────────────────────────────────────────────────────────

function printMeasurement(m: ContextMeasurement): void {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║          SHAKA CONTEXT INJECTION MEASUREMENT                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`📍 SHAKA_HOME: ${m.shakaHome}`);
  console.log(`📍 CWD: ${process.cwd()}`);
  console.log(`📅 Measured at: ${new Date().toLocaleString()}`);
  console.log();

  // ─── SESSION START BREAKDOWN ─────────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🚀 SESSION START HOOK (session.start → SessionStart)");
  console.log("  Fires once at session start. Injects system-reminder block.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  const sessionStartComponents: (Component | UserFileComponent)[] = [
    m.framework,
    m.identity,
    ...m.userFiles,
    m.learnings,
    m.rollups,
    m.sessions,
    m.separators,
  ];

  for (const c of sessionStartComponents) {
    const tokens = estimateTokens(c.chars);
    const fraction = m.sessionStartTotal > 0 ? c.chars / m.sessionStartTotal : 0;
    const prefix = "skipped" in c && c.skipped ? "  ⏭ " : "  ✦ ";
    console.log(`${prefix}${c.name}`);
    console.log(
      `     ${fmt(c.chars)} chars  │  ~${fmt(tokens)} tokens  │  ${bar(fraction)} ${pct(c.chars, m.sessionStartTotal)}`,
    );
    console.log(`     ${c.detail}`);
    console.log();
  }

  console.log("  ┌─────────────────────────────────────────────────────────────┐");
  console.log(
    `  │  SESSION START TOTAL: ${fmt(m.sessionStartTotal).padStart(7)} chars  │  ~${fmt(estimateTokens(m.sessionStartTotal)).padStart(6)} tokens  │`,
  );
  console.log("  └─────────────────────────────────────────────────────────────┘");
  console.log();

  // ─── USER PROMPT SUBMIT BREAKDOWN ────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  📝 USER PROMPT SUBMIT HOOK (prompt.submit → UserPromptSubmit)");
  console.log("  Fires on EVERY user message. Classifies depth, injects reminder.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  for (const c of [
    m.formatReminder.full,
    m.formatReminder.iteration,
    m.formatReminder.minimal,
    m.formatReminder.classificationPrompt,
  ]) {
    const tokens = estimateTokens(c.chars);
    const isInternal = c.hook.includes("internal");
    const prefix = isInternal ? "  ⚙ " : "  ✦ ";
    console.log(`${prefix}${c.name}`);
    console.log(`     ${fmt(c.chars)} chars  │  ~${fmt(tokens)} tokens`);
    console.log(`     ${c.detail}`);
    console.log();
  }

  console.log("  Note: Only ONE reminder variant is injected per message (based on");
  console.log("  AI classification). FULL is the most common.");
  console.log();

  // ─── PRE-TOOL-USE ────────────────────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🔒 SECURITY VALIDATOR HOOK (tool.before → PreToolUse)");
  console.log("  Fires before Bash/Edit/Write/Read. No context injected.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();
  console.log(`  ⚙ ${m.security.name}`);
  console.log(`     ${m.security.detail}`);
  console.log("     Returns JSON decisions only — no tokens added to conversation.");
  console.log();

  // ─── TOTAL COST PER SESSION ──────────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  📊 TOTAL CONTEXT COST PER SESSION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  const fullReminderChars = m.formatReminder.full.chars;
  const typicalMessages = 20;

  console.log("  Scenario: Typical session (~20 messages, mostly FULL depth)");
  console.log();
  console.log("  ┌────────────────────────────┬──────────────┬──────────────────┐");
  console.log("  │ Component                  │ Chars        │ ~Tokens          │");
  console.log("  ├────────────────────────────┼──────────────┼──────────────────┤");
  console.log(
    `  │ Session Start (once)       │ ${fmt(m.sessionStartTotal).padStart(12)} │ ${fmt(estimateTokens(m.sessionStartTotal)).padStart(16)} │`,
  );
  console.log(
    `  │ Format Reminder (×${typicalMessages})      │ ${fmt(fullReminderChars * typicalMessages).padStart(12)} │ ${fmt(estimateTokens(fullReminderChars * typicalMessages)).padStart(16)} │`,
  );
  console.log("  ├────────────────────────────┼──────────────┼──────────────────┤");

  const totalSession = m.sessionStartTotal + fullReminderChars * typicalMessages;
  console.log(
    `  │ TOTAL                      │ ${fmt(totalSession).padStart(12)} │ ${fmt(estimateTokens(totalSession)).padStart(16)} │`,
  );
  console.log("  └────────────────────────────┴──────────────┴──────────────────┘");
  console.log();

  // ─── BUDGET UTILIZATION ──────────────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  💾 MEMORY BUDGET UTILIZATION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  console.log("  Learnings:");
  console.log(
    `     On disk:  ${fmt(m.learnings.totalOnDisk)} chars (${m.learnings.entryCount} entries)`,
  );
  console.log(`     Budget:   ${fmt(m.learnings.budget)} chars`);
  console.log(
    `     Injected: ${fmt(m.learnings.chars)} chars (${m.learnings.selectedCount}/${m.learnings.entryCount} selected, ${pct(m.learnings.chars, m.learnings.budget)} of budget)`,
  );
  console.log(`     ${bar(m.learnings.chars / m.learnings.budget, 40)}`);
  console.log();

  console.log("  Sessions:");
  console.log(
    `     On disk:  ${fmt(m.sessions.totalOnDisk)} chars (${m.sessions.fileCount} files)`,
  );
  console.log(`     Budget:   ${fmt(m.sessions.budget)} chars`);
  console.log(
    `     Injected: ${fmt(m.sessions.chars)} chars (${m.sessions.selectedCount}/${m.sessions.fileCount} selected, ${pct(m.sessions.chars, m.sessions.budget)} of budget)`,
  );
  console.log(`     ${bar(m.sessions.chars / m.sessions.budget, 40)}`);
  console.log();

  // ─── COMPOSITION BREAKDOWN ───────────────────────────────────────────────

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🧩 SESSION START COMPOSITION");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  const injectedUserFiles = m.userFiles.filter((f) => !f.skipped);
  const groups = [
    { label: "Reasoning Framework", chars: m.framework.chars },
    { label: "Identity + Wrapper", chars: m.identity.chars },
    {
      label: "User Files",
      chars: injectedUserFiles.reduce((s, f) => s + f.chars, 0),
    },
    { label: "Learnings", chars: m.learnings.chars },
    { label: "Rolling Summaries", chars: m.rollups.chars },
    { label: "Session Summaries", chars: m.sessions.chars },
    { label: "Separators", chars: m.separators.chars },
  ];

  for (const g of groups) {
    const fraction = m.sessionStartTotal > 0 ? g.chars / m.sessionStartTotal : 0;
    console.log(
      `  ${g.label.padEnd(24)} ${bar(fraction, 35)} ${fmt(g.chars).padStart(7)} chars (${pct(g.chars, m.sessionStartTotal).padStart(5)})`,
    );
  }

  console.log();
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ℹ  Context window reference: Claude Opus ~200K tokens");
  console.log(
    `     Session start overhead: ~${pct(estimateTokens(m.sessionStartTotal), 200_000)} of context window`,
  );
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run context measurement and print results.
 * Called by `shaka doctor --context`.
 */
export async function measureContext(): Promise<void> {
  const shakaHome = resolveShakaHome();
  const measurement = await collectMeasurements(shakaHome);
  printMeasurement(measurement);
}
