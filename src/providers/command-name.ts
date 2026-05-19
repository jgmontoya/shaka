/** Valid command name: lowercase alphanumeric with hyphens, no leading/trailing hyphens, max 64 chars. */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 64;

const RESERVED_NAMES = new Set(["shaka"]);

export function validateCommandName(name: string): string | null {
  if (RESERVED_NAMES.has(name)) {
    return `Reserved command name "${name}": collides with Shaka's skills directory`;
  }
  if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    return `Invalid command name "${name}": must match [a-z0-9], no leading/trailing hyphens, max 64 chars`;
  }
  return null;
}
