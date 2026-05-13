import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface Finding {
  rule: string;
  path: string;
  detail: string;
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(toPosixPath(path));
    }
  }
  return files;
}

async function textFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function checkLineCounts(findings: Finding[]): Promise<void> {
  const files = await walk("src");
  const watched = files.filter(
    (path) =>
      /src\/providers\/[^/]+\/configurer\.ts$/.test(path) ||
      path === "src/inference.ts" ||
      path === "src/domain/agent-execution.ts" ||
      path === "src/services/setup-session.ts",
  );

  for (const path of watched) {
    const lines = (await textFile(path)).split("\n").length;
    if (lines > 700) {
      findings.push({
        rule: "large-file",
        path,
        detail: `${lines} lines; split by provider responsibility before adding more behavior`,
      });
    }
  }
}

async function checkProviderBranches(findings: Finding[]): Promise<void> {
  const pattern =
    /case\s+"(?:claude|opencode|codex|pi)"|provider\s*===|detected\.(?:claude|opencode|codex|pi)/;
  for (const path of await walk("src")) {
    if (!path.endsWith(".ts")) continue;
    if (path.startsWith("src/providers/")) continue;
    const lines = (await textFile(path)).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push({
          rule: "provider-branch-outside-provider",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
    });
  }
}

async function checkForbiddenPatterns(findings: Finding[]): Promise<void> {
  const targets = [...(await walk("src")), ...(await walk("test")), ...(await walk("docs"))].filter(
    (path) => /\.(ts|tsx|js|md)$/.test(path),
  );

  for (const path of targets) {
    const lines = (await textFile(path)).split("\n");
    lines.forEach((line, index) => {
      if (!path.startsWith("src/providers/") && /\bpi(Model|Provider)\b/.test(line)) {
        findings.push({
          rule: "provider-specific-generic-option",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
      if (/shaka\/(?:inference|autoresearch-setup)/.test(line) && !line.includes("not.toContain")) {
        findings.push({
          rule: "opencode-agent-namespace",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
    });
  }
}

async function checkDuplicateKillChains(findings: Finding[]): Promise<void> {
  for (const path of [...(await walk("src")), ...(await walk("defaults"))]) {
    if (!/\.(ts|js)$/.test(path)) continue;
    if (path === "src/platform/process-runner.ts") continue;
    const text = await textFile(path);
    if (text.includes("SIGTERM") && text.includes("SIGKILL")) {
      findings.push({
        rule: "duplicate-process-timeout-chain",
        path,
        detail: "contains SIGTERM/SIGKILL timeout handling outside the shared process runner",
      });
    }
  }
}

const findings: Finding[] = [];
await checkLineCounts(findings);
await checkProviderBranches(findings);
await checkForbiddenPatterns(findings);
await checkDuplicateKillChains(findings);

console.log("Architecture tripwires (warning-only)");
if (findings.length === 0) {
  console.log("  no warnings");
} else {
  for (const finding of findings) {
    console.log(`  WARN ${finding.rule}: ${finding.path}`);
    console.log(`       ${finding.detail}`);
  }
}
