/**
 * Memory Search Tool for MCP
 *
 * Exposes memory search as an MCP tool so coding assistants
 * can look up past decisions, learnings, and work history.
 */

import { join } from "node:path";
import { type SearchFilter, loadConfig, resolveShakaHome, searchMemory } from "shaka";

export default {
  name: "memory-search",
  description:
    "Search past session summaries, learnings, and compiled project knowledge for context, " +
    "decisions, and work history. Returns matching entries with snippets.",

  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "Search query (case-insensitive substring match)",
      },
      category: {
        type: "string" as const,
        description: "Filter learnings by category (correction/preference/pattern/fact)",
      },
      cwd: {
        type: "string" as const,
        description: "Search a specific project working directory",
      },
      all_projects: {
        type: "boolean" as const,
        description: "Search memory from every project instead of the current project",
      },
      type: {
        type: "string" as const,
        enum: ["session", "learning", "knowledge"],
        description: "Filter by result type",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) return "Error: query is required";
    if (args.cwd && args.all_projects === true) {
      return "Error: cwd and all_projects cannot be used together";
    }

    const filter: SearchFilter | undefined =
      args.all_projects || args.category || args.cwd || args.type
        ? {
            allProjects: args.all_projects === true,
            category: args.category as string | undefined,
            cwd: args.cwd as string | undefined,
            type: args.type as "session" | "learning" | "knowledge" | undefined,
          }
        : undefined;

    const shakaHome = resolveShakaHome();
    const memoryDir = join(shakaHome, "memory");
    const config = await loadConfig(shakaHome);
    const results = await searchMemory(
      query,
      memoryDir,
      filter,
      config?.memory?.search_max_results,
    );

    if (results.length === 0) {
      return `No session memories found matching "${query}"`;
    }

    const formatted = results.map((r) => {
      const typeLabel = `[${r.type}]`;
      const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
      return `### ${typeLabel} ${r.title}\n*${r.date}*${tags}\n\n${r.snippet}`;
    });

    return `Found ${results.length} matching result${results.length > 1 ? "s" : ""}:\n\n${formatted.join("\n\n---\n\n")}`;
  },
};
