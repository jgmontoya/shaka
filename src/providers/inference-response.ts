import type { InferenceResult } from "../inference";

export function parseResponse(
  text: string,
  expectJson?: boolean,
  provider?: string,
): InferenceResult {
  if (!expectJson) {
    return { success: true, text, provider };
  }

  try {
    const parsed = JSON.parse(text.trim());
    return { success: true, text, parsed, provider };
  } catch {
    // Fall back to extracting an object from model output with surrounding prose.
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return { success: true, text, parsed, provider };
    } catch {
      return { success: true, text, provider };
    }
  }

  return { success: true, text, provider };
}
