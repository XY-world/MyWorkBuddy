import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { codeChanges } from '../db/schema';

export interface CodeChange {
  id: number;
  sessionId: number;
  taskId: number;
  filePath: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  diffPatch?: string | null;
  createdAt: number;
}

export function recordCodeChange(
  sessionId: number,
  taskId: number,
  filePath: string,
  beforeHash: string | null,
  afterHash: string | null,
  diffPatch?: string,
): void {
  const db = getDb();
  db.insert(codeChanges).values({
    sessionId, taskId, filePath,
    beforeHash: beforeHash ?? null,
    afterHash: afterHash ?? null,
    diffPatch: diffPatch ?? null,
    createdAt: Date.now(),
  }).run();
}

export function getCodeChanges(sessionId: number): CodeChange[] {
  const db = getDb();
  return db.select().from(codeChanges)
    .where(eq(codeChanges.sessionId, sessionId))
    .all() as unknown as CodeChange[];
}
