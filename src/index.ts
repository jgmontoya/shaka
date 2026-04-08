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
  resolveDefaultsUserDir,
  isUnmodifiedTemplate,
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
  type KnowledgeFragment,
  buildSummarizationPrompt,
  parseSummaryOutput,
  parseExtractedKnowledge,
} from "./memory/summarize";

export {
  readExistingTopicTitles,
  loadKnowledgeIndex,
  compileKnowledge,
  bootstrapKnowledge,
  type CompilationResult,
  type KnowledgeManifest,
  type BootstrapOptions,
  type BootstrapResult,
} from "./memory/knowledge";

export {
  type SummaryIndex,
  writeSummary,
  listSummaries,
  loadSummary,
  selectRecentSummaries,
  renderSessionSection,
} from "./memory/storage";

export { type SearchFilter, type SearchResult, searchMemory } from "./memory/search";

export {
  type Rollup,
  type RollupPeriod,
  projectSlug,
  projectDir,
  needsRollover,
  parseRollupFile,
  serializeRollup,
  buildDailyUpdatePrompt,
  buildFoldPrompt,
  gatherTodaySessions,
  updateRollups,
  loadRollups,
  todayDateString,
  isoWeekString,
  currentIsoWeek,
  currentMonth,
} from "./memory/rollups";

export {
  type LearningEntry,
  type LearningCategory,
  type Exposure,
  ARCHIVE_FILE,
  parseLearnings,
  renderEntry,
  renderLearnings,
  loadLearnings,
  writeLearnings,
  appendToArchive,
  scoreEntry,
  selectLearnings,
  undoSessionLearnings,
  mergeNewLearnings,
  buildExtractionPromptSection,
  parseExtractedLearnings,
  hashSessionId,
} from "./memory/learnings";

export {
  type InferenceOptions,
  type InferenceResult,
  inference,
  hasInferenceProvider,
} from "./inference";

export {
  type MaintenanceResult,
  runMaintenance,
} from "./memory/maintenance";

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

export { expandTilde, normalizeCwd } from "./domain/paths";

export type {
  Workflow,
  WorkflowStep,
  CommandStep,
  PromptStep,
  RunStep,
  GroupStep,
  StepResult,
  RunMetadata,
} from "./domain/workflow";

export { discoverWorkflows } from "./providers/workflow-discovery";

export {
  type AgentExecutionOptions,
  type AgentExecutionResult,
  runAgentStep,
} from "./domain/agent-execution";

// Import commands and version
import { createCommandsCommand } from "./commands/commands";
import { createConfigCommand } from "./commands/config";
import { createDoctorCommand } from "./commands/doctor";
import { createInitCommand } from "./commands/init";
import { createMcpCommand } from "./commands/mcp";
import { createMemoryCommand } from "./commands/memory";
import { createReloadCommand } from "./commands/reload";
import { createRunCommand } from "./commands/run";
import { createScanCommand } from "./commands/scan";
import { createSkillCommand } from "./commands/skill";
import { createUninstallCommand } from "./commands/uninstall";
import { createUpdateCommand } from "./commands/update";
import { getCurrentVersion } from "./domain/version";
import { registerDefaultProviders } from "./services/skill-source";

// CLI - only run when executed directly, not when imported as library
if (import.meta.main) {
  registerDefaultProviders();
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
  program.addCommand(createCommandsCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createScanCommand());
  program.addCommand(createSkillCommand());

  program.parse(process.argv);
}
