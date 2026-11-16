import { describe, expect, test } from "bun:test";
import { parseOpencodeJsonStream } from "../../../../src/providers/opencode/inference";

describe("parseOpencodeJsonStream", () => {
  test("extracts session ID from the first step_start event", () => {
    const stream =
      '{"type":"step_start","sessionID":"ses_abc123","part":{}}\n' +
      '{"type":"text","part":{"text":"hello"}}\n';
    const result = parseOpencodeJsonStream(stream);
    expect(result.sessionId).toBe("ses_abc123");
  });

  test("concatenates text from all type:text events in stream order", () => {
    const stream =
      '{"type":"step_start","sessionID":"ses_abc"}\n' +
      '{"type":"text","part":{"text":"hello "}}\n' +
      '{"type":"text","part":{"text":"world"}}\n' +
      '{"type":"step_finish"}\n';
    const result = parseOpencodeJsonStream(stream);
    expect(result.text).toBe("hello world");
  });

  test("ignores malformed JSON lines while preserving valid text events", () => {
    const stream =
      '{"type":"text","part":{"text":"hello "}}\n' +
      "not json\n" +
      '{"type":"text","part":{"text":"world"}}\n';
    const result = parseOpencodeJsonStream(stream);
    expect(result.text).toBe("hello world");
  });

  test("returns null sessionId when no step_start event is present", () => {
    const result = parseOpencodeJsonStream('{"type":"text","part":{"text":"hello"}}\n');
    expect(result.sessionId).toBeNull();
  });
});
