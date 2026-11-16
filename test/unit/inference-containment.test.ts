import { type Mock, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ProcessInvocation } from "../../src/platform/process-runner";
import { getProviderModule, getProviderNames } from "../../src/providers/registry";
import type { ProviderName } from "../../src/providers/types";

// Invariant: every provider's inference backend contains its host runtime
// (hooks/plugins/extensions off) so inference() called from inside a hook
// cannot recurse. A missing opencode guard caused the v0.9/0.10 CPU spike.

interface ContainmentCase {
  /** Asserts one process started by this provider's inference is contained. */
  readonly assertContained: (invocation: ProcessInvocation) => void;
  /** Fake CLI behavior that lets inference reach its success path; returns stdout. */
  readonly fakeCli?: (invocation: ProcessInvocation) => Promise<string>;
}

const CONTAINMENT = {
  claude: {
    assertContained({ args = [] }) {
      expect(flagValue(args, "--setting-sources")).toBe("");
      expect(flagValue(args, "--tools")).toBe("");
      expect(args).toContain("--no-session-persistence");
    },
  },
  codex: {
    assertContained({ args = [] }) {
      expect(flagValue(args, "--disable")).toBe("hooks");
      expect(args).toContain("--ephemeral");
    },
    async fakeCli({ args = [] }) {
      await Bun.write(flagValue(args, "-o") ?? "", "OK");
      return "";
    },
  },
  opencode: {
    assertContained({ args = [], env }) {
      expect(env?.SHAKA_OPENCODE_SUBAGENT).toBe("true");
      expect(args).toContain("--pure");
    },
    async fakeCli() {
      return [
        { type: "step_start", sessionID: "ses_contained" },
        { type: "text", part: { text: "OK" } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
    },
  },
  pi: {
    assertContained({ args = [], env }) {
      expect(env?.SHAKA_PI_SUBAGENT).toBe("true");
      expect(args).toEqual(
        expect.arrayContaining([
          "--no-extensions",
          "--no-tools",
          "--no-session",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ]),
      );
    },
  },
} satisfies Record<ProviderName, ContainmentCase>;

// Prompts starting with "-" (YAML frontmatter, Markdown lists) are parsed as
// flags when passed positionally without a "--" terminator.
const DASH_PROMPT = "---\nlooks: like a flag";

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

let spawnSpy: Mock<typeof Bun.spawn>;
let spawned: ProcessInvocation[];

beforeEach(() => {
  spawned = [];
  // Fire-and-forget children (opencode session cleanup) bypass the injected
  // runner; record them instead of letting a real CLI start.
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    cmd: string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    const [command = "", ...args] = cmd;
    spawned.push({ command, args, env: options?.env });
    return { unref() {} };
  }) as unknown as typeof Bun.spawn);
});

afterEach(() => {
  spawnSpy.mockRestore();
});

async function runInference(name: ProviderName, userPrompt = "classify this") {
  const containment: ContainmentCase = CONTAINMENT[name];
  const invocations: ProcessInvocation[] = [];
  const result = await getProviderModule(name).inference.run(
    { userPrompt },
    {
      processRunner: async (invocation) => {
        invocations.push(invocation);
        const stdout = (await containment.fakeCli?.(invocation)) ?? "OK";
        return { exitCode: 0, stdout, stderr: "", timedOut: false };
      },
    },
  );
  expect(result).toMatchObject({ success: true, text: "OK" });
  expect(invocations).toHaveLength(1);
  const [invocation] = invocations as [ProcessInvocation];
  return { invocation, processes: [invocation, ...spawned] };
}

test("every registered provider declares an inference containment case", () => {
  expect(Object.keys(CONTAINMENT).sort()).toEqual(getProviderNames().sort());
});

describe.each(getProviderNames())("%s inference", (name) => {
  test("contains its host runtime in every process it starts", async () => {
    const { processes } = await runInference(name);
    for (const child of processes) CONTAINMENT[name].assertContained(child);
  });

  test("delivers a dash-leading prompt via stdin or after a -- terminator", async () => {
    const { invocation } = await runInference(name, DASH_PROMPT);
    const args = invocation.args ?? [];
    const viaStdin = invocation.stdin?.includes(DASH_PROMPT) ?? false;
    const terminator = args.indexOf("--");
    const viaTerminatedArgv = terminator !== -1 && args.indexOf(DASH_PROMPT) > terminator;
    expect(viaStdin || viaTerminatedArgv).toBe(true);
  });
});

describe("opencode inference", () => {
  test("selects the inference agent by its frontmatter name", async () => {
    const { invocation } = await runInference("opencode");
    expect(flagValue(invocation.args ?? [], "--agent")).toBe("inference");
  });

  // Keeps the containment check above honest: cleanup must actually run there.
  test("deletes its session through a fire-and-forget cleanup process", async () => {
    await runInference("opencode");
    expect(spawned).toEqual([
      expect.objectContaining({
        command: "opencode",
        args: expect.arrayContaining(["session", "delete", "ses_contained"]),
      }),
    ]);
  });
});
