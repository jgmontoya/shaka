import { describe, expect, test } from "bun:test";
import {
  type NormalizedMessage,
  parseClaudeCodeTranscript,
  parseCodexTranscript,
  parseOpencodeTranscript,
  truncateTranscript,
} from "../../../src/memory/transcript";

// --- Inline fixtures derived from Experiment 09 ---

/** Claude Code JSONL: a user text message */
const claudeUserLine = JSON.stringify({
  type: "user",
  uuid: "user-001",
  message: { role: "user", content: "What files are in the src/ directory?" },
});

/** Claude Code JSONL: an assistant message with text content */
const claudeAssistantTextLine = JSON.stringify({
  type: "assistant",
  uuid: "asst-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here are the files in src/:" }],
  },
});

/** Claude Code JSONL: an assistant message with tool_use content */
const claudeAssistantToolLine = JSON.stringify({
  type: "assistant",
  uuid: "asst-002",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Let me check the files." },
      { type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "ls src/" } },
    ],
  },
});

/** Claude Code JSONL: an assistant message with thinking content (should be ignored) */
const claudeAssistantThinkingLine = JSON.stringify({
  type: "assistant",
  uuid: "asst-003",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should look at the directory structure..." },
      { type: "text", text: "Let me analyze the project." },
    ],
  },
});

/** Claude Code JSONL: a system message (should be skipped) */
const claudeSystemLine = JSON.stringify({
  type: "system",
  uuid: "sys-001",
  message: { role: "system", content: "System initialization complete" },
});

/** Claude Code JSONL: a progress message (should be skipped) */
const claudeProgressLine = JSON.stringify({
  type: "progress",
  uuid: "prog-001",
  data: { type: "hook_progress", hookEvent: "SessionStart" },
});

/** Claude Code JSONL: a file-history-snapshot (should be skipped) */
const claudeSnapshotLine = JSON.stringify({
  type: "file-history-snapshot",
  messageId: "snap-001",
  snapshot: { trackedFileBackups: {} },
});

/** Claude Code JSONL: a user message with tool_result content (should be skipped — tool results are not user messages) */
const claudeToolResultLine = JSON.stringify({
  type: "user",
  uuid: "user-002",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "file1.ts\nfile2.ts" }],
  },
});

/** Claude Code JSONL: streamed duplicate — same uuid, progressively more content */
const claudeStreamedPartial = JSON.stringify({
  type: "assistant",
  uuid: "asst-streamed",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Partial" }],
  },
});
const claudeStreamedFull = JSON.stringify({
  type: "assistant",
  uuid: "asst-streamed",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Partial response, now complete." }],
  },
});

/** opencode export JSON: minimal valid export */
const opencodeExport = JSON.stringify({
  info: { id: "ses_abc123", directory: "/projects/myapp" },
  messages: [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "What files are in src/?" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "step-start", snapshot: "abc" },
        { type: "text", text: "Here are the files:" },
        {
          type: "tool",
          tool: "glob",
          state: { input: { pattern: "src/**/*" }, output: "src/index.ts\nsrc/main.ts" },
        },
        { type: "step-finish", reason: "tool-calls" },
      ],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "The src/ directory contains index.ts and main.ts." }],
    },
  ],
});

// --- Tests ---

describe("Transcript", () => {
  describe("parseClaudeCodeTranscript", () => {
    test("parses user text message", () => {
      const result = parseClaudeCodeTranscript(claudeUserLine);
      expect(result).toEqual([{ role: "user", content: "What files are in the src/ directory?" }]);
    });

    test("parses assistant text message", () => {
      const result = parseClaudeCodeTranscript(claudeAssistantTextLine);
      expect(result).toEqual([{ role: "assistant", content: "Here are the files in src/:" }]);
    });

    test("parses assistant message with tool_use annotation", () => {
      const result = parseClaudeCodeTranscript(claudeAssistantToolLine);
      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe("assistant");
      expect(result[0]!.content).toContain("Let me check the files.");
      expect(result[0]!.content).toContain("[Tool: Bash]");
    });

    test("extracts text from assistant thinking messages, ignores thinking blocks", () => {
      const result = parseClaudeCodeTranscript(claudeAssistantThinkingLine);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Let me analyze the project.");
      expect(result[0]!.content).not.toContain("thinking");
    });

    test("skips system messages", () => {
      const result = parseClaudeCodeTranscript(claudeSystemLine);
      expect(result).toEqual([]);
    });

    test("skips progress messages", () => {
      const result = parseClaudeCodeTranscript(claudeProgressLine);
      expect(result).toEqual([]);
    });

    test("skips file-history-snapshot messages", () => {
      const result = parseClaudeCodeTranscript(claudeSnapshotLine);
      expect(result).toEqual([]);
    });

    test("skips user messages that are tool results", () => {
      const result = parseClaudeCodeTranscript(claudeToolResultLine);
      expect(result).toEqual([]);
    });

    test("deduplicates streamed messages by uuid (keeps last)", () => {
      const input = [claudeStreamedPartial, claudeStreamedFull].join("\n");
      const result = parseClaudeCodeTranscript(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Partial response, now complete.");
    });

    test("handles multi-line transcript with mixed types", () => {
      const input = [
        claudeProgressLine,
        claudeSystemLine,
        claudeUserLine,
        claudeAssistantTextLine,
        claudeAssistantToolLine,
        claudeSnapshotLine,
      ].join("\n");
      const result = parseClaudeCodeTranscript(input);
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe("user");
      expect(result[1]!.role).toBe("assistant");
      expect(result[2]!.role).toBe("assistant");
    });

    test("returns empty array for empty input", () => {
      expect(parseClaudeCodeTranscript("")).toEqual([]);
    });

    test("handles malformed lines gracefully (no throw)", () => {
      const input = ["not valid json", claudeUserLine, "{incomplete"].join("\n");
      const result = parseClaudeCodeTranscript(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe("user");
    });

    test("skips assistant messages with empty content after filtering", () => {
      const emptyAssistant = JSON.stringify({
        type: "assistant",
        uuid: "asst-empty",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm..." }],
        },
      });
      const result = parseClaudeCodeTranscript(emptyAssistant);
      expect(result).toEqual([]);
    });
  });

  describe("parseOpencodeTranscript", () => {
    test("parses user text message", () => {
      const input = JSON.stringify({
        messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] }],
      });
      const result = parseOpencodeTranscript(input);
      expect(result).toEqual([{ role: "user", content: "Hello" }]);
    });

    test("parses assistant text message", () => {
      const input = JSON.stringify({
        messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Hi there" }] }],
      });
      const result = parseOpencodeTranscript(input);
      expect(result).toEqual([{ role: "assistant", content: "Hi there" }]);
    });

    test("annotates tool parts as [Tool: name]", () => {
      const result = parseOpencodeTranscript(opencodeExport);
      const toolMsg = result.find((m) => m.content.includes("[Tool:"));
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain("[Tool: glob]");
    });

    test("skips step-start and step-finish parts", () => {
      const result = parseOpencodeTranscript(opencodeExport);
      for (const msg of result) {
        expect(msg.content).not.toContain("step-start");
        expect(msg.content).not.toContain("step-finish");
        expect(msg.content).not.toContain("snapshot");
      }
    });

    test("parses full export with multiple messages", () => {
      const result = parseOpencodeTranscript(opencodeExport);
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe("user");
      expect(result[1]!.role).toBe("assistant");
      expect(result[2]!.role).toBe("assistant");
    });

    test("returns empty array for empty input", () => {
      expect(parseOpencodeTranscript("")).toEqual([]);
    });

    test("returns empty array for empty messages array", () => {
      expect(parseOpencodeTranscript(JSON.stringify({ messages: [] }))).toEqual([]);
    });

    test("handles malformed JSON gracefully (no throw)", () => {
      expect(parseOpencodeTranscript("not json")).toEqual([]);
    });

    test("handles missing messages field gracefully", () => {
      expect(parseOpencodeTranscript(JSON.stringify({ info: {} }))).toEqual([]);
    });

    test("skips messages with empty content after filtering parts", () => {
      const input = JSON.stringify({
        messages: [
          { info: { role: "assistant" }, parts: [{ type: "step-start" }, { type: "step-finish" }] },
        ],
      });
      const result = parseOpencodeTranscript(input);
      expect(result).toEqual([]);
    });

    test("joins multiple text parts with newline", () => {
      const input = JSON.stringify({
        messages: [
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "First paragraph." },
              { type: "text", text: "Second paragraph." },
            ],
          },
        ],
      });
      const result = parseOpencodeTranscript(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("First paragraph.\nSecond paragraph.");
    });
  });

  describe("parseCodexTranscript", () => {
    test("parses user_message as user role", () => {
      const input = `{"type":"event_msg","payload":{"type":"user_message","message":"read the file README.md"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([{ role: "user", content: "read the file README.md" }]);
    });

    test("parses agent_message commentary as assistant role", () => {
      const input = `{"type":"event_msg","payload":{"type":"agent_message","message":"Reading README.md now.","phase":"commentary"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([{ role: "assistant", content: "Reading README.md now." }]);
    });

    test("parses agent_message final_answer as assistant role", () => {
      const input = `{"type":"event_msg","payload":{"type":"agent_message","message":"Here is the content.","phase":"final_answer"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([{ role: "assistant", content: "Here is the content." }]);
    });

    test("folds function_call as [Tool: name]", () => {
      const input = `{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([{ role: "assistant", content: "[Tool: exec_command]" }]);
    });

    test("skips function_call_output lines", () => {
      const input = `{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_xxx","output":"# Shaka\\n"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([]);
    });

    test("parses full multi-line Codex transcript", () => {
      const lines = [
        `{"type":"event_msg","payload":{"type":"user_message","message":"read the file README.md"}}`,
        `{"type":"event_msg","payload":{"type":"agent_message","message":"Reading README.md now.","phase":"commentary"}}`,
        `{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"head -n 1 README.md\\"}"}}`,
        `{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_xxx","output":"# Shaka\\n"}}`,
        `{"type":"event_msg","payload":{"type":"agent_message","message":"\`# Shaka\`","phase":"final_answer"}}`,
      ];
      const result = parseCodexTranscript(lines.join("\n"));
      expect(result).toHaveLength(4); // user, commentary, tool, final_answer
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toBe("read the file README.md");
      expect(result[1]!.role).toBe("assistant");
      expect(result[1]!.content).toBe("Reading README.md now.");
      expect(result[2]!.role).toBe("assistant");
      expect(result[2]!.content).toBe("[Tool: exec_command]");
      expect(result[3]!.role).toBe("assistant");
      expect(result[3]!.content).toBe("`# Shaka`");
    });

    test("returns empty array for empty input", () => {
      expect(parseCodexTranscript("")).toEqual([]);
    });

    test("handles malformed lines gracefully (no throw)", () => {
      const input = [
        "not valid json",
        `{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`,
        "{incomplete",
      ].join("\n");
      const result = parseCodexTranscript(input);
      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe("user");
    });

    test("skips lines with unknown payload types", () => {
      const input = `{"type":"event_msg","payload":{"type":"system_init","data":{}}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([]);
    });

    test("skips agent_message with empty message", () => {
      const input = `{"type":"event_msg","payload":{"type":"agent_message","message":"","phase":"commentary"}}`;
      const result = parseCodexTranscript(input);
      expect(result).toEqual([]);
    });
  });

  describe("truncateTranscript", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "Second message" },
      { role: "user", content: "Third message" },
      { role: "assistant", content: "Fourth message" },
      { role: "user", content: "Fifth message" },
    ];

    test("returns all messages if under limit", () => {
      const result = truncateTranscript(messages, 10000);
      expect(result).toEqual(messages);
    });

    test("keeps most recent messages when over limit", () => {
      // Each message is ~13-14 chars. Total ~67. Set limit to 30 to force truncation.
      const result = truncateTranscript(messages, 30);
      // Should contain a truncation note + the last messages that fit
      const lastMsg = result[result.length - 1];
      expect(lastMsg!.content).toBe("Fifth message");
    });

    test("prepends truncation note when truncated", () => {
      const result = truncateTranscript(messages, 30);
      expect(result[0]!.role).toBe("user");
      expect(result[0]!.content).toContain("[Transcript truncated");
    });

    test("truncation note includes message counts", () => {
      const result = truncateTranscript(messages, 30);
      expect(result[0]!.content).toMatch(/showing last \d+ of 5 messages/);
    });

    test("never returns empty (at minimum returns last message)", () => {
      const result = truncateTranscript(messages, 1);
      expect(result.length).toBeGreaterThanOrEqual(1);
      // Last actual message should be present (may also have truncation note)
      const contents = result.map((m) => m.content);
      expect(contents).toContain("Fifth message");
    });

    test("returns empty array for empty input", () => {
      expect(truncateTranscript([], 10000)).toEqual([]);
    });

    test("handles single message under limit", () => {
      const single = [{ role: "user" as const, content: "Hello" }];
      expect(truncateTranscript(single, 10000)).toEqual(single);
    });

    test("handles single message over limit", () => {
      const single = [{ role: "user" as const, content: "Hello" }];
      const result = truncateTranscript(single, 1);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Hello");
    });
  });
});
