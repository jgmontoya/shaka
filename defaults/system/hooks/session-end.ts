#!/usr/bin/env bun
/**
 * SessionEnd hook — transcript summarization (fire-and-forget)
 *
 * Architecture:
 *   Dispatch (default): reads stdin → writes temp file → spawns detached worker → exits 0
 *   Worker (--worker <tmpfile>): reads temp file → inference → writes summary + learnings
 *
 * The dispatch process exits in milliseconds so the CLI is never blocked.
 * The worker runs detached and writes results to disk asynchronously.
 *
 * Provider detection:
 * - Claude Code sends { transcript_path, session_id, reason, cwd }
 * - opencode sends { session_id, reason, cwd } (no transcript_path)
 *
 * Fail-open: any error logs to stderr and exits 0.
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type NormalizedMessage,
  type ProviderName,
  type SessionMetadata,
  type SessionRewriteCounts,
  buildSummarizationPrompt,
  compileKnowledge,
  hashSessionId,
  inference,
  isSubagent,
  loadConfig,
  mutateLearnings,
  parseClaudeCodeTranscript,
  parseCodexTranscript,
  parseExtractedLearnings,
  parseOpencodeTranscript,
  parsePiTranscript,
  parseSummaryOutput,
  prepareLearningStoreForMutation,
  readExistingTopicTitles,
  resolveKnowledgeProjectDir,
  resolveShakaHome,
  rewriteSessionLearnings,
  runMaintenance,
  truncateTranscript,
  updateRollups,
  validateSessionRewriteInput,
  writeSummary,
} from "shaka";

/** Hook trigger events — Shaka canonical names */
export const TRIGGER = ["session.end"] as const;
export const HOOK_VERSION = "0.3.0";

/** Max transcript chars to send to inference (avoid token limits) */
const MAX_TRANSCRIPT_CHARS = 100_000;

/** CLI flag that switches to worker mode */
const WORKER_FLAG = "--worker";

interface SessionEndInput {
  session_id?: string;
  transcript_path?: string;
  reason?: string;
  cwd?: string;
  provider?: string;
}

/** Type guard narrowing the on-wire `provider` string to ProviderName. */
function isProviderName(value: unknown): value is ProviderName {
  return value === "claude" || value === "opencode" || value === "codex" || value === "pi";
}

/**
 * Read stdin with timeout. Session-end hooks receive JSON on stdin.
 */
async function readStdin(timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeout);
    process.stdin.on("data", (chunk) => {
      data += chunk.toString();
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

/**
 * Read and parse transcript based on provider.
 * Each provider identifies itself via input.provider (set by configurer or debounce script).
 */
async function loadTranscript(input: SessionEndInput): Promise<NormalizedMessage[]> {
  switch (input.provider) {
    case "claude":
      if (!input.transcript_path) {
        console.error("Claude session missing transcript_path");
        return [];
      }
      return await loadClaudeTranscript(input.transcript_path);
    case "codex":
      return await loadCodexTranscript(input.transcript_path);
    case "pi":
      return await loadPiTranscript(input.transcript_path);
    case "opencode":
      return await loadOpencodeTranscript(input.session_id);
    default:
      console.error(
        `Unknown provider "${input.provider}", falling back to opencode transcript parser`,
      );
      return await loadOpencodeTranscript(input.session_id);
  }
}

async function loadClaudeTranscript(transcriptPath: string): Promise<NormalizedMessage[]> {
  const content = await Bun.file(transcriptPath).text();
  return parseClaudeCodeTranscript(content);
}

async function loadCodexTranscript(
  transcriptPath: string | undefined,
): Promise<NormalizedMessage[]> {
  if (!transcriptPath) return [];
  try {
    const content = await Bun.file(transcriptPath).text();
    return parseCodexTranscript(content);
  } catch {
    console.error(`Failed to read Codex transcript: ${transcriptPath}`);
    return [];
  }
}

async function loadPiTranscript(transcriptPath: string | undefined): Promise<NormalizedMessage[]> {
  if (!transcriptPath) {
    // Mirror loadClaudeTranscript's diagnostic — turns a miswired Pi hook
    // into a distinct stderr line instead of looking like an empty session.
    console.error("Pi session missing transcript_path");
    return [];
  }
  try {
    const content = await Bun.file(transcriptPath).text();
    return parsePiTranscript(content);
  } catch {
    console.error(`Failed to read Pi transcript: ${transcriptPath}`);
    return [];
  }
}

async function loadOpencodeTranscript(sessionId: string | undefined): Promise<NormalizedMessage[]> {
  if (!sessionId) return [];

  const result = await Bun.$`opencode export ${sessionId}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    console.error(`opencode export failed (exit ${result.exitCode})`);
    return [];
  }

  return parseOpencodeTranscript(result.stdout.toString());
}

/**
 * Save raw inference output to failed/ directory for debugging.
 */
async function saveFailedOutput(
  memoryDir: string,
  sessionId: string,
  rawOutput: string,
): Promise<void> {
  const failedDir = join(memoryDir, "sessions", "failed");
  await mkdir(failedDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${sessionId.slice(0, 8)}.txt`;
  const filePath = join(failedDir, filename);
  await Bun.write(filePath, rawOutput);
  console.error(`Saved raw output to ${filePath}`);
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * Spawn a session-end worker that can outlive the hook process.
 *
 * Bun cannot currently detach a child from its Windows job object
 * (oven-sh/bun#31603), so unref alone kills the worker when the dispatch
 * process exits. `cmd start` provides the required process breakaway.
 */
export async function spawnSessionEndWorker(tmpPath: string, logPath: string): Promise<void> {
  const stderr = Bun.file(logPath);

  if (process.platform === "win32") {
    const bootstrap = Bun.spawn(
      [
        "cmd.exe",
        "/d",
        "/c",
        "start",
        "",
        "/b",
        process.execPath,
        import.meta.path,
        WORKER_FLAG,
        tmpPath,
        "2>>",
        logPath,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      },
    );
    const exitCode = await bootstrap.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to launch detached session-end worker (exit ${exitCode})`);
    }
    return;
  }

  const proc = Bun.spawn([process.execPath, import.meta.path, WORKER_FLAG, tmpPath], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr,
  });
  proc.unref();
}

// ─── Dispatch (parent) ──────────────────────────────────────────────────────

/**
 * Dispatch mode: read stdin, write temp file, spawn background worker, exit 0.
 * This returns control to the CLI in milliseconds.
 */
async function dispatch() {
  if (isSubagent()) process.exit(0);

  const rawInput = await readStdin();
  if (!rawInput) {
    console.error("No input received");
    process.exit(0);
  }

  let input: SessionEndInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    console.error("Failed to parse stdin JSON");
    process.exit(0);
  }

  // Inject provider from --provider arg if not already set (Claude configurer passes this)
  const providerArgIdx = process.argv.indexOf("--provider");
  if (!input.provider && providerArgIdx !== -1) {
    input.provider = process.argv[providerArgIdx + 1];
  }

  const sessionId = input.session_id ?? "unknown";
  const shakaHome = resolveShakaHome();
  const memoryDir = join(shakaHome, "memory");
  await mkdir(memoryDir, { recursive: true });

  // Write enriched payload to temp file so the worker can read it
  const tmpPath = join(
    memoryDir,
    `.session-end-input-${sessionId.slice(0, 8)}-${process.pid}.json`,
  );
  await Bun.write(tmpPath, JSON.stringify(input));

  // Spawn detached worker — stderr goes to log file for diagnostics
  const logPath = join(memoryDir, ".session-end-worker.log");
  await spawnSessionEndWorker(tmpPath, logPath);
}

// ─── Worker ─────────────────────────────────────────────────────────────────

/**
 * Worker mode: read temp file, process transcript, write summary + learnings.
 * Runs as a detached background process — CLI is not waiting for this.
 */
async function worker(tmpPath: string) {
  const t0 = performance.now();
  const timings: string[] = [];

  function mark(label: string, startMs: number, detail = "") {
    const ms = elapsedMs(startMs);
    const line = `  [${ms}ms] ${label}${detail ? ` (${detail})` : ""}`;
    console.error(line);
    timings.push(line);
  }

  // Read input from temp file, then delete it
  const rawInput = await Bun.file(tmpPath).text();
  await unlink(tmpPath).catch(() => {});

  let input: SessionEndInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    console.error("Failed to parse temp file JSON");
    return;
  }

  const sessionId = input.session_id ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  const provider: ProviderName = isProviderName(input.provider) ? input.provider : "opencode";

  console.error(`Worker started: ${provider} session ${sessionId}`);

  const shakaHome = resolveShakaHome();
  const memoryDir = join(shakaHome, "memory");
  const date = new Date().toISOString().slice(0, 10);

  // Load and parse transcript
  let t = performance.now();
  const messages = await loadTranscript(input);
  if (messages.length === 0) {
    console.error("Empty transcript, skipping summarization");
    return;
  }
  mark("Loaded transcript", t, `${messages.length} messages`);

  // Truncate if needed
  const truncated = truncateTranscript(messages, MAX_TRANSCRIPT_CHARS);

  // Build metadata
  const metadata: SessionMetadata = {
    date,
    cwd,
    provider,
    sessionId,
  };

  // Prepare learning storage before title-driven inference. Summary writing remains fail-open.
  t = performance.now();
  const learningPreparation = await prepareLearningExtraction(memoryDir);
  const existingTitles = learningPreparation.existingTitles;
  mark("Loaded existing learnings", t, `${existingTitles.length} titles`);

  // Load existing knowledge topic titles for tag convergence (fail-open)
  t = performance.now();
  const knowledgeDir = await resolveKnowledgeProjectDir(memoryDir, cwd);
  const existingTopicTitles = await readExistingTopicTitles(knowledgeDir);
  mark("Loaded topic titles", t, `${existingTopicTitles.length} topics`);

  // Build prompt (single call produces summary + learnings + knowledge)
  const prompt = buildSummarizationPrompt(truncated, metadata, existingTitles, existingTopicTitles);

  // Call inference — pass the session's originating provider as a hint so
  // the dispatch target and the model string (resolved inside inference())
  // are always the same CLI, by construction.
  console.error(`  Calling inference (provider: ${provider})...`);
  t = performance.now();
  const result = await inference({
    userPrompt: prompt,
    provider,
    timeout: 60000,
  });
  mark("Inference complete", t, result.success ? "ok" : "failed");

  if (!result.success || !result.text) {
    console.error(`Inference failed: ${result.error ?? "no response"}`);
    return;
  }

  // Strip outer code fences if the LLM wrapped its entire response in ```markdown...```
  const rawOutput = result.text
    .trim()
    .replace(/^```\w*\n/, "")
    .replace(/\n```$/, "");

  // Parse the summary output (## Learnings section is stripped from body)
  const parsed = parseSummaryOutput(rawOutput);
  if (!parsed) {
    console.error("Failed to parse inference output as summary");
    await saveFailedOutput(memoryDir, sessionId, rawOutput);
    return;
  }

  // Use original metadata (not LLM's echo) to ensure deterministic filenames
  const summary = { ...parsed, metadata };

  // Write summary to disk
  t = performance.now();
  await writeSummary(memoryDir, summary);
  mark("Summary written", t);

  // Extract and write learnings (fail-open: summary already written)
  t = performance.now();
  const newLearningsCount = await extractAndWriteLearnings(
    rawOutput,
    metadata,
    memoryDir,
    learningPreparation.learningWriteAllowed,
  );
  mark("Learnings extraction", t, `${newLearningsCount} new`);

  // Update rolling summaries (fail-open: session summary already written)
  t = performance.now();
  const summaryText = `### ${summary.title}\n\n${summary.body}`;
  await updateRollups(memoryDir, summaryText, cwd, provider).catch((err: unknown) => {
    console.error(`Rollups update failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  mark("Rollups update", t);

  // Maintenance: consolidation, hierarchical generalization, and bounded auto-prune (fail-open)
  t = performance.now();
  try {
    const config = await loadConfig();
    if (config?.memory?.maintenance?.enabled !== false) {
      const maintenanceResult = await runMaintenance(memoryDir, cwd, newLearningsCount, {
        provider,
      });
      if (maintenanceResult.skipped) {
        mark("Maintenance skipped", t, maintenanceResult.reason ?? "");
      } else {
        const detail = [
          `condensed=${maintenanceResult.condensed ?? 0}`,
          `generalized=${maintenanceResult.generalized ?? 0}`,
          `pruned=${maintenanceResult.pruned ?? 0}`,
        ].join(", ");
        mark("Maintenance complete", t, detail);
      }
    } else {
      mark("Maintenance disabled", t);
    }
  } catch (err) {
    console.error(`Maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
    mark("Maintenance failed", t);
  }

  // Step 6: Knowledge compilation (own gating via manifest delta, fail-open)
  t = performance.now();
  try {
    const config = await loadConfig();
    if (config?.memory?.knowledge_enabled !== false) {
      const inferFn = async (prompt: string): Promise<string> => {
        const res = await inference({ userPrompt: prompt, provider, timeout: 60000 });
        if (!res.success || !res.text) throw new Error(res.error ?? "inference failed");
        return res.text;
      };
      const result = await compileKnowledge(memoryDir, cwd, inferFn);
      if (result.sessionsProcessed === 0) {
        mark("Knowledge compilation skipped", t, "no unprocessed sessions");
      } else {
        mark(
          "Knowledge compilation complete",
          t,
          `${result.topicsCreated.length} created, ${result.topicsUpdated.length} updated`,
        );
      }
    } else {
      mark("Knowledge compilation disabled", t);
    }
  } catch (err) {
    console.error(
      `Knowledge compilation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    mark("Knowledge compilation failed", t);
  }

  mark("Session-end worker total", t0, provider);

  // Write timing to file for diagnostics (non-blocking, fail-silent)
  const timingPath = join(memoryDir, ".timing-session-end.log");
  Bun.write(timingPath, `${new Date().toISOString()}\n${timings.join("\n")}\n`).catch(() => {});
}

/** Existing-title snapshot plus the write decision established before inference. */
export interface LearningExtractionPreparation {
  readonly existingTitles: readonly string[];
  readonly learningWriteAllowed: boolean;
}

export async function prepareLearningExtraction(
  memoryDir: string,
): Promise<LearningExtractionPreparation> {
  try {
    const readiness = await prepareLearningStoreForMutation(memoryDir, ["active"]);
    const active = readiness.active;
    if (!active) throw new Error("Active learning readiness was not established");
    return {
      existingTitles: active.document.entries.map((entry) => entry.title),
      learningWriteAllowed: true,
    };
  } catch (error) {
    console.error(
      `Learning storage readiness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { existingTitles: [], learningWriteAllowed: false };
  }
}

/**
 * Parse and commit the session's complete learning rewrite without affecting summary success.
 * Returns committed append, rewrite, and reinforcement outcomes for maintenance gating.
 */
export async function extractAndWriteLearnings(
  rawOutput: string,
  metadata: SessionMetadata,
  memoryDir: string,
  learningWriteAllowed: boolean,
): Promise<number> {
  try {
    const sessionHash = hashSessionId(metadata.sessionId);
    const extracted = parseExtractedLearnings(rawOutput);
    if (extracted.status === "missing") {
      console.error("Learnings extraction missing; preserving prior session contributions");
      return 0;
    }
    if (extracted.status === "malformed") {
      console.error(`Learnings extraction malformed: ${extracted.issues.join(" ")}`);
      return 0;
    }
    if (!learningWriteAllowed) {
      console.error("Learnings write disabled because storage readiness failed");
      return 0;
    }

    const validation = validateSessionRewriteInput(extracted.entries, {
      date: metadata.date,
      sessionHash,
      currentCwd: metadata.cwd,
    });
    if (!validation.ok) {
      console.error(
        `Learnings extraction malformed: ${validation.issues.map((issue) => issue.message).join(" ")}`,
      );
      return 0;
    }

    let committedCounts: SessionRewriteCounts | undefined;
    await mutateLearnings(memoryDir, (entries) => {
      const rewrite = rewriteSessionLearnings(entries, validation.extracted, validation.context);
      committedCounts = rewrite.counts;
      return [...rewrite.entries];
    });
    if (!committedCounts) throw new Error("Learning rewrite completed without outcome counts");
    const maintenanceEligible =
      committedCounts.appended + committedCounts.rewritten + committedCounts.reinforced;
    console.error(
      [
        "Committed learning rewrite",
        `appended=${committedCounts.appended}`,
        `rewritten=${committedCounts.rewritten}`,
        `reinforced=${committedCounts.reinforced}`,
        `suppressed=${committedCounts.suppressed}`,
        `ambiguous=${committedCounts.ambiguousTitles}`,
        `primary-exposures-removed=${committedCounts.primaryExposuresRemoved}`,
        `orphans-removed=${committedCounts.orphansRemoved}`,
        `durable-retained=${committedCounts.durableEntriesRetained}`,
      ].join(" "),
    );
    return maintenanceEligible;
  } catch (err) {
    console.error(
      `Learnings extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

if (import.meta.main) {
  const workerIdx = process.argv.indexOf(WORKER_FLAG);

  if (workerIdx !== -1) {
    // Worker mode: process the session in background
    const tmpPath = process.argv[workerIdx + 1];
    if (!tmpPath) {
      console.error("Worker mode requires a temp file path");
      process.exit(0);
    }
    worker(tmpPath).catch((err) => {
      console.error(
        `Session-end worker error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(0);
    });
  } else {
    // Dispatch mode: read stdin, spawn worker, exit immediately
    dispatch().catch((err) => {
      console.error(`Session-end hook error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(0);
    });
  }
}
