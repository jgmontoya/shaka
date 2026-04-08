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
  type SessionMetadata,
  buildSummarizationPrompt,
  compileKnowledge,
  getSummarizationModel,
  hashSessionId,
  inference,
  isSubagent,
  loadConfig,
  loadLearnings,
  mergeNewLearnings,
  parseClaudeCodeTranscript,
  parseExtractedLearnings,
  parseOpencodeTranscript,
  parseSummaryOutput,
  projectSlug,
  readExistingTopicTitles,
  resolveShakaHome,
  runMaintenance,
  truncateTranscript,
  undoSessionLearnings,
  updateRollups,
  writeLearnings,
  writeSummary,
} from "shaka";

/** Hook trigger events — Shaka canonical names */
export const TRIGGER = ["session.end"] as const;
export const HOOK_VERSION = "0.2.0";

/** Max transcript chars to send to inference (avoid token limits) */
const MAX_TRANSCRIPT_CHARS = 100_000;

/** CLI flag that switches to worker mode */
const WORKER_FLAG = "--worker";

interface SessionEndInput {
  session_id?: string;
  transcript_path?: string;
  reason?: string;
  cwd?: string;
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
 * Claude Code: read transcript_path directly from disk.
 * opencode: spawn `opencode export <sessionId>` to get transcript.
 */
async function loadTranscript(input: SessionEndInput): Promise<NormalizedMessage[]> {
  if (typeof input.transcript_path === "string") {
    return await loadClaudeTranscript(input.transcript_path);
  }
  return await loadOpencodeTranscript(input.session_id);
}

async function loadClaudeTranscript(transcriptPath: string): Promise<NormalizedMessage[]> {
  const content = await Bun.file(transcriptPath).text();
  return parseClaudeCodeTranscript(content);
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

  const sessionId = input.session_id ?? "unknown";
  const shakaHome = resolveShakaHome();
  const memoryDir = join(shakaHome, "memory");
  await mkdir(memoryDir, { recursive: true });

  // Write stdin payload to temp file so the worker can read it
  const tmpPath = join(
    memoryDir,
    `.session-end-input-${sessionId.slice(0, 8)}-${process.pid}.json`,
  );
  await Bun.write(tmpPath, rawInput);

  // Spawn detached worker — stderr goes to log file for diagnostics
  const logPath = join(memoryDir, ".session-end-worker.log");
  const proc = Bun.spawn(["bun", import.meta.path, WORKER_FLAG, tmpPath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(logPath),
  });
  proc.unref();

  console.error(`[session-end] Dispatched worker for session ${sessionId}`);
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
  const isClaudeCode = "transcript_path" in input && typeof input.transcript_path === "string";
  const provider = isClaudeCode ? "claude" : "opencode";

  console.error(`Worker started: ${provider} session ${sessionId}`);

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
    date: new Date().toISOString().split("T")[0] ?? new Date().toISOString(),
    cwd,
    provider,
    sessionId,
  };

  const shakaHome = resolveShakaHome();
  const memoryDir = join(shakaHome, "memory");

  // Load existing learnings for title matching in extraction prompt
  t = performance.now();
  const existingLearnings = await loadLearnings(memoryDir);
  const existingTitles = existingLearnings.map((e) => e.title);
  mark("Loaded existing learnings", t, `${existingTitles.length} titles`);

  // Load existing knowledge topic titles for tag convergence (fail-open)
  t = performance.now();
  const knowledgeDir = join(memoryDir, "knowledge", projectSlug(cwd));
  const existingTopicTitles = await readExistingTopicTitles(knowledgeDir);
  mark("Loaded topic titles", t, `${existingTopicTitles.length} topics`);

  // Build prompt (single call produces summary + learnings + knowledge)
  const prompt = buildSummarizationPrompt(truncated, metadata, existingTitles, existingTopicTitles);

  // Call inference
  const model = await getSummarizationModel(provider);
  console.error(`  Calling inference${model ? ` (model: ${model})` : ""}...`);
  t = performance.now();
  const result = await inference({
    userPrompt: prompt,
    model,
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
  const newLearningsCount = await extractAndWriteLearnings(rawOutput, metadata, memoryDir);
  mark("Learnings extraction", t, `${newLearningsCount} new`);

  // Update rolling summaries (fail-open: session summary already written)
  t = performance.now();
  const summaryText = `### ${summary.title}\n\n${summary.body}`;
  await updateRollups(memoryDir, summaryText, cwd, model).catch((err: unknown) => {
    console.error(`Rollups update failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  mark("Rollups update", t);

  // Maintenance: consolidation, auto-promote, auto-prune (fail-open)
  t = performance.now();
  try {
    const config = await loadConfig();
    if (config?.memory?.maintenance?.enabled !== false) {
      const maintenanceResult = await runMaintenance(memoryDir, cwd, newLearningsCount);
      if (maintenanceResult.skipped) {
        mark("Maintenance skipped", t, maintenanceResult.reason ?? "");
      } else {
        const detail = [
          `condensed=${maintenanceResult.condensed ?? 0}`,
          `promoted=${maintenanceResult.promoted ?? 0}`,
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
      const compilationModel = await getSummarizationModel(provider);
      const inferFn = async (prompt: string): Promise<string> => {
        const res = await inference({ userPrompt: prompt, model: compilationModel, timeout: 60000 });
        if (!res.success || !res.text) throw new Error(res.error ?? "inference failed");
        return res.text;
      };
      const result = await compileKnowledge(memoryDir, cwd, inferFn);
      if (result.sessionsProcessed === 0) {
        mark("Knowledge compilation skipped", t, "no unprocessed sessions");
      } else {
        mark("Knowledge compilation complete", t, `${result.topicsCreated.length} created, ${result.topicsUpdated.length} updated`);
      }
    } else {
      mark("Knowledge compilation disabled", t);
    }
  } catch (err) {
    console.error(`Knowledge compilation failed: ${err instanceof Error ? err.message : String(err)}`);
    mark("Knowledge compilation failed", t);
  }

  mark("Session-end worker total", t0, provider);

  // Write timing to file for diagnostics (non-blocking, fail-silent)
  const timingPath = join(memoryDir, ".timing-session-end.log");
  Bun.write(timingPath, `${new Date().toISOString()}\n${timings.join("\n")}\n`).catch(() => {});
}

/**
 * Extract learnings from inference output and write to learnings.md.
 * Fail-open: any error is logged but does not affect the summary.
 * Returns the number of learnings extracted (0 on failure).
 */
async function extractAndWriteLearnings(
  rawOutput: string,
  metadata: SessionMetadata,
  memoryDir: string,
): Promise<number> {
  try {
    const sessionHash = hashSessionId(metadata.sessionId);
    const extracted = parseExtractedLearnings(rawOutput, {
      date: metadata.date,
      cwd: metadata.cwd,
      sessionHash,
    });

    if (extracted.length === 0) {
      console.error("No learnings extracted from this session");
      return 0;
    }

    // Load, undo previous extractions from this session, merge new
    let entries = await loadLearnings(memoryDir);
    entries = undoSessionLearnings(entries, sessionHash);
    entries = mergeNewLearnings(entries, extracted);

    await writeLearnings(memoryDir, entries);
    console.error(`Wrote ${extracted.length} learning(s) to learnings.md`);
    return extracted.length;
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
