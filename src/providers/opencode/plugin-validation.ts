import { type Result, err, ok } from "../../domain/result";

export async function validateOpencodePluginSyntax(
  pluginPath: string,
): Promise<Result<void, Error>> {
  const result = await Bun.build({
    entrypoints: [pluginPath],
    throw: false,
    // `@opencode-ai/plugin` is resolved by opencode's plugin runtime
    // (~/.config/opencode/node_modules/), not at install time. Marking it
    // external lets us syntax-check the generated plugin even when the
    // host machine doesn't have the package on disk yet.
    external: ["@opencode-ai/plugin"],
  });

  if (!result.success) {
    const errors = result.logs
      .filter((log) => log.level === "error")
      .map((log) => log.message)
      .join("\n");
    return err(new Error(`Generated plugin has syntax errors:\n${errors}`));
  }

  return ok(undefined);
}
