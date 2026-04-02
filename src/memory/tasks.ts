import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import { tasks } from '../db/schema';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type TaskAgent = 'pm' | 'dev' | 'review';

export interface Task {
  id: number;
  sessionId: number;
  seq: number;
  title: string;
  description: string;
  agent: TaskAgent;
  status: TaskStatus;
  resultSummary?: string | null;
  createdAt: number;
  updatedAt: number;
}

export function createTask(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Task {
  const db = getDb();
  const now = Date.now();
  const result = db.insert(tasks).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
  return result as unknown as Task;
}

export function getTasksForSession(sessionId: number): Task[] {
  const db = getDb();
  return db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).all() as unknown as Task[];
}

export function updateTaskStatus(id: number, status: TaskStatus, resultSummary?: string): void {
  const db = getDb();
  db.update(tasks)
    .set({ status, resultSummary: resultSummary ?? null, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
}
