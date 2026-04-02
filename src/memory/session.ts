import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import { sessions } from '../db/schema';

export type SessionStatus = 'active' | 'closed';
export type ClosedReason = 'resolved' | 'reassigned' | 'manual';

export interface Session {
  id: number;
  workItemId: number;
  adoOrg: string;
  project: string;
  repo: string;
  branch: string;
  worktreePath?: string | null;
  title: string;
  status: SessionStatus;
  closedReason?: ClosedReason | null;
  contextSummary?: string | null;
  createdAt: number;
  lastActivityAt: number;
  closedAt?: number | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Session CRUD
// ══════════════════════════════════════════════════════════════════════════════

export function createSession(data: {
  workItemId: number;
  adoOrg: string;
  project: string;
  repo: string;
  title: string;
}): Session {
  const db = getDb();
  const now = Date.now();
  const result = db.insert(sessions).values({
    ...data,
    branch: '',
    status: 'active',
    createdAt: now,
    lastActivityAt: now,
  }).returning().get();
  return result as unknown as Session;
}

export function getSession(id: number): Session | null {
  const db = getDb();
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  return (row as unknown as Session) ?? null;
}

export function getSessionByWorkItem(workItemId: number): Session | null {
  const db = getDb();
  const row = db.select().from(sessions)
    .where(eq(sessions.workItemId, workItemId))
    .get();
  return (row as unknown as Session) ?? null;
}

export function getActiveSessionByWorkItem(workItemId: number): Session | null {
  const db = getDb();
  const row = db.select().from(sessions)
    .where(and(
      eq(sessions.workItemId, workItemId),
      eq(sessions.status, 'active'),
    ))
    .get();
  return (row as unknown as Session) ?? null;
}

export function getAllSessions(): Session[] {
  const db = getDb();
  return db.select().from(sessions).all() as unknown as Session[];
}

export function getActiveSessions(): Session[] {
  const db = getDb();
  return db.select().from(sessions)
    .where(eq(sessions.status, 'active'))
    .all() as unknown as Session[];
}

// ══════════════════════════════════════════════════════════════════════════════
// Session Updates
// ══════════════════════════════════════════════════════════════════════════════

export function updateSessionBranch(id: number, branch: string): void {
  const db = getDb();
  db.update(sessions)
    .set({ branch, lastActivityAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function updateSessionWorktreePath(id: number, worktreePath: string): void {
  const db = getDb();
  db.update(sessions)
    .set({ worktreePath, lastActivityAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function updateSessionTitle(id: number, title: string): void {
  const db = getDb();
  db.update(sessions)
    .set({ title, lastActivityAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function updateSessionContextSummary(id: number, contextSummary: string): void {
  const db = getDb();
  db.update(sessions)
    .set({ contextSummary, lastActivityAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function touchSession(id: number): void {
  const db = getDb();
  db.update(sessions)
    .set({ lastActivityAt: Date.now() })
    .where(eq(sessions.id, id))
    .run();
}

export function closeSession(id: number, reason: ClosedReason): void {
  const db = getDb();
  const now = Date.now();
  db.update(sessions)
    .set({
      status: 'closed',
      closedReason: reason,
      closedAt: now,
      lastActivityAt: now,
    })
    .where(eq(sessions.id, id))
    .run();
}

/**
 * Get or create a session for a work item.
 * If an active session exists, returns it.
 * If a closed session exists, returns null (caller should decide whether to reopen).
 * If no session exists, creates a new one.
 */
export function getOrCreateSession(data: {
  workItemId: number;
  adoOrg: string;
  project: string;
  repo: string;
  title: string;
}): { session: Session; isNew: boolean } {
  const existing = getSessionByWorkItem(data.workItemId);
  
  if (existing) {
    if (existing.status === 'active') {
      return { session: existing, isNew: false };
    }
    // Session exists but is closed — return it, let caller decide
    return { session: existing, isNew: false };
  }
  
  const session = createSession(data);
  return { session, isNew: true };
}

/**
 * Reopen a closed session (e.g., if WI was reopened).
 */
export function reopenSession(id: number): void {
  const db = getDb();
  db.update(sessions)
    .set({
      status: 'active',
      closedReason: null,
      closedAt: null,
      lastActivityAt: Date.now(),
    })
    .where(eq(sessions.id, id))
    .run();
}
