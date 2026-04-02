import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import { tasks } from '../db/schema';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type TaskAgent = 'pm' | 'dev' | 'review' | 'wi_review' | 'pr_fix' | 'investigation';

export interface Task {
  id: number;
  pipelineRunId: number;
  seq: number;
  title: string;
  description: string;
  agent: TaskAgent;
  status: TaskStatus;
  resultSummary?: string | null;
  createdAt: number;
  updatedAt: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Task CRUD
// ══════════════════════════════════════════════════════════════════════════════

export function createTask(data: {
  pipelineRunId: number;
  seq: number;
  title: string;
  description: string;
  agent: TaskAgent;
  status: TaskStatus;
  resultSummary?: string | null;
}): Task {
  const db = getDb();
  const now = Date.now();
  const result = db.insert(tasks).values({
    ...data,
    resultSummary: data.resultSummary ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning().get();
  return result as unknown as Task;
}

export function getTask(id: number): Task | null {
  const db = getDb();
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return (row as unknown as Task) ?? null;
}

export function getTasksForRun(pipelineRunId: number): Task[] {
  const db = getDb();
  return db.select().from(tasks)
    .where(eq(tasks.pipelineRunId, pipelineRunId))
    .all() as unknown as Task[];
}

export function getPendingTasksForRun(pipelineRunId: number): Task[] {
  const db = getDb();
  return db.select().from(tasks)
    .where(and(
      eq(tasks.pipelineRunId, pipelineRunId),
      eq(tasks.status, 'pending'),
    ))
    .all() as unknown as Task[];
}

export function getNextPendingTask(pipelineRunId: number, agent: TaskAgent): Task | null {
  const db = getDb();
  const row = db.select().from(tasks)
    .where(and(
      eq(tasks.pipelineRunId, pipelineRunId),
      eq(tasks.status, 'pending'),
      eq(tasks.agent, agent),
    ))
    .limit(1)
    .get();
  return (row as unknown as Task) ?? null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Task Updates
// ══════════════════════════════════════════════════════════════════════════════

export function updateTaskStatus(id: number, status: TaskStatus, resultSummary?: string): void {
  const db = getDb();
  db.update(tasks)
    .set({
      status,
      resultSummary: resultSummary ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(tasks.id, id))
    .run();
}

export function resetTasksForRun(pipelineRunId: number): void {
  const db = getDb();
  db.update(tasks)
    .set({ status: 'pending', resultSummary: null, updatedAt: Date.now() })
    .where(eq(tasks.pipelineRunId, pipelineRunId))
    .run();
}

export function resetDevTasksForRun(pipelineRunId: number): void {
  const db = getDb();
  db.update(tasks)
    .set({ status: 'pending', resultSummary: null, updatedAt: Date.now() })
    .where(and(
      eq(tasks.pipelineRunId, pipelineRunId),
      eq(tasks.agent, 'dev'),
    ))
    .run();
}

// ══════════════════════════════════════════════════════════════════════════════
// Legacy compatibility
// ══════════════════════════════════════════════════════════════════════════════

/** @deprecated Use getTasksForRun instead */
export const getTasksForSession = getTasksForRun;
