#!/usr/bin/env bun
/**
 * Shaka CLI entry point.
 * Composition root - all dependency wiring happens here.
 */

import { Command } from "commander";

// Re-export shared functionality for use by defaults/ templates
export {
  detectInstalledProviders,
  isProviderInstalled,
  clearDetectionCache,
  type DetectedProviders,
  type ProviderName,
} from "./services/provider-detection";

export {
  type ShakaConfig,
  type EnvVars,
  validateConfig,
  resolveShakaHome,
  loadConfig,
  loadShakaFile,
  isSubagent,
  getAssistantName,
  getPrincipalName,
  getSummarizationModel,
} from "./domain/config";

export {
  type Result,
  type Ok,
  type Err,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  flatMap,
} from "./domain/result";

export {
  type SessionStartEvent,
  type SessionStartEventInput,
  type SessionStartSource,
  type SessionEndEvent,
  type SessionEndEventInput,
  type ToolAfterEvent,
  type ToolAfterEventInput,
  type HandlerResult,
  createSessionStartEvent,
  isSessionStartEvent,
  createSessionEndEvent,
  isSessionEndEvent,
  createToolAfterEvent,
  isToolAfterEvent,
} from "./domain/events";

export { type HookEvent, HOOK_EVENTS } from "./providers/hook-discovery";

export {
  type NormalizedMessage,
  parseClaudeCodeTranscript,
  parseOpencodeTranscript,
  truncateTranscript,
} from "./memory/transcript";

export {
  type SessionMetadata,
  type SessionSummary,
  buildSummarizationPrompt,
  parseSummaryOutput,
} from "./memory/summarize";

export {
  type SummaryIndex,
  writeSummary,
  listSummaries,
  loadSummary,
  selectRecentSummaries,
} from "./memory/storage";

export { type SearchResult, searchMemory } from "./memory/search";

export {
  type LearningEntry,
  type LearningCategory,
  type Exposure,
  parseLearnings,
  renderEntry,
  renderLearnings,
  loadLearnings,
  writeLearnings,
  scoreEntry,
  selectLearnings,
  undoSessionLearnings,
  mergeNewLearnings,
  buildExtractionPromptSection,
  parseExtractedLearnings,
  hashSessionId,
} from "./memory/learnings";

export {
  type SemVer,
  type GitRef,
  parseSemver,
  compareSemver,
  isMajorUpgrade,
  getCurrentVersion,
  getGitRef,
  findLatestTag,
  findNewerLocalTag,
} from "./domain/version";

export {
  type InferenceOptions,
  type InferenceResult,
  inference,
  hasInferenceProvider,
} from "./inference";

export {
  matchesPattern,
  expandPath,
  matchesPathPattern,
  type Pattern,
  type PatternsConfig,
  type ValidationAction,
  type ValidationResult,
  validateBashCommand,
  validatePath,
  emptyPatternsConfig,
} from "./security";

// Import commands and version
import { createConfigCommand } from "./commands/config";
import { createDoctorCommand } from "./commands/doctor";
import { createInitCommand } from "./commands/init";
import { createMcpCommand } from "./commands/mcp";
import { createMemoryCommand } from "./commands/memory";
import { createReloadCommand } from "./commands/reload";
import { createUninstallCommand } from "./commands/uninstall";
import { createUpdateCommand } from "./commands/update";
import { getCurrentVersion } from "./domain/version";

// CLI - only run when executed directly, not when imported as library
if (import.meta.main) {
  const program = new Command();

  program.name("shaka").description("Personal AI assistant framework").version(getCurrentVersion());

  program.addCommand(createInitCommand());
  program.addCommand(createUpdateCommand());
  program.addCommand(createUninstallCommand());
  program.addCommand(createReloadCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createMemoryCommand());

  program.parse(process.argv);
}
