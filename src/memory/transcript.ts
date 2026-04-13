/**
 * Transcript parsing and normalization for both providers.
 *
 * Claude Code: JSONL format — one JSON object per line, streamed (duplicates by uuid).
 * opencode: Single JSON object from `opencode export` — messages[] array.
 *
 * Both normalize to NormalizedMessage[] for downstream consumption.
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
