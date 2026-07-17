import type { DiscoveredHook } from "../hook-discovery";
import type { ToolManifest } from "../tool-manifest";
import type { InstallConfig } from "../types";
import { renderOpencodeToolSchema } from "./tool-schema";

function renderOpencodeTools(manifests: readonly ToolManifest[]): string {
  return manifests
    .map(
      (manifest) => `      ${JSON.stringify(manifest.name)}: tool({
        description: ${JSON.stringify(manifest.description)},
        args: ${renderOpencodeToolSchema(manifest.inputSchema)},
        execute: async (args) => runShakaTool(${JSON.stringify(manifest.name)}, args as Record<string, unknown>),
      })`,
    )
    .join(",\n");
}

export function renderOpencodePlugin(
  config: InstallConfig,
  hooks: DiscoveredHook[],
  manifests: readonly ToolManifest[],
): string {
  // Group hooks by Shaka canonical event names
  const sessionStartHooks = hooks.filter((h) => h.event === "session.start");
  const sessionEndHooks = hooks.filter((h) => h.event === "session.end");
  const userPromptHooks = hooks.filter((h) => h.event === "prompt.submit");
  const preToolHooks = hooks.filter((h) => h.event === "tool.before");
  const postToolHooks = hooks.filter((h) => h.event === "tool.after");

  // Build matcher maps for tool hooks: { hookPath: matchers[] | null }
  const preToolHookMatchers = preToolHooks.map((h) => ({
    path: h.path,
    matchers: h.matchers ?? null,
  }));
  const postToolHookMatchers = postToolHooks.map((h) => ({
    path: h.path,
    matchers: h.matchers ?? null,
  }));

  return `/**
 * Shaka plugin for opencode.
 * Auto-generated - do not edit manually.
 *
 * Discovered hooks:
${hooks.map((h) => ` *   - ${h.filename} (${h.event}${h.matchers ? `, matchers: ${h.matchers.join(", ")}` : ""})`).join("\n")}
 */

// opencode tool args use a zod ZodRawShape (flat record of zod schemas),
// not JSON Schema. Routing through @opencode-ai/plugin's re-export keeps us
// pinned to the same zod major the host runtime uses (Exp 53 confirmed
// JSON Schema args crash opencode with \`undefined is not an object
// (evaluating 'n._zod.def')\`).
import { tool } from "@opencode-ai/plugin";
const z = tool.schema;

const SHAKA_HOME = ${JSON.stringify(config.shakaHome)};
const IDLE_SUMMARY_DELAY = 15_000;

interface ClaudeHookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface ClaudeHookOutput {
  continue?: boolean;
  decision?: "ask";
  message?: string;
  hookSpecificOutput?: {
    additionalContext?: string;
  };
}

interface ToolHookConfig {
  path: string;
  matchers: string[] | null;
}

const PRE_TOOL_HOOKS: ToolHookConfig[] = ${JSON.stringify(preToolHookMatchers, null, 2)};
const POST_TOOL_HOOKS: ToolHookConfig[] = ${JSON.stringify(postToolHookMatchers, null, 2)};

/**
 * Normalize opencode tool names/args to Claude Code format.
 * opencode uses lowercase tool names and camelCase args;
 * Claude Code hooks expect PascalCase names and snake_case args.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

const ARGS_KEY_MAP: Record<string, Record<string, string>> = {
  read: { filePath: "file_path" },
  write: { filePath: "file_path", content: "content" },
  edit: { filePath: "file_path" },
  bash: { command: "command" },
};

function normalizeToolName(opencodeName: string): string {
  return TOOL_NAME_MAP[opencodeName] || opencodeName;
}

function normalizeArgs(opencodeTool: string, args: Record<string, unknown>): Record<string, unknown> {
  const keyMap = ARGS_KEY_MAP[opencodeTool];
  if (!keyMap) return args;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[keyMap[key] || key] = value;
  }
  return normalized;
}

/**
 * Run a hook script and capture its output.
 * Returns { exitCode, output } for proper handling.
 */
const HOOK_TIMEOUT_MS = 30_000;
const HOOK_KILL_GRACE_MS = 500;

interface BoundedProcessOptions {
  stdin: Blob;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  killGraceMs: number;
}

interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface BufferedReadableStream {
  done: Promise<void>;
  text(): string;
  cancel(): Promise<void>;
}

function bufferReadableStream(stream: ReadableStream<Uint8Array> | null): BufferedReadableStream {
  const reader = stream?.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let settled = false;

  const done = (async () => {
    if (!reader) return;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Reader cancellation is the expected timeout path.
    } finally {
      chunks.push(decoder.decode());
      settled = true;
    }
  })();

  return {
    done,
    text: () => chunks.join(""),
    cancel: async () => {
      if (!reader || settled) return;
      await reader.cancel().catch(() => {});
    },
  };
}

async function runBoundedProcess(
  command: string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const proc = Bun.spawn(command, {
    env: options.env,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let exited = false;
  let exitCode = 1;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stdout = bufferReadableStream(proc.stdout);
  const stderr = bufferReadableStream(proc.stderr);

  const processExited = proc.exited
    .then((code) => {
      exited = true;
      exitCode = code ?? 1;
    })
    .catch(() => {
      exited = true;
      exitCode = 1;
    });

  let settleAfterKillGraceResolve: (result: "timedOut") => void = () => {};
  const settleAfterKillGrace = new Promise<"timedOut">((resolve) => {
    settleAfterKillGraceResolve = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!exited) proc.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!exited) proc.kill("SIGKILL");
      settleAfterKillGraceResolve("timedOut");
    }, options.killGraceMs);
    killTimer.unref?.();
  }, options.timeoutMs);
  timer.unref?.();

  try {
    const completed = Promise.all([processExited, stdout.done, stderr.done]).then(
      () => "completed" as const,
    );
    const settled = await Promise.race([completed, settleAfterKillGrace]);

    if (settled === "timedOut") {
      await Promise.all([stdout.cancel(), stderr.cancel()]);
    }
    if (timedOut) exitCode = 1;

    return { stdout: stdout.text(), stderr: stderr.text(), exitCode, timedOut };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

async function runHookRaw(hookPath: string, input: unknown = {}): Promise<{ exitCode: number; output: ClaudeHookOutput | null; rawOutput: string }> {
  try {
    const result = await runBoundedProcess(["bun", hookPath], {
      stdin: new Blob([JSON.stringify(input)]),
      timeoutMs: HOOK_TIMEOUT_MS,
      killGraceMs: HOOK_KILL_GRACE_MS,
    });

    if (result.stderr.trim()) {
      console.error(\`[shaka] hook stderr (\${hookPath}): \${result.stderr.trimEnd()}\`);
    }
    if (result.timedOut) {
      return {
        exitCode: 1,
        output: null,
        rawOutput: \`Hook timed out after \${HOOK_TIMEOUT_MS}ms\`,
      };
    }

    // Try to parse as JSON; hooks may output plain text instead
    let output: ClaudeHookOutput | null = null;
    try {
      output = JSON.parse(result.stdout.trim()) as ClaudeHookOutput;
    } catch {
      // Not JSON — plain text output, available via rawOutput
    }

    return { exitCode: result.exitCode, output, rawOutput: result.stdout.trim() };
  } catch (error) {
    console.error(\`[shaka] Error running hook \${hookPath}:\`, error);
    return { exitCode: 1, output: null, rawOutput: "" };
  }
}

/**
 * Bridge to \`shaka tool <name>\` — runs a Shaka system or customizations tool
 * and returns its stdout as the tool result. Tool defs live under
 * \${shakaHome}/system/tools/ (canonical) and \${shakaHome}/customizations/tools/
 * (overrides); \`shaka tool\` does the resolution + execution. This keeps tool
 * code in one place across providers.
 */
// Honors SHAKA_BIN for the same reasons Pi's extension does — when Shaka
// invokes opencode as a subprocess it can pin the bridge to its own binary;
// integration tests use it to point at a stub on a private path.
const SHAKA_BIN = process.env.SHAKA_BIN ?? "shaka";

// Live-path budget. Generous enough for real \`inference\` calls (which can
// take tens of seconds), tight enough that a hung subprocess never wedges
// the model turn waiting for a tool result that won't come. Mirrors the
// Pi extension's TOOL_TIMEOUT_MS.
const TOOL_TIMEOUT_MS = 60_000;

// SIGTERM is the polite ask; SIGKILL is the guarantee. A shaka subprocess
// that traps or ignores SIGTERM would otherwise keep the model turn waiting
// on proc.exited forever -- same escalation pattern as runAgentStep.
const TOOL_KILL_GRACE_MS = 500;

async function runShakaTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await runBoundedProcess([SHAKA_BIN, "tool", name], {
      // Forward the install-time SHAKA_HOME so tool resolution targets the
      // install this plugin was generated for, not whatever ambient
      // environment opencode happens to be running under.
      env: { ...process.env, SHAKA_HOME },
      stdin: new Blob([JSON.stringify(args)]),
      timeoutMs: TOOL_TIMEOUT_MS,
      killGraceMs: TOOL_KILL_GRACE_MS,
    });
    if (result.timedOut) {
      return \`Error: shaka tool \${name} timed out after \${TOOL_TIMEOUT_MS}ms\`;
    }
    if (result.exitCode !== 0) {
      return \`Error: shaka tool \${name} exited \${result.exitCode}: \${result.stderr.trim()}\`;
    }
    return result.stdout;
  } catch (error) {
    return \`Error: shaka tool \${name} spawn failed: \${error instanceof Error ? error.message : String(error)}\`;
  }
}

/**
 * Check if a hook should run for a given tool.
 * Hooks without matchers run for all tools.
 * Hooks with matchers only run for matching tools.
 */
function shouldRunForTool(hook: ToolHookConfig, toolName: string): boolean {
  if (!hook.matchers) return true;
  return hook.matchers.includes(toolName);
}

/**
 * Extract the user's prompt text from an opencode message part array.
 * Filters to text parts only, skipping synthetic parts that opencode
 * injects itself (not user-written). Joins with newlines if there are
 * multiple text parts in a single message.
 */
function extractPromptText(
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>,
): string {
  return parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text ?? "")
    .join("\\n")
    .trim();
}

/**
 * Shaka plugin entry point.
 * opencode calls this function once at load time;
 * it must return a Hooks object.
 */
export const ShakaPlugin = async (ctx: { directory: string; [key: string]: unknown }) => {
  // Session start context (loaded once at plugin init)
  let sessionContext: string | null = null;
  let sessionId = \`opencode-\${Date.now()}\`;
${sessionEndHooks.length > 0 ? "  let idleTimer: Timer | null = null;" : ""}
${
  userPromptHooks.length > 0
    ? `
  // Cache of the most recent user prompt text, keyed by sessionID. Populated
  // by the chat.message hook (which opencode fires in prompt.ts when a new
  // user message is received — BEFORE experimental.chat.system.transform
  // fires in llm.ts). Consumed by the transform handler below to run
  // UserPromptSubmit hooks with { prompt } stdin in Claude Code's shape.
  const latestUserPromptBySession = new Map<string, string>();`
    : ""
}

${
  sessionStartHooks.length > 0
    ? `
  // Load session context from SessionStart hooks
  const sessionHooks = ${JSON.stringify(sessionStartHooks.map((h) => h.path))};
  const contextParts: string[] = [];

  for (const hookPath of sessionHooks) {
    const { exitCode, output, rawOutput } = await runHookRaw(hookPath);
    if (exitCode !== 0) continue;
    if (output?.hookSpecificOutput?.additionalContext) {
      contextParts.push(output.hookSpecificOutput.additionalContext);
    } else if (rawOutput) {
      contextParts.push(rawOutput);
    }
  }

  sessionContext = contextParts.join("\\n\\n");
  if (sessionContext) {
    console.error("[shaka] Session context loaded");
  }
`
    : "  // No SessionStart hooks discovered"
}

  return {
    // Shaka tools — surface the resolved canonical tool set as native
    // opencode custom tools so the model can call them mid-session.
    // Execution shells to \`shaka tool <name>\`; tool defs live in one place
    // (defaults/system/tools/) for every provider that wants to expose them.
    tool: {
${renderOpencodeTools(manifests)}
    },
${
  userPromptHooks.length > 0
    ? `
    // Cache the user's prompt text when a new message arrives. This fires
    // in opencode's prompt.ts pipeline BEFORE experimental.chat.system.transform,
    // so the cached text is available when the transform hook below wants to
    // run UserPromptSubmit hooks with a Claude Code-shaped { prompt } stdin.
    "chat.message": async (
      input: { sessionID: string; [key: string]: unknown },
      output: { parts: Array<{ type: string; text?: string; synthetic?: boolean }> }
    ) => {
      const text = extractPromptText(output.parts);
      if (text) latestUserPromptBySession.set(input.sessionID, text);
    },
`
    : ""
}${
  userPromptHooks.length > 0 || sessionStartHooks.length > 0
    ? `
    // Context injection
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; [key: string]: unknown },
      output: { system: string[] }
    ) => {
      // Add session context if available
      if (sessionContext) {
        output.system.push(sessionContext);
      }

      ${
        userPromptHooks.length > 0
          ? `
      // Run UserPromptSubmit hooks with { prompt } stdin (Claude Code shape).
      // Source the prompt from the cache populated by the chat.message hook —
      // opencode's transform input doesn't expose the user's message text.
      //
      // Delete-on-consume: we drop the cache entry after running hooks so
      // (a) long-lived processes (TUI/desktop) don't accumulate stale prompts
      // across sessions, and (b) tool-call continuations that re-fire the
      // transform in the same turn don't re-run classification — format-reminder
      // should classify the user's intent once per turn, not once per LLM
      // round trip.
      const cachedPrompt = input.sessionID
        ? latestUserPromptBySession.get(input.sessionID)
        : undefined;
      if (cachedPrompt && input.sessionID) {
        latestUserPromptBySession.delete(input.sessionID);
        const hooks = ${JSON.stringify(userPromptHooks.map((h) => h.path))};
        const hookInput = { prompt: cachedPrompt };
        for (const hookPath of hooks) {
          const { output: hookOutput, rawOutput } = await runHookRaw(hookPath, hookInput);
          if (hookOutput?.hookSpecificOutput?.additionalContext) {
            output.system.push(hookOutput.hookSpecificOutput.additionalContext);
          } else if (rawOutput) {
            output.system.push(rawOutput);
          }
        }
      }
      `
          : ""
      }
    },
`
    : ""
}

${
  preToolHooks.length > 0
    ? `
    // Tool execution hooks with matcher filtering and format normalization
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      const claudeToolName = normalizeToolName(input.tool);
      const claudeArgs = normalizeArgs(input.tool, output.args);

      // Normalize opencode format → Claude Code format
      const claudeInput: ClaudeHookInput = {
        session_id: input.sessionID || sessionId,
        tool_name: claudeToolName,
        tool_input: claudeArgs,
      };

      for (const hook of PRE_TOOL_HOOKS) {
        // Filter by matcher (using normalized Claude Code tool name)
        if (!shouldRunForTool(hook, claudeToolName)) continue;

        const { exitCode, output: hookOutput } = await runHookRaw(hook.path, claudeInput);

        // Handle Claude Code output format → opencode format
        // exit(2) = hard block — throw to abort tool execution
        if (exitCode === 2) {
          throw new Error("[SHAKA SECURITY] Operation blocked by security policy");
        }

        // { decision: "ask" } = confirm (log warning, let opencode's permission system handle)
        if (hookOutput?.decision === "ask") {
          console.error(\`[SHAKA SECURITY] Warning: \${hookOutput.message || "Operation flagged for review"}\`);
          // Don't abort - let opencode's native permission system prompt if configured
        }

        // { continue: true } = allow, keep going
        // null/error = fail open, keep going
      }
    },
`
    : ""
}

${
  postToolHooks.length > 0
    ? `
    // Post-tool execution hooks
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      const claudeToolName = normalizeToolName(input.tool);
      const claudeArgs = normalizeArgs(input.tool, output.args);

      const claudeInput: ClaudeHookInput = {
        session_id: input.sessionID || sessionId,
        tool_name: claudeToolName,
        tool_input: claudeArgs,
      };

      for (const hook of POST_TOOL_HOOKS) {
        if (!shouldRunForTool(hook, claudeToolName)) continue;
        await runHookRaw(hook.path, claudeInput);
      }
    },
`
    : ""
}

${
  sessionEndHooks.length > 0
    ? `
    // Catch-all event handler for session lifecycle
    // session.created: capture session ID, cancel pending timer
    // session.idle: start debounce timer — run session-end hooks after IDLE_SUMMARY_DELAY
    // session.status:busy: cancel timer — user is still active
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info as { id?: string } | undefined;
        sessionId = info?.id ?? sessionId;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }

      if (event.type === "session.status") {
        const status = event.properties?.status as { type?: string } | undefined;
        if (status?.type === "busy" && idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
          // Timer cancelled — user resumed activity
        }
      }

      if (event.type === "session.idle") {
        // Cancel any previous timer (multiple idles can fire)
        if (idleTimer) clearTimeout(idleTimer);

        // Start debounce timer — if user stays idle, run session-end hooks
        idleTimer = setTimeout(async () => {
          idleTimer = null;

          const sessionEndHookPaths = ${JSON.stringify(sessionEndHooks.map((h) => h.path))};
          for (const hookPath of sessionEndHookPaths) {
            try {
              await runHookRaw(hookPath, {
                session_id: sessionId,
                reason: "idle",
                cwd: ctx.directory,
                provider: "opencode",
              });
            } catch (e) {
              console.error(\`[shaka] Session-end hook error: \${e instanceof Error ? e.message : String(e)}\`);
            }
          }
        }, IDLE_SUMMARY_DELAY);
      }
    },
`
    : ""
}
  };
};
`;
}
