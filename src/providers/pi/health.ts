import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderHealthItem } from "../types";
import { checkPiCredentials } from "./credentials";

export function checkPiHealth(piHome?: string): ProviderHealthItem[] {
  const creds = checkPiCredentials({
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_OAUTH_TOKEN: process.env.ANTHROPIC_OAUTH_TOKEN,
    },
    hasAuthFile: piAuthFileExists(piHome),
  });

  return [
    {
      label: "Credentials",
      ok: creds.ok,
      issue: creds.ok ? undefined : creds.issue,
    },
  ];
}

function piAuthFileExists(piHomeOverride?: string): boolean {
  const piHome =
    piHomeOverride ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  try {
    return statSync(join(piHome, "auth.json")).isFile();
  } catch {
    return false;
  }
}
