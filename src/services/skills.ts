/**
 * Runtime skill-body loading from SHAKA_HOME.
 *
 * Customization wins over the shipped default, matching Shaka's resolution
 * order everywhere else. Returns an empty string when neither path exists —
 * callers are expected to tolerate an empty skill.
 */

import { join } from "node:path";
import { resolveShakaHome } from "../domain/config";

export async function loadSkill(name: string): Promise<string> {
  const shakaHome = resolveShakaHome();
  const candidates = [
    join(shakaHome, "customizations", "skills", name, "SKILL.md"),
    join(shakaHome, "system", "skills", name, "SKILL.md"),
  ];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) return file.text();
  }
  return "";
}
