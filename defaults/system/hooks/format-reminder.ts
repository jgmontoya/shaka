#!/usr/bin/env bun
/**
 * FormatReminder hook - Algorithm enforcement via AI inference
 *
 * Dynamically discovers capabilities from agent files and thinking tools
 * from skills. No centralized registry needed.
 *
 * Architecture:
 * - Agents: SHAKA_HOME/agents/NAME.md with capability field in frontmatter
 * - Skills: SHAKA_HOME/skills/NAME/SKILL.md (thinking tools have key + include_when)
 * - Templates: SHAKA_HOME/system/templates/NAME.eta
 * - Inference: imported from shaka package
 */

import { join } from "node:path";
import { Eta } from "eta";
import { getAssistantName, inference, isSubagent, resolveShakaHome } from "shaka";
import { parse as parseYaml } from "yaml";

/** Hook trigger events - Shaka canonical names (provider configurers handle conversion) */
export const TRIGGER = ["prompt.submit"] as const;
export const HOOK_VERSION = "0.6.0";

const SHAKA_HOME = resolveShakaHome();

// Initialize Eta with templates directory
const eta = new Eta({
  views: join(SHAKA_HOME, "system", "templates"),
  cache: true,
});

// Types
interface AgentMeta {
  name: string;
  capability: string;
  capability_description: string;
}

interface ThinkingToolMeta {
  key: string;
  name: string;
  description: string;
  include_when: string;
}

interface Capability {
  key: string;
  name: string;
  description: string;
  agents: string;
}

interface ThinkingTool {
  key: string;
  name: string;
  description: string;
  includeWhen: string;
}

interface ClassificationResult {
  depth: "FULL" | "ITERATION" | "MINIMAL";
  capabilities: string[];
  thinking: string[];
}

interface TemplateData {
  assistantName: string;
  capabilities: Array<{ name: string; agents: string }>;
  thinking: Array<{ name: string; description: string }>;
}

// Cache for loaded data
let capabilitiesCache: Capability[] | null = null;
let thinkingToolsCache: ThinkingTool[] | null = null;

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return null;

  try {
    return parseYaml(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Discover capabilities by scanning agent files
 */
async function discoverCapabilities(): Promise<Capability[]> {
  if (capabilitiesCache) return capabilitiesCache;

  const capabilities = new Map<string, Capability>();
  const agentsDir = join(SHAKA_HOME, "agents");

  try {
    const glob = new Bun.Glob("*.md");
    for await (const file of glob.scan({ cwd: agentsDir })) {
      const content = await Bun.file(join(agentsDir, file)).text();
      const meta = parseFrontmatter(content) as AgentMeta | null;

      if (meta?.capability && meta?.name) {
        const capKey = meta.capability;
        const existing = capabilities.get(capKey);

        if (existing) {
          // Add this agent to existing capability
          existing.agents += `, ${meta.name} (subagent_type=${meta.name})`;
        } else {
          // Create new capability entry
          capabilities.set(capKey, {
            key: capKey,
            name: capitalize(capKey),
            description: meta.capability_description || capKey,
            agents: `${meta.name} (subagent_type=${meta.name})`,
          });
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  capabilitiesCache = Array.from(capabilities.values());
  return capabilitiesCache;
}

/**
 * Discover thinking tools by scanning skills directory for SKILL.md files
 * with key and include_when fields in frontmatter
 */
async function discoverThinkingTools(): Promise<ThinkingTool[]> {
  if (thinkingToolsCache) return thinkingToolsCache;

  const tools: ThinkingTool[] = [];
  const skillsDir = join(SHAKA_HOME, "skills");

  try {
    const glob = new Bun.Glob("*/SKILL.md");
    for await (const file of glob.scan({ cwd: skillsDir })) {
      const content = await Bun.file(join(skillsDir, file)).text();
      const meta = parseFrontmatter(content) as ThinkingToolMeta | null;

      // Only include skills that have key and include_when (thinking tools)
      if (meta?.key && meta?.name && meta?.include_when) {
        tools.push({
          key: meta.key,
          name: meta.name,
          description: meta.description || "",
          includeWhen: meta.include_when,
        });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  thinkingToolsCache = tools;
  return thinkingToolsCache;
}

/**
 * Capitalize first letter
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Read stdin with timeout
 */
async function readStdin(timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeout);
    process.stdin.on("data", (chunk) => {
      data += chunk.toString();
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

/**
 * Classify prompt using AI inference
 */
async function classifyPrompt(prompt: string): Promise<ClassificationResult> {
  const capabilities = await discoverCapabilities();
  const thinkingTools = await discoverThinkingTools();

  // Build classification prompt from template
  const systemPrompt = await eta.renderAsync("classification-prompt", {
    capabilities: capabilities.map((c) => ({
      key: c.key,
      description: c.description,
    })),
    thinkingTools: thinkingTools.map((t) => ({
      key: t.key,
      includeWhen: t.includeWhen,
    })),
  });

  const result = await inference({
    systemPrompt,
    userPrompt: `Classify this prompt:\n${prompt}`,
    timeout: 10000,
    expectJson: true,
  });

  if (result.success && result.parsed) {
    const parsed = result.parsed as {
      depth?: string;
      capabilities?: string[];
      thinking?: string[];
    };

    const validDepths = ["FULL", "ITERATION", "MINIMAL"];
    const depth = validDepths.includes(parsed.depth || "")
      ? (parsed.depth as "FULL" | "ITERATION" | "MINIMAL")
      : "FULL";

    const validCapKeys = capabilities.map((c) => c.key);
    const validCaps = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((c) => validCapKeys.includes(c))
      : [];

    const validToolKeys = thinkingTools.map((t) => t.key);
    const validTools = Array.isArray(parsed.thinking)
      ? parsed.thinking.filter((t) => validToolKeys.includes(t))
      : [];

    return { depth, capabilities: validCaps, thinking: validTools };
  }

  // Inference failed — safe default
  return { depth: "FULL", capabilities: [], thinking: [] };
}

/**
 * Build reminder from template
 */
async function buildReminder(result: ClassificationResult, assistantName: string): Promise<string> {
  const capabilities = await discoverCapabilities();
  const thinkingTools = await discoverThinkingTools();

  // Map capability keys to full capability info
  const selectedCaps = result.capabilities
    .map((key) => capabilities.find((c) => c.key === key))
    .filter((c): c is Capability => c !== undefined)
    .map((c) => ({ name: c.name, agents: c.agents }));

  // Map thinking tool keys to full tool info
  const selectedTools = result.thinking
    .map((key) => thinkingTools.find((t) => t.key === key))
    .filter((t): t is ThinkingTool => t !== undefined)
    .map((t) => ({ name: t.name, description: t.description }));

  const data: TemplateData = {
    assistantName,
    capabilities: selectedCaps,
    thinking: selectedTools,
  };

  // Select template based on depth
  const templateName = `reminder-${result.depth.toLowerCase()}`;

  try {
    return (await eta.renderAsync(templateName, data)) || "";
  } catch {
    // Fallback if template fails
    return `<system-reminder>
ALGORITHM REQUIRED — DEPTH: ${result.depth}
Nothing escapes the Algorithm. Use the ${result.depth} format.
</system-reminder>`;
  }
}

async function main() {
  try {
    // Skip for subagents
    if (isSubagent()) {
      process.exit(0);
    }

    const input = await readStdin();
    if (!input) {
      process.exit(0);
    }

    const data = JSON.parse(input);
    const prompt = data.prompt || data.user_prompt || "";

    if (!prompt) {
      process.exit(0);
    }

    const assistantName = await getAssistantName(SHAKA_HOME);
    const result = await classifyPrompt(prompt);
    const reminder = await buildReminder(result, assistantName);

    console.log(reminder);
    process.exit(0);
  } catch {
    // On any error, output FULL as safe default
    console.log(`<system-reminder>
ALGORITHM REQUIRED — DEPTH: FULL
Nothing escapes the Algorithm. Your response MUST use the 7-phase format.
</system-reminder>`);
    process.exit(0);
  }
}

if (import.meta.main) {
  main();
}
