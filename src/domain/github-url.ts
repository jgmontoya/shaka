/**
 * GitHub URL parser for skill installation.
 *
 * Normalizes various GitHub URL formats into a structured representation
 * suitable for git clone operations.
 */

import { type Result, err, ok } from "./result";

export interface ParsedGitHubUrl {
  /** GitHub username or organization. */
  readonly owner: string;
  /** Repository name (without .git suffix). */
  readonly repo: string;
  /** Git ref (branch or tag). Null if default branch. */
  readonly ref: string | null;
  /** Subdirectory within the repo. Null if root. */
  readonly subdirectory: string | null;
  /** HTTPS clone URL for git operations. */
  readonly cloneUrl: string;
}

/**
 * Parse a GitHub URL or shorthand into a structured representation.
 *
 * Supported formats:
 * - `user/repo` — shorthand, assumes GitHub
 * - `user/repo#ref` — shorthand with branch/tag/commit
 * - `https://github.com/user/repo`
 * - `https://github.com/user/repo#ref`
 * - `https://github.com/user/repo/tree/branch`
 * - `https://github.com/user/repo/tree/branch/path/to/skill`
 * - `git@github.com:user/repo.git`
 * - `git@github.com:user/repo.git#ref`
 */
export function parseGitHubUrl(input: string): Result<ParsedGitHubUrl, Error> {
  const trimmed = input.trim();

  if (!trimmed) {
    return err(new Error("URL cannot be empty"));
  }

  // SSH format: git@github.com:user/repo.git
  if (trimmed.startsWith("git@")) {
    return parseSshUrl(trimmed);
  }

  // HTTPS format: https://github.com/user/repo
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return parseHttpsUrl(trimmed);
  }

  // Shorthand: user/repo or user/repo#ref
  return parseShorthand(trimmed);
}

function parseSshUrl(input: string): Result<ParsedGitHubUrl, Error> {
  // Split off #ref fragment before parsing
  const [urlPart, ref] = splitFragment(input);

  const match = urlPart.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    return err(
      new Error(`Invalid SSH URL: "${input}". Expected format: git@github.com:user/repo.git`),
    );
  }

  const owner = match[1] as string;
  const repo = match[2] as string;
  return ok({
    owner,
    repo,
    ref,
    subdirectory: null,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  });
}

function parseHttpsUrl(input: string): Result<ParsedGitHubUrl, Error> {
  const [urlPart, fragmentRef] = splitFragment(input);

  let url: URL;
  try {
    url = new URL(urlPart);
  } catch {
    return err(new Error(`Invalid URL: "${input}"`));
  }

  if (url.hostname !== "github.com") {
    return err(new Error(`Unsupported host: "${url.hostname}". Only github.com is supported.`));
  }

  // pathname: /user/repo or /user/repo/tree/branch/path
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);

  if (parts.length < 2) {
    return err(new Error(`Invalid GitHub URL: "${input}". Expected at least user/repo in path.`));
  }

  const owner = parts[0] as string;
  const repo = parts[1] as string;
  let ref: string | null = fragmentRef;
  let subdirectory: string | null = null;

  // Handle /tree/branch/path format
  if (parts.length >= 4 && parts[2] === "tree") {
    ref = parts[3] as string;
    if (parts.length > 4) {
      subdirectory = parts.slice(4).join("/");
    }
  } else if (parts.length > 2) {
    return err(
      new Error(
        `Unsupported GitHub URL path: "${input}". Only /tree/<ref>/... URLs with subdirectories are supported.`,
      ),
    );
  }

  return ok({
    owner,
    repo,
    ref,
    subdirectory,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  });
}

function parseShorthand(input: string): Result<ParsedGitHubUrl, Error> {
  const [pathPart, ref] = splitFragment(input);

  const parts = pathPart.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return err(
      new Error(`Invalid shorthand: "${input}". Expected format: user/repo or user/repo#ref`),
    );
  }

  const [owner, repo] = parts;
  return ok({
    owner,
    repo,
    ref,
    subdirectory: null,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  });
}

/** Split a URL into [url, ref] on the first # fragment. */
function splitFragment(input: string): [string, string | null] {
  const idx = input.indexOf("#");
  if (idx === -1) return [input, null];
  const fragment = input.slice(idx + 1);
  return [input.slice(0, idx), fragment || null];
}
