import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

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

function dependencyArgument(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isImportTypeNode(node)) {
    return ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

function dependencySpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  const argument = dependencyArgument(node);
  return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
}

function configurationError(diagnostics: readonly ts.Diagnostic[]): Error {
  const details = diagnostics
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
  return new Error(`Invalid tsconfig.json:\n${details}`);
}

function compilerOptions(): ts.CompilerOptions {
  const config = ts.readConfigFile(toPosixPath(resolve("tsconfig.json")), ts.sys.readFile);
  if (config.error) {
    throw configurationError([config.error]);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  if (parsed.errors.length > 0) {
    throw configurationError(parsed.errors);
  }
  return parsed.options;
}

function concreteProvider(path: string): string | undefined {
  return /^src\/providers\/([^/]+)\//.exec(path)?.[1];
}

function providerDependency(
  node: ts.Node,
  source: ts.SourceFile,
  options: ts.CompilerOptions,
): Finding | undefined {
  const specifier = dependencySpecifier(node);
  if (!specifier) return;
  const resolved = ts.resolveModuleName(specifier.text, resolve(source.fileName), options, ts.sys);
  const target = resolved.resolvedModule?.resolvedFileName;
  if (!target) return;
  const targetPath = toPosixPath(relative(process.cwd(), target));
  const targetProvider = concreteProvider(targetPath);
  const sourceProvider = concreteProvider(source.fileName);
  if (!targetProvider || targetProvider === sourceProvider) return;

  const { line } = source.getLineAndCharacterOfPosition(specifier.getStart(source));
  const guidance = sourceProvider
    ? "move shared behavior to a generic provider helper"
    : "use provider capabilities instead";
  return {
    rule: sourceProvider ? "cross-provider-dependency" : "concrete-provider-dependency",
    path: `${source.fileName}:${line + 1}`,
    detail: `${specifier.text} resolves to ${targetPath}; ${guidance}`,
  };
}

async function checkProviderDependencies(errors: Finding[]): Promise<void> {
  const options = compilerOptions();

  for (const path of await walk("src")) {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) continue;
    const sourceProvider = concreteProvider(path);
    if (path.startsWith("src/providers/") && !sourceProvider) continue;
    const source = ts.createSourceFile(path, await textFile(path), ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      const finding = providerDependency(node, source, options);
      if (finding) errors.push(finding);
      ts.forEachChild(node, visit);
    }

    visit(source);
  }
}

async function checkLineCounts(warnings: Finding[]): Promise<void> {
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
      warnings.push({
        rule: "large-file",
        path,
        detail: `${lines} lines; split by provider responsibility before adding more behavior`,
      });
    }
  }
}

async function checkProviderBranches(warnings: Finding[]): Promise<void> {
  const pattern =
    /case\s+"(?:claude|opencode|codex|pi)"|provider\s*===|detected\.(?:claude|opencode|codex|pi)/;
  for (const path of await walk("src")) {
    if (!path.endsWith(".ts")) continue;
    if (path.startsWith("src/providers/")) continue;
    const lines = (await textFile(path)).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        warnings.push({
          rule: "provider-branch-outside-provider",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
    });
  }
}

async function checkForbiddenPatterns(warnings: Finding[]): Promise<void> {
  const targets = [...(await walk("src")), ...(await walk("test")), ...(await walk("docs"))].filter(
    (path) => /\.(ts|tsx|js|md)$/.test(path),
  );

  for (const path of targets) {
    const lines = (await textFile(path)).split("\n");
    lines.forEach((line, index) => {
      if (!path.startsWith("src/providers/") && /\bpi(Model|Provider)\b/.test(line)) {
        warnings.push({
          rule: "provider-specific-generic-option",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
      if (/shaka\/(?:inference|autoresearch-setup)/.test(line) && !line.includes("not.toContain")) {
        warnings.push({
          rule: "opencode-agent-namespace",
          path: `${path}:${index + 1}`,
          detail: line.trim(),
        });
      }
    });
  }
}

async function checkDuplicateKillChains(warnings: Finding[]): Promise<void> {
  for (const path of [...(await walk("src")), ...(await walk("defaults"))]) {
    if (!/\.(ts|js)$/.test(path)) continue;
    if (path === "src/platform/process-runner.ts") continue;
    const text = await textFile(path);
    if (text.includes("SIGTERM") && text.includes("SIGKILL")) {
      warnings.push({
        rule: "duplicate-process-timeout-chain",
        path,
        detail: "contains SIGTERM/SIGKILL timeout handling outside the shared process runner",
      });
    }
  }
}

const errors: Finding[] = [];
await checkProviderDependencies(errors);
const warnings: Finding[] = [];
await checkLineCounts(warnings);
await checkProviderBranches(warnings);
await checkForbiddenPatterns(warnings);
await checkDuplicateKillChains(warnings);

console.log("Architecture checks");
if (errors.length === 0 && warnings.length === 0) {
  console.log("  no findings");
}
for (const [severity, results] of [
  ["ERROR", errors],
  ["WARN", warnings],
] as const) {
  for (const finding of results) {
    console.log(`  ${severity} ${finding.rule}: ${finding.path}`);
    console.log(`       ${finding.detail}`);
  }
}
process.exitCode = errors.length > 0 ? 1 : 0;
