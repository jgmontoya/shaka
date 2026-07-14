# Provider Support

Shaka integrates with four AI coding assistants, treating each as a first-class citizen:

| Provider    | Hooks                                                    | Tools                                            | Commands                                  | Skills + Agents                                             |
| ----------- | -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------- |
| Claude Code | Subprocess via `~/.claude/settings.json`                 | MCP server (`shaka mcp serve`)                   | `~/.claude/commands/`                     | `~/.claude/skills/`, `~/.claude/agents/`                    |
| opencode    | In-process plugin (`~/.config/opencode/plugins/`)        | Native `tool` field on the plugin                | `~/.config/opencode/commands/`            | `~/.config/opencode/skills/`, `~/.config/opencode/agents/`  |
| Codex       | Wrapper script via `~/.codex/hooks.json`                 | MCP server (`shaka mcp serve`)                   | `~/.agents/skills/<command>/SKILL.md`     | `~/.agents/skills/`, `~/.codex/agents/*.toml`               |
| Pi          | Generated extension at `~/.pi/agent/extensions/shaka.ts` | Native `pi.registerTool()` in the same extension | `~/.pi/agent/prompts/` (prompt templates) | `~/.pi/agent/skills/` with `shaka-` / `shaka-agent-` prefix |

`shaka init` detects every installed provider and configures all four if present. Pass `--<provider>` to scope to one. Pass `--all` to install every detected provider explicitly.

## Provider Capability Architecture

Provider behavior is owned by provider modules under `src/providers/<name>/`.
The registry (`src/providers/registry.ts`) is the only central place that
orders providers and maps names to modules. Shared orchestration may choose,
filter, and iterate providers, but it should not build provider-specific argv,
set provider-specific env guards, parse provider-specific output, or check
provider-specific credentials.

Each provider module owns these capabilities:

- `agent.ts` — provider CLI invocation for sub-agent work.
- `inference.ts` — provider CLI invocation, output parsing, isolation flags, and model mapping.
- `setup.ts` — interactive and oneshot autoresearch setup invocation.
- `commands.ts` — native command format compilation and install behavior.
- `configurer.ts` — hooks, agents, skills, install/uninstall, and install status.
- provider runtime templates/renderers where generated plugin or wrapper text is the artifact.

Adding a provider should mean adding a provider module, registering it once,
adding default config/docs, and adding fake-binary plus generated-artifact
tests. It should not require editing inference, agent execution, setup-session,
doctor, or command orchestration switches.

## Hook Abstraction

The four providers expose hooks differently:

- **Claude Code** — subprocess hooks; `~/.claude/settings.json` lists `bun <hook-path>` per event.
- **opencode** — in-process plugin callbacks; canonical Shaka hook logic still runs through Shaka hook runners.
- **Codex** — wrapper script registered in `~/.codex/hooks.json`; spawns Shaka as a subprocess on each event.
- **Pi** — generated TypeScript extension at `~/.pi/agent/extensions/shaka.ts` loaded via jiti; hook handlers shell to `shaka hook <event>` per fire.

Shaka hides this: hook logic lives once in `defaults/system/hooks/`, and each provider's configurer translates events automatically.

```pseudocode
                 ┌─────────────────────────────────────────────┐
                 │              Shaka Hooks                    │
                 │     defaults/system/hooks/*.ts              │
                 │  (canonical events, one implementation)     │
                 └────────────┬────────────────────────────────┘
                              │
       ┌──────────────────┬───┴───┬──────────────────┐
       ▼                  ▼       ▼                  ▼
┌─────────────┐    ┌────────────┐ ┌───────────┐ ┌──────────┐
│ Claude Code │    │  opencode  │ │   Codex   │ │    Pi    │
│ subprocess  │    │ plugin     │ │  wrapper  │ │extension │
│ via         │    │ callbacks  │ │ script    │ │via jiti  │
│settings.json│    │            │ │           │ │          │
└─────────────┘    └────────────┘ └───────────┘ └──────────┘
```

### Event Mapping

Shaka uses canonical event names internally. Each provider maps them to its native shape:

| Shaka Event     | Claude Code        | opencode                             | Codex                | Pi                                         |
| --------------- | ------------------ | ------------------------------------ | -------------------- | ------------------------------------------ |
| `session.start` | `SessionStart`     | Plugin load                          | Wrapper at first run | `before_agent_start`                       |
| `prompt.submit` | `UserPromptSubmit` | `experimental.chat.system.transform` | Wrapper invocation   | `before_agent_start`                       |
| `tool.before`   | `PreToolUse`       | `tool.execute.before`                | Wrapper invocation   | `tool_call`                                |
| `tool.after`    | `PostToolUse`      | `tool.execute.after`                 | Wrapper invocation   | `tool_result`                              |
| `session.end`   | `SessionEnd`       | `session.idle` (debounced)           | Wrapper teardown     | `agent_end` (debounced) + `session_shutdown` |

### How Hooks Are Installed

- **Claude Code:** `shaka init` writes `~/.claude/settings.json` entries pointing at `bun <hook-path>` for each event.
- **opencode:** `shaka init` generates `~/.config/opencode/plugins/shaka.ts` with native plugin callbacks that dispatch canonical hook logic via Shaka hook runners.
- **Codex:** `shaka init` registers a wrapper script in `~/.codex/hooks.json`; the wrapper sets `SHAKA_CODEX_SUBAGENT=true` for spawned subagents.
- **Pi:** `shaka init` generates `~/.pi/agent/extensions/shaka.ts` from `defaults/pi/extension.ts`, injecting the install-time `SHAKA_HOME`. Each handler shells to `shaka hook <event>` and short-circuits when `SHAKA_PI_SUBAGENT=true`.

## Tool Integration

Tools live once in `defaults/system/tools/` (canonical) with `customizations/tools/` overrides. Every provider sees the same set. Shipped tools: `inference` (provider-agnostic AI calls) and `memory-search` (project-scoped session, learning, and compiled-knowledge lookup).

How each provider exposes them to its model:

| Provider    | Mechanism                                                                            |
| ----------- | ------------------------------------------------------------------------------------ |
| Claude Code | Shaka's MCP server (`shaka mcp serve`) registered via `claude mcp add shaka -s user` |
| Codex       | Same MCP server, registered automatically in `~/.codex/config.toml`                  |
| opencode    | Generated plugin's `tool` field exposes them as native opencode custom tools         |
| Pi          | Generated extension calls `pi.registerTool()` for each tool at load time             |

Every non-MCP path (opencode plugin, Pi extension) shells to a single subcommand:

```bash
shaka tool <name>     # reads JSON args on stdin, prints result on stdout
```

This keeps tool definitions in one place regardless of which provider is running. ~20 ms subprocess overhead per call is acceptable for the simplicity of one source of truth.

### MCP Server (Claude Code + Codex)

The MCP server (`shaka mcp serve`) implements:

- `initialize` — handshake
- `tools/list` — enumerate the resolved tool set (`system/tools/` plus `customizations/tools/` overrides)
- `tools/call` — execute and return results

Claude Code registration (run once per machine):

```bash
claude mcp add shaka -s user -- shaka mcp serve
```

Codex registration is handled automatically by `shaka init --codex`; the entry lives in `~/.codex/config.toml` under `[mcp_servers.shaka]`.

### Native bridges (opencode + Pi)

opencode and Pi run plugins in-process, so MCP would be wasteful. Each generated plugin/extension declares the tool inline and delegates execution to `shaka tool <name>`. Provider-specific shape requirements caught empirically:

- **Pi** expects tool results in `{ content: [{ type: "text", text }], details: undefined }` form. A plain string crashes Pi's renderer (`Cannot read properties of undefined (reading 'filter')`). Verified Exp 52.
- **opencode** expects tool args as `z.ZodRawShape` (flat record of zod schemas via `import { tool } from "@opencode-ai/plugin"; const z = tool.schema;`). JSON Schema crashes opencode's runtime with `n._zod.def` undefined. Verified Exp 53.

Both generated artifacts honor `SHAKA_BIN` so Shaka-spawned subprocesses can pin the bridge to a specific binary (Shaka's own, or a stub during integration tests).

## Recursion Guards

Shaka invokes provider CLIs internally for inference (`callPiCLI`, `callOpencodeCLI`, etc.) and for spawned sub-agents (`runAgentStep`). Without a guard, the spawned process would re-trigger Shaka's own hooks and tools, recursing.

Each provider has a Shaka-owned environment sentinel that hook handlers check at fire time:

| Provider    | Env var                                                                    | Set by                                  |
| ----------- | -------------------------------------------------------------------------- | --------------------------------------- |
| Claude Code | `CLAUDE_AGENT_TYPE` (and `CLAUDE_PROJECT_DIR` matching `/.claude/Agents/`) | Claude Code itself for sub-agents       |
| opencode    | `SHAKA_OPENCODE_SUBAGENT`                                                  | `src/providers/opencode/inference.ts`   |
| Codex       | `SHAKA_CODEX_SUBAGENT`                                                     | Codex wrapper script + Codex provider inference |
| Pi          | `SHAKA_PI_SUBAGENT`                                                        | `src/providers/pi/inference.ts`         |

`isSubagent()` in `src/domain/config.ts` checks all four; hooks early-return when any is set.
