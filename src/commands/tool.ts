/**
 * `shaka tool <name>` — execute a Shaka system or customizations tool.
 *
 * Reads JSON arguments from stdin, runs the named tool, prints the tool's
 * string result to stdout. Backs the Pi extension and opencode plugin tool
 * bridges: each provider's host process spawns this subcommand instead of
 * duplicating tool resolution + execution logic.
 *
 * Tool defs live at `${shakaHome}/system/tools/*.ts` (canonical) with
 * `${shakaHome}/customizations/tools/*.ts` overrides — the same paths the
 * MCP server walks for Claude Code and Codex.
 */

import { join } from "node:path";
import { Command } from "commander";
import { resolveShakaHome } from "../domain/config";
import { discoverToolsWithOverrides } from "../mcp/tool-discovery";

export function createToolCommand(): Command {
  return new Command("tool")
    .description("Run a Shaka tool by name (JSON args on stdin → result on stdout)")
    .argument("<name>", "Tool name (e.g., memory-search, inference)")
    .action(async (name: string) => {
      // Discovery, stdin read, parse, and execute all share one error
      // surface so callers (Pi extension, opencode plugin) see the failure
      // as a clean message on stderr rather than a raw V8 stack trace.
      // Mirrors the structured-error contract enforced by `src/mcp/server.ts`.
      try {
        const shakaHome = resolveShakaHome({
          SHAKA_HOME: process.env.SHAKA_HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
        });

        const tools = await discoverToolsWithOverrides(
          join(shakaHome, "system", "tools"),
          join(shakaHome, "customizations", "tools"),
        );
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          const available = tools.map((t) => t.name).join(", ") || "(none)";
          console.error(`Unknown tool "${name}". Available: ${available}`);
          process.exit(1);
        }

        const stdin = await Bun.stdin.text();
        const args = stdin.trim() ? JSON.parse(stdin) : {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new Error("stdin must decode to a JSON object");
        }
        const result = await tool.execute(args as Record<string, unknown>);
        process.stdout.write(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`shaka tool ${name}: ${message}`);
        process.exit(1);
      }
    });
}
