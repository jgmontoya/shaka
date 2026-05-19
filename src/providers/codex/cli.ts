import { type Result, err, ok } from "../../domain/result";

export type CodexCommandRunner = (args: string[]) => Promise<{ exitCode: number; stderr: string }>;

export async function defaultRunCommand(
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const stderrPromise = new Response(proc.stderr).text();
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  return { exitCode, stderr: stderr.trim() };
}

function isMissingMcpServer(stderr: string): boolean {
  return /^(?:mcp\s+)?server(?:\s+["']?shaka["']?)?\s+not found\.?$/i.test(stderr.trim());
}

export async function enableHooksFeature(runCommand: CodexCommandRunner): Promise<void> {
  const command = "codex features enable hooks";
  try {
    const { exitCode, stderr } = await runCommand(["codex", "features", "enable", "hooks"]);
    if (exitCode === 0) {
      console.log("Enabled hooks feature flag in ~/.codex/config.toml");
      return;
    }
    const detail = stderr.trim() || "no stderr";
    throw new Error(`${command} failed (exit ${exitCode}): ${detail}. Please run: ${command}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${command} failed`)) throw error;
    throw new Error(
      `Failed to enable Codex hooks feature: ${error instanceof Error ? error.message : String(error)}. Please run: ${command}`,
    );
  }
}

export async function registerCodexMcpServer(
  runCommand: CodexCommandRunner,
): Promise<Result<void, Error>> {
  try {
    const { exitCode, stderr } = await runCommand([
      "codex",
      "mcp",
      "add",
      "shaka",
      "--",
      "shaka",
      "mcp",
      "serve",
    ]);
    if (exitCode !== 0) {
      return err(new Error(`codex mcp add failed (exit ${exitCode}): ${stderr}`));
    }
    return ok(undefined);
  } catch (e) {
    return err(
      new Error(`Failed to register MCP server: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

export async function unregisterCodexMcpServer(
  runCommand: CodexCommandRunner,
): Promise<Result<void, Error>> {
  try {
    const { exitCode, stderr } = await runCommand(["codex", "mcp", "remove", "shaka"]);
    if (exitCode !== 0 && !isMissingMcpServer(stderr)) {
      return err(new Error(`codex mcp remove failed (exit ${exitCode}): ${stderr}`));
    }
    return ok(undefined);
  } catch (e) {
    return err(
      new Error(`Failed to unregister MCP server: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}
