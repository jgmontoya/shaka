/**
 * Transcript parsing and normalization for every supported provider.
 *
 * Claude Code: JSONL — one JSON object per line, streamed (deduped by uuid).
 * Codex:       JSONL — append-only event stream (user_message / agent_message / function_call).
 * opencode:    Single JSON object from `opencode export` — messages[] array.
 * Pi:          JSONL — session records; only `type:"message"` lines carry conversation content.
 *
 * Each parser normalizes its input to NormalizedMessage[] for downstream consumption.
 */

export interface NormalizedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

// --- Claude Code JSONL Parser ---

interface ClaudeLine {
  type: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: string | ClaudeContentBlock[];
  };
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
}

/**
 * Parse a Claude Code JSONL transcript into normalized messages.
 *
 * Handles:
 * - Streamed deduplication (same uuid appears multiple times; keep last)
 * - User messages (string content)
 * - Assistant messages (array of text/tool_use/thinking blocks)
 * - Skips system, progress, file-history-snapshot lines
 * - Skips user messages that are tool results (array content with tool_result type)
 * - Skips malformed lines gracefully
 */
export function parseClaudeCodeTranscript(jsonlContent: string): NormalizedMessage[] {
  if (!jsonlContent.trim()) return [];

  // First pass: parse all lines and deduplicate by uuid (keep last occurrence)
  const linesByUuid = new Map<string, ClaudeLine>();
  const orderedUuids: string[] = [];

  for (const line of jsonlContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: ClaudeLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const uuid = parsed.uuid;
    if (!uuid) continue;

    if (!linesByUuid.has(uuid)) {
      orderedUuids.push(uuid);
    }
    linesByUuid.set(uuid, parsed);
  }

  // Second pass: convert deduplicated lines to normalized messages
  const messages: NormalizedMessage[] = [];

  for (const uuid of orderedUuids) {
    const parsed = linesByUuid.get(uuid);
    if (!parsed) continue;

    const msg = normalizeClaudeLine(parsed);
    if (msg) messages.push(msg);
  }

  return messages;
}

function normalizeClaudeLine(parsed: ClaudeLine): NormalizedMessage | null {
  // Only process user and assistant messages
  if (parsed.type !== "user" && parsed.type !== "assistant") return null;
  if (!parsed.message) return null;

  if (parsed.type === "user") {
    return normalizeClaudeUserMessage(parsed.message);
  }

  return normalizeClaudeAssistantMessage(parsed.message);
}

function normalizeClaudeUserMessage(
  message: NonNullable<ClaudeLine["message"]>,
): NormalizedMessage | null {
  const { content } = message;

  // String content = regular user message
  if (typeof content === "string") {
    return { role: "user", content };
  }

  // Array content = tool_result — skip these
  if (Array.isArray(content)) {
    return null;
  }

  return null;
}

function normalizeClaudeAssistantMessage(
  message: NonNullable<ClaudeLine["message"]>,
): NormalizedMessage | null {
  const { content } = message;
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  const toolParts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      toolParts.push(`[Tool: ${block.name}]`);
    }
    // thinking blocks are intentionally ignored
  }

  const combined = [...textParts, ...toolParts].filter(Boolean).join("\n");
  if (!combined) return null;

  return { role: "assistant", content: combined };
}

// --- Codex JSONL Parser ---

interface CodexLine {
  type: string;
  payload?: {
    type?: string;
    message?: string;
    phase?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
  };
}

/**
 * Parse a Codex CLI JSONL transcript into normalized messages.
 *
 * Handles:
 * - user_message events (role: user)
 * - agent_message events — all phases: commentary + final_answer (role: assistant)
 * - function_call entries folded as [Tool: <name>] (role: assistant)
 * - function_call_output is skipped (tool results are noisy)
 * - No deduplication needed (Codex uses append-only events, not progressive updates)
 * - Malformed lines skipped gracefully
 */
export function parseCodexTranscript(jsonlContent: string): NormalizedMessage[] {
  if (!jsonlContent.trim()) return [];

  const messages: NormalizedMessage[] = [];

  for (const line of jsonlContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: CodexLine;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const msg = normalizeCodexLine(parsed);
    if (msg) messages.push(msg);
  }

  return messages;
}

function normalizeCodexLine(parsed: CodexLine): NormalizedMessage | null {
  const payload = parsed.payload;
  if (!payload?.type) return null;

  if (payload.type === "user_message") {
    if (!payload.message) return null;
    return { role: "user", content: payload.message };
  }

  if (payload.type === "agent_message") {
    if (!payload.message) return null;
    return { role: "assistant", content: payload.message };
  }

  if (payload.type === "function_call") {
    if (!payload.name) return null;
    return { role: "assistant", content: `[Tool: ${payload.name}]` };
  }

  // function_call_output and other types are skipped
  return null;
}

// --- opencode Export JSON Parser ---

interface OpencodeExport {
  messages?: OpencodeMessage[];
}

interface OpencodeMessage {
  info?: { role?: string };
  parts?: OpencodePart[];
}

interface OpencodePart {
  type: string;
  text?: string;
  tool?: string;
}

/**
 * Parse an opencode export JSON string into normalized messages.
 *
 * Handles:
 * - User and assistant messages from messages[] array
 * - Text parts extracted from parts[]
 * - Tool parts annotated as [Tool: name]
 * - step-start and step-finish parts are skipped
 * - Malformed JSON handled gracefully
 */
export function parseOpencodeTranscript(exportJson: string): NormalizedMessage[] {
  if (!exportJson.trim()) return [];

  let parsed: OpencodeExport;
  try {
    parsed = JSON.parse(exportJson);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.messages)) return [];

  const messages: NormalizedMessage[] = [];

  for (const msg of parsed.messages) {
    const normalized = normalizeOpencodeMessage(msg);
    if (normalized) messages.push(normalized);
  }

  return messages;
}

function normalizeOpencodeMessage(msg: OpencodeMessage): NormalizedMessage | null {
  const role = msg.info?.role;
  if (role !== "user" && role !== "assistant") return null;
  if (!Array.isArray(msg.parts)) return null;

  const textParts: string[] = [];
  const toolParts: string[] = [];

  for (const part of msg.parts) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.type === "tool" && part.tool) {
      toolParts.push(`[Tool: ${part.tool}]`);
    }
    // step-start, step-finish are intentionally skipped
  }

  const combined = [...textParts, ...toolParts].filter(Boolean).join("\n");
  if (!combined) return null;

  return { role, content: combined };
}

// --- Pi JSONL Parser ---

/**
 * Pi (`@earendil-works/pi-coding-agent`) writes session JSONL where each line
 * is one of: a session header, a `message` line wrapping an `AgentMessage`,
 * or a side-band record (`compaction`, `model_change`, ...). Empirical shape
 * sources: experiments 45 and 48.
 *
 * Handled message roles (the only ones that carry conversational content):
 * - `user` → `role: "user"` with concatenated text blocks
 * - `assistant` → `role: "assistant"`; `toolCall` content blocks fold to `[Tool: name]`
 * - `branchSummary` / `compactionSummary` → `role: "assistant"` with the
 *   text prefixed `[Branch Summary]` / `[Compaction Summary]` so the
 *   2-role NormalizedMessage union doesn't lose the signal
 *
 * Skipped roles: `toolResult`, `bashExecution`, `custom` (extension/tool
 * noise — handled at the assistant turn boundary instead).
 *
 * Skipped top-level types: `session`, `model_change`, `thinking_level_change`,
 * `compaction`, `branch_summary`, `custom`, `custom_message`, `label`,
 * `session_info`. These are session metadata, not conversation content.
 *
 * Malformed JSON lines and unknown shapes are silently skipped.
 */
export function parsePiTranscript(jsonlContent: string): NormalizedMessage[] {
  if (!jsonlContent.trim()) return [];

  const messages: NormalizedMessage[] = [];

  for (const line of jsonlContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const message = normalizePiLine(parsed);
    if (message) messages.push(message);
  }

  return messages;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  name?: string;
}

interface PiAgentMessage {
  role?: string;
  content?: PiContentBlock[] | string;
}

interface PiLine {
  type?: string;
  message?: PiAgentMessage;
}

/**
 * Per-role formatter for Pi AgentMessage. Roles outside this table — including
 * toolResult, bashExecution, custom, and unknowns — are intentionally dropped.
 *
 * `Map` rather than a plain object so a role from JSON.parse can't resolve
 * through `Object.prototype` (e.g. `"toString"` → `Object.prototype.toString`)
 * and then get invoked as a formatter.
 */
const PI_ROLE_FORMATTERS = new Map<string, (text: string) => NormalizedMessage>([
  ["user", (text) => ({ role: "user", content: text })],
  ["assistant", (text) => ({ role: "assistant", content: text })],
  ["branchSummary", (text) => ({ role: "assistant", content: `[Branch Summary] ${text}` })],
  ["compactionSummary", (text) => ({ role: "assistant", content: `[Compaction Summary] ${text}` })],
]);

function normalizePiLine(parsed: unknown): NormalizedMessage | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const line = parsed as PiLine;
  if (line.type !== "message" || !line.message) return null;

  const { role, content } = line.message;
  if (typeof role !== "string") return null;

  const formatter = PI_ROLE_FORMATTERS.get(role);
  if (formatter === undefined) return null;

  const text = piContentToText(content);
  // `text.trim()` gates the empty case without losing semantic whitespace
  // around the message body itself — the formatter receives the raw join.
  return text.trim() ? formatter(text) : null;
}

function piContentToText(content: PiContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  // `content` crosses a JSON-parse boundary; the static type is hopeful, not
  // guaranteed. Bail out cleanly on any other shape so a single malformed
  // line can't abort the whole transcript walk.
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    // Per-item shape also crosses the JSON-parse boundary; `[null]` or
    // `[1, ...]` would crash on `block.type` without this guard. Skip
    // anything that isn't a plain object.
    if (typeof block !== "object" || block === null) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`[Tool: ${block.name}]`);
    }
  }
  return parts.join("\n");
}

// --- Truncation ---

/**
 * Truncate a transcript to fit within a character limit.
 *
 * Keeps the most recent messages (tail). When truncated, prepends a note
 * indicating how many messages were dropped.
 *
 * Returns all messages unchanged if total character count is within the limit.
 * Returns empty array for empty input.
 * Always includes at least the last message (even if it exceeds the limit).
 */
export function truncateTranscript(
  messages: NormalizedMessage[],
  maxChars: number,
): NormalizedMessage[] {
  if (messages.length === 0) return [];

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= maxChars) return messages;

  // Walk backwards, accumulating messages until we exceed the limit
  const kept: NormalizedMessage[] = [];
  let charCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const newTotal = charCount + msg.content.length;

    // Always include at least the last message
    if (kept.length === 0 || newTotal <= maxChars) {
      kept.unshift(msg);
      charCount = newTotal;
    } else {
      break;
    }
  }

  // Prepend truncation note if we dropped any messages
  if (kept.length < messages.length) {
    const note: NormalizedMessage = {
      role: "user",
      content: `[Transcript truncated — showing last ${kept.length} of ${messages.length} messages]`,
    };
    kept.unshift(note);
  }

  return kept;
}
