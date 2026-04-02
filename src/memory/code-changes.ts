import { getDb } from '../db/client';
import { codeChanges } from '../db/schema';

export function recordCodeChange(
  pipelineRunId: number,
  taskId: number,
  filePath: string,
  beforeHash: string | null,
  afterHash: string,
): void {
  const db = getDb();
  db.insert(codeChanges).values({
    pipelineRunId,
    taskId,
    filePath,
    beforeHash,
    afterHash,
    createdAt: Date.now(),
  }).run();
}
