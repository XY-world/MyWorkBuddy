import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { codeChanges } from '../db/schema';

export interface CodeChange {
  id: number;
  pipelineRunId: number;
  taskId: number;
  filePath: string;
  beforeHash: string | null;
  afterHash: string | null;
  diffPatch: string | null;
  createdAt: number;
}

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

export function getCodeChanges(pipelineRunId: number): CodeChange[] {
  const db = getDb();
  const rows = db.select().from(codeChanges)
    .where(eq(codeChanges.pipelineRunId, pipelineRunId))
    .all();
  
  return rows.map((r: any) => ({
    id: r.id,
    pipelineRunId: r.pipelineRunId,
    taskId: r.taskId,
    filePath: r.filePath,
    beforeHash: r.beforeHash,
    afterHash: r.afterHash,
    diffPatch: r.diffPatch,
    createdAt: r.createdAt,
  }));
}
