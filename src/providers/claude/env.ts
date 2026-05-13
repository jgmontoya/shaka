export function buildClaudeCliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return undefined;
  const token = env.SHAKA_CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return undefined;
  return { CLAUDE_CODE_OAUTH_TOKEN: token };
}
