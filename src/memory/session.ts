import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { workItemSessions } from '../db/schema';

export type Phase =
  | 'wi_review'
  | 'init'
  | 'planning'
  | 'development'
  | 'review'
  | 'revision'
  | 'pr_creation'
  | 'pr_monitoring'
  | 'pr_fix'
  | 'investigation'
  | 'draft_comment'
  | 'post_comment'
  | 'complete';

export type SessionStatus = 'active' | 'complete' | 'failed' | 'paused';

export interface WorkItemSession {
  id: number;
  workItemId: number;
  adoOrg: string;
  project: string;
  repo: string;
  branch: string;
  title: string;
  status: SessionStatus;
  phase: Phase;
  prUrl?: string | null;
  worktreePath?: string | null;
  createdAt: number;
  updatedAt: number;
}

export function createSession(data: Omit<WorkItemSession, 'id' | 'createdAt' | 'updatedAt'>): WorkItemSession {
  const db = getDb();
  const now = Date.now();
  const result = db.insert(workItemSessions).values({ ...data, createdAt: now, updatedAt: now }).returning().get();
  return result as unknown as WorkItemSession;
}

export function getSession(id: number): WorkItemSession | null {
  const db = getDb();
  const row = db.select().from(workItemSessions).where(eq(workItemSessions.id, id)).get();
  return (row as unknown as WorkItemSession) ?? null;
}

export function getSessionByWorkItem(workItemId: number): WorkItemSession | null {
  const db = getDb();
  const row = db.select().from(workItemSessions)
    .where(eq(workItemSessions.workItemId, workItemId))
    .get();
  return (row as unknown as WorkItemSession) ?? null;
}

export function getAllSessions(): WorkItemSession[] {
  const db = getDb();
  return db.select().from(workItemSessions).all() as unknown as WorkItemSession[];
}

export function updateSessionPhase(id: number, phase: Phase): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ phase, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}

export function updateSessionStatus(id: number, status: SessionStatus): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ status, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}

export function updateSessionBranch(id: number, branch: string): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ branch, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}

export function updateSessionTitle(id: number, title: string): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ title, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}

export function updateSessionPrUrl(id: number, prUrl: string): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ prUrl, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}

export function updateSessionWorktreePath(id: number, worktreePath: string): void {
  const db = getDb();
  db.update(workItemSessions)
    .set({ worktreePath, updatedAt: Date.now() })
    .where(eq(workItemSessions.id, id))
    .run();
}
