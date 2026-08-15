#!/usr/bin/env bun
/**
 * Security Validator Hook - PreToolUse validation
 *
 * Validates Bash commands and file operations against security patterns.
 * Prevents catastrophic operations, confirms dangerous ones.
 *
 * TRIGGER: tool.before (PreToolUse in Claude Code)
 * MATCHER: Bash, Edit, Write, Read
 *
 * Output:
 * - {"continue": true} → Allow operation
 * - {"decision": "ask", "message": "..."} → Prompt user
 * - exit(2) → Hard block (catastrophic)
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type PatternsConfig,
  type ValidationResult,
  emptyPatternsConfig,
  resolveShakaHome,
  validateBashCommand,
  validatePath,
} from "shaka";
import { parse as parseYaml } from "yaml";

/** Hook trigger events */
export const TRIGGER = ["tool.before"] as const;

/** Tool matchers - which tools this hook validates */
export const MATCHER = ["Bash", "Edit", "Write", "Read"] as const;

export const HOOK_VERSION = "0.3.0";

// Types
interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown> | string;
}

interface SecurityEvent {
  timestamp: string;
  session_id: string;
  event_type: "block" | "confirm" | "alert" | "allow";
  tool: string;
  target: string;
  reason?: string;
}

interface FileOperation {
  path: string;
  operation: "write" | "delete";
}

type PatchDirectiveKind = "add" | "delete" | "update" | "move";

interface PatchDirective {
  kind: PatchDirectiveKind;
  path: string;
}

const PATCH_DIRECTIVES: ReadonlyArray<readonly [string, PatchDirectiveKind]> = [
  ["*** Add File: ", "add"],
  ["*** Delete File: ", "delete"],
  ["*** Update File: ", "update"],
  ["*** Move to: ", "move"],
];

// Config loading with caching
let patternsCache: PatternsConfig | null = null;

function loadPatterns(shakaHome: string): PatternsConfig {
  if (patternsCache) return patternsCache;

  // Try customizations first, then system
  const customPath = join(shakaHome, "customizations", "security", "patterns.yaml");
  const systemPath = join(shakaHome, "system", "security", "patterns.yaml");

  const patternsPath = existsSync(customPath)
    ? customPath
    : existsSync(systemPath)
      ? systemPath
      : null;

  if (!patternsPath) {
    return emptyPatternsConfig();
  }

  try {
    const content = readFileSync(patternsPath, "utf-8");
    patternsCache = parseYaml(content) as PatternsConfig;
    return patternsCache;
  } catch {
    return emptyPatternsConfig();
  }
}

// Logging
function logSecurityEvent(shakaHome: string, event: SecurityEvent): void {
  let temporaryPath: string | undefined;

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");

    const securityDir = join(shakaHome, "memory", "security");
    const yearDir = join(securityDir, String(year));
    const logDir = join(yearDir, month);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== "win32") {
      for (const directory of [securityDir, yearDir, logDir]) {
        chmodSync(directory, 0o700);
      }
    }

    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const eventName = `security-${event.event_type}-${timestamp}-${randomUUID()}`;
    const logPath = join(logDir, `${eventName}.json`);
    temporaryPath = join(logDir, `.${eventName}.tmp`);

    writeFileSync(temporaryPath, JSON.stringify(event, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, logPath);
    temporaryPath = undefined;
  } catch {
    // Logging failure should not block operations
  } finally {
    if (temporaryPath) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup after a logging failure
      }
    }
  }
}

// Tool handlers
function handleBash(input: HookInput, shakaHome: string, patterns: PatternsConfig): void {
  const command =
    typeof input.tool_input === "string"
      ? input.tool_input
      : ((input.tool_input?.command as string) ?? "");

  if (!command) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const result = validateBashCommand(command, patterns);
  handleValidationResult(input, "Bash", command, result, shakaHome);
}

function handleFileOperation(
  input: HookInput,
  tool: string,
  operation: "read" | "write",
  shakaHome: string,
  patterns: PatternsConfig,
): void {
  const filePath =
    typeof input.tool_input === "string"
      ? input.tool_input
      : ((input.tool_input?.file_path as string) ?? "");

  if (!filePath) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const result = validatePath(filePath, operation, patterns);
  handleValidationResult(input, tool, filePath, result, shakaHome);
}

function parseApplyPatchOperations(command: string): FileOperation[] {
  const operations: FileOperation[] = [];
  let currentUpdate: { index: number; path: string } | null = null;

  for (const line of applyPatchBody(command)) {
    const directive = parsePatchDirective(line);
    if (!directive) continue;

    switch (directive.kind) {
      case "add":
        operations.push({ path: directive.path, operation: "write" });
        currentUpdate = null;
        break;
      case "delete":
        operations.push({ path: directive.path, operation: "delete" });
        currentUpdate = null;
        break;
      case "update":
        currentUpdate = { index: operations.length, path: directive.path };
        operations.push({ path: directive.path, operation: "write" });
        break;
      case "move":
        if (!currentUpdate) break;
        operations[currentUpdate.index] = { path: currentUpdate.path, operation: "delete" };
        operations.push({ path: directive.path, operation: "write" });
        currentUpdate = null;
        break;
    }
  }

  return operations;
}

function applyPatchBody(command: string): string[] {
  const lines = command.split(/\r?\n/);
  const start = lines.indexOf("*** Begin Patch");
  if (start === -1) return [];
  const end = lines.indexOf("*** End Patch", start + 1);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function parsePatchDirective(line: string): PatchDirective | null {
  const directive = PATCH_DIRECTIVES.find(([prefix]) => line.startsWith(prefix));
  if (!directive) return null;
  const [prefix, kind] = directive;
  const path = line.slice(prefix.length).trim();
  return path ? { kind, path } : null;
}

function handleApplyPatch(input: HookInput, shakaHome: string, patterns: PatternsConfig): void {
  const command =
    typeof input.tool_input === "string"
      ? input.tool_input
      : ((input.tool_input?.command as string) ?? "");
  const operations = parseApplyPatchOperations(command);

  if (operations.length === 0) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const validations = operations.map((operation) => ({
    ...operation,
    result: validatePath(operation.path, operation.operation, patterns),
  }));
  const selected =
    validations.find(({ result }) => result.action === "block") ??
    validations.find(({ result }) => result.action === "confirm") ??
    validations.find(({ result }) => result.action === "alert") ??
    validations[0];

  if (!selected) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  handleValidationResult(input, "apply_patch", selected.path, selected.result, shakaHome);
}

function handleValidationResult(
  input: HookInput,
  tool: string,
  target: string,
  result: ValidationResult,
  shakaHome: string,
): void {
  const event: SecurityEvent = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    event_type: result.action,
    tool,
    target: target.slice(0, 500),
    reason: result.reason,
  };

  switch (result.action) {
    case "block":
      logSecurityEvent(shakaHome, event);
      console.error(`[SHAKA SECURITY] BLOCKED: ${result.reason}`);
      console.error(`Target: ${target.slice(0, 100)}`);
      process.exit(2);
      break; // unreachable, but satisfies linter

    case "confirm":
      logSecurityEvent(shakaHome, event);
      console.log(
        JSON.stringify({
          decision: "ask",
          message: `[SHAKA SECURITY] ${result.reason}\n\nTarget: ${target.slice(0, 200)}`,
        }),
      );
      break;

    case "alert":
      logSecurityEvent(shakaHome, event);
      console.error(`[SHAKA SECURITY] Alert: ${result.reason}`);
      console.log(JSON.stringify({ continue: true }));
      break;

    default:
      console.log(JSON.stringify({ continue: true }));
  }
}

// Main
async function main(): Promise<void> {
  let input: HookInput;

  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
    ]);

    if (!text.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    input = JSON.parse(text);
  } catch {
    // Parse error or timeout - fail open
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const shakaHome = resolveShakaHome();
  const patterns = loadPatterns(shakaHome);

  switch (input.tool_name) {
    case "Bash":
      handleBash(input, shakaHome, patterns);
      break;
    case "Edit":
    case "MultiEdit":
    case "Write":
      handleFileOperation(input, input.tool_name, "write", shakaHome, patterns);
      break;
    case "Read":
      handleFileOperation(input, "Read", "read", shakaHome, patterns);
      break;
    case "apply_patch":
      handleApplyPatch(input, shakaHome, patterns);
      break;
    default:
      console.log(JSON.stringify({ continue: true }));
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Fail open on any error
    console.log(JSON.stringify({ continue: true }));
  });
}
