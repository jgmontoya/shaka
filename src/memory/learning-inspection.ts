/** Read-only integrity inspection for active and archived learnings storage. */

import { join } from "node:path";
import { inspectLearningFileStatus } from "./learning-file";
import { ARCHIVE_FILE, type LearningDiagnosticCode, parseLearningsDocument } from "./learnings";

const ACTIVE_LEARNINGS_FILE = "learnings.md";

export type LearningStorageDiagnosticCode = LearningDiagnosticCode | "unreadable-learning-file";

export interface LearningStorageDiagnostic {
  readonly code: LearningStorageDiagnosticCode;
  readonly severity: "error";
  readonly filePath: string;
  readonly title?: string;
  readonly message: string;
}

function unreadableFileDiagnostic(filePath: string, message: string): LearningStorageDiagnostic[] {
  return [
    {
      code: "unreadable-learning-file",
      severity: "error",
      filePath,
      message,
    },
  ];
}

async function inspectLearningFile(filePath: string): Promise<LearningStorageDiagnostic[]> {
  const status = await inspectLearningFileStatus(filePath);
  if (status.kind === "missing") return [];
  if (status.kind === "invalid") return unreadableFileDiagnostic(filePath, status.message);

  const content = await Bun.file(filePath)
    .text()
    .catch(() => null);
  if (content === null) {
    return unreadableFileDiagnostic(filePath, "Learning storage file could not be read.");
  }
  return parseLearningsDocument(content).diagnostics.map((diagnostic) => ({
    ...diagnostic,
    severity: "error",
    filePath,
  }));
}

/** Inspect learnings storage without repairing or mutating it. */
export async function inspectLearningStorage(
  memoryDir: string,
): Promise<LearningStorageDiagnostic[]> {
  const diagnostics = await Promise.all(
    [ACTIVE_LEARNINGS_FILE, ARCHIVE_FILE].map((fileName) =>
      inspectLearningFile(join(memoryDir, fileName)),
    ),
  );
  return diagnostics.flat();
}
