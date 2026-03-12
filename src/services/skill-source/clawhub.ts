/**
 * Clawhub skill source provider.
 *
 * Fetches skills from the Clawhub registry (clawhub.ai) via HTTP.
 * Skills are distributed as ZIP archives containing SKILL.md + supporting files.
 *
 * API:
 *   GET /api/v1/skills/{slug}                          → { latestVersion: { version } }
 *   GET /api/v1/download?slug=<slug>&version=<version> → ZIP bytes
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Result, err, ok } from "../../domain/result";
import { cleanupTempDir } from "../skill-pipeline";
import type { FetchResult, SkillSourceProvider } from "./types";

const DEFAULT_REGISTRY = "https://clawhub.ai";

/** Parsed Clawhub input: slug + optional version. */
export interface ClawhubInput {
  slug: string;
  version: string | undefined;
}

/**
 * Fetches a skill from the registry to a local directory.
 * Returns the resolved version string.
 */
export type ClawhubFetchFn = (
  slug: string,
  version: string | undefined,
  destDir: string,
) => Promise<Result<{ version: string }, Error>>;

export type ClawdhubFetchFn = ClawhubFetchFn;

export interface ClawhubProviderOptions {
  /** Override the registry URL (default: https://clawhub.ai, env: CLAWHUB_REGISTRY). */
  registryUrl?: string;
  /** Override fetch+extract for testing. */
  fetchSkill?: ClawhubFetchFn;
}

/** Parse a Clawhub input string into slug and optional version. */
export function parseClawhubInput(input: string): ClawhubInput {
  const trimmed = input.trim();
  const atIdx = trimmed.lastIndexOf("@");

  if (atIdx > 0) {
    return {
      slug: trimmed.slice(0, atIdx).toLowerCase(),
      version: trimmed.slice(atIdx + 1),
    };
  }

  return { slug: trimmed.toLowerCase(), version: undefined };
}

/** Create a Clawhub skill source provider. */
export function createClawhubProvider(options: ClawhubProviderOptions = {}): SkillSourceProvider {
  const registryUrl = options.registryUrl ?? process.env.CLAWHUB_REGISTRY ?? DEFAULT_REGISTRY;
  const fetchSkillFn = options.fetchSkill ?? createDefaultFetchSkill(registryUrl);

  return {
    name: "clawhub",

    canHandle(input: string): boolean {
      const trimmed = input.trim();
      // Bare words only — no slashes, no URL schemes
      return (
        !trimmed.includes("/") && !trimmed.startsWith("https://") && !trimmed.startsWith("git@")
      );
    },

    async fetch(input: string): Promise<Result<FetchResult, Error>> {
      const { slug, version } = parseClawhubInput(input);

      const tempDir = join(
        tmpdir(),
        `shaka-clawhub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
      try {
        await mkdir(tempDir, { recursive: true });

        const result = await fetchSkillFn(slug, version, tempDir);
        if (!result.ok) {
          await cleanupTempDir(tempDir).catch(() => {});
          return result;
        }

        return ok({
          skillDir: tempDir,
          tempDir,
          version: result.value.version,
          source: slug,
          subdirectory: null,
        });
      } catch (e) {
        await cleanupTempDir(tempDir).catch(() => {});
        return err(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

// --- Default implementations ---

function createDefaultFetchSkill(registryUrl: string): ClawhubFetchFn {
  return async (slug, version, destDir) => {
    // 1. Resolve version if not specified via skill metadata endpoint
    let resolvedVersion: string;
    if (version) {
      resolvedVersion = version;
    } else {
      const metaUrl = `${registryUrl}/api/v1/skills/${encodeURIComponent(slug)}`;
      const metaRes = await safeFetch(metaUrl);
      if (!metaRes.ok) return metaRes;

      const body = (await metaRes.value.json()) as {
        latestVersion: { version: string } | null;
      };
      if (!body.latestVersion) {
        return err(new Error(`No published version found for "${slug}"`));
      }
      resolvedVersion = body.latestVersion.version;
    }

    // 2. Download ZIP
    const downloadUrl = `${registryUrl}/api/v1/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(resolvedVersion)}`;
    const downloadRes = await safeFetch(downloadUrl);
    if (!downloadRes.ok) return downloadRes;

    // 3. Extract ZIP
    const zipBytes = new Uint8Array(await downloadRes.value.arrayBuffer());
    const zipPath = join(destDir, "_download.zip");
    await Bun.write(zipPath, zipBytes);

    try {
      await extractZipArchive(zipPath, destDir);
    } catch (e) {
      return err(new Error(`Failed to extract ZIP: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      await rm(zipPath, { force: true }).catch(() => {});
    }

    return ok({ version: resolvedVersion });
  };
}

async function safeFetch(url: string): Promise<Result<Response, Error>> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return err(new Error(`HTTP ${res.status}: ${res.statusText} (${url})`));
    }
    return ok(res);
  } catch (e) {
    return err(new Error(`Network error: ${e instanceof Error ? e.message : String(e)}`));
  }
}

async function extractZipArchive(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    const command = [
      "Expand-Archive",
      "-LiteralPath",
      `'${escapePowerShellLiteral(zipPath)}'`,
      "-DestinationPath",
      `'${escapePowerShellLiteral(destDir)}'`,
      "-Force",
    ].join(" ");
    await Bun.$`powershell -NoProfile -NonInteractive -Command ${command}`.quiet();
    return;
  }

  await Bun.$`unzip -o ${zipPath} -d ${destDir}`.quiet();
}

function escapePowerShellLiteral(input: string): string {
  return input.replace(/'/g, "''");
}

// Backward-compatible aliases (deprecated): remove in next major.
export type ClawdhubInput = ClawhubInput;
export type ClawdhubProviderOptions = ClawhubProviderOptions;
export const parseClawdhubInput = parseClawhubInput;
export const createClawdhubProvider = createClawhubProvider;
