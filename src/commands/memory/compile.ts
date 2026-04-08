/**
 * CLI handler for `shaka memory compile`.
 *
 * Supports:
 * - `shaka memory compile` — standard knowledge compilation
 * - `shaka memory compile --bootstrap` — retroactive extraction from historical sessions
 */

import { inference } from "../../inference";
import { bootstrapKnowledge, compileKnowledge } from "../../memory/knowledge";

interface CompileOptions {
  readonly bootstrap?: boolean;
  readonly dryRun?: boolean;
  readonly batchSize?: string;
  readonly limit?: string;
}

/** Wrap the inference module as a simple prompt -> string function. */
async function infer(prompt: string): Promise<string> {
  const result = await inference({ userPrompt: prompt, timeout: 60000 });
  if (!result.success || !result.text?.trim()) {
    throw new Error(`Inference failed: ${result.error ?? "no response"}`);
  }
  return result.text;
}

export async function runCompile(
  memoryDir: string,
  cwd: string,
  options: CompileOptions,
): Promise<void> {
  if (options.bootstrap) {
    await runBootstrap(memoryDir, cwd, options);
  } else if (options.dryRun) {
    console.log(
      "--dry-run is only supported with --bootstrap. Use: shaka memory compile --bootstrap --dry-run",
    );
  } else {
    await runStandardCompile(memoryDir, cwd);
  }
}

async function runStandardCompile(memoryDir: string, cwd: string): Promise<void> {
  console.log("Compiling knowledge from session summaries...");

  const result = await compileKnowledge(memoryDir, cwd, infer);

  if (result.sessionsProcessed === 0) {
    console.log("No new sessions to compile.");
    return;
  }

  const parts: string[] = [];
  if (result.topicsCreated.length > 0) {
    parts.push(`${result.topicsCreated.length} topic(s) created`);
  }
  if (result.topicsUpdated.length > 0) {
    parts.push(`${result.topicsUpdated.length} topic(s) updated`);
  }

  console.log(
    `Compiled ${result.sessionsProcessed} session(s). ${parts.length > 0 ? `${parts.join(", ")}.` : "No topic changes."}`,
  );
}

async function runBootstrap(
  memoryDir: string,
  cwd: string,
  options: CompileOptions,
): Promise<void> {
  const batchSize = options.batchSize ? Number.parseInt(options.batchSize, 10) : undefined;
  const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    const result = await bootstrapKnowledge(memoryDir, cwd, infer, {
      batchSize,
      limit,
      dryRun: true,
    });
    console.log(
      `Found ${result.sessionsFound} session(s) without knowledge extraction. Use --bootstrap without --dry-run to process.`,
    );
    return;
  }

  console.log("Bootstrapping knowledge from historical sessions...");

  const result = await bootstrapKnowledge(memoryDir, cwd, infer, {
    batchSize,
    limit,
    onProgress: (batch, total, sessionCount) => {
      console.log(`Batch ${batch}/${total}: extracting from ${sessionCount} session(s)...`);
    },
  });

  if (result.sessionsProcessed === 0) {
    console.log("No sessions found without knowledge extraction.");
    return;
  }

  const topicParts: string[] = [];
  if (result.topicsCreated.length > 0) {
    topicParts.push(`${result.topicsCreated.length} topic(s) created`);
  }
  if (result.topicsUpdated.length > 0) {
    topicParts.push(`${result.topicsUpdated.length} topic(s) updated`);
  }
  const topicSummary =
    topicParts.length > 0 ? `Compiled into ${topicParts.join(", ")}.` : "No topic pages generated.";

  console.log(
    `Extracted ${result.fragmentsExtracted} fragment(s) from ${result.sessionsProcessed} session(s). ${topicSummary}`,
  );
}
