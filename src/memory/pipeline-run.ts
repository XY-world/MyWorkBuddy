import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { pipelineRuns } from '../db/schema';
import { PipelineBlueprint } from '../agents/pipeline-types';

export type RunPhase =
  | 'pending'
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

export type RunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'paused';
export type TriggerSource = 'user' | 'pr_comment' | 'wi_change' | 'scheduled';

export interface PipelineRun {
  id: number;
  sessionId: number;
  type: string;
  blueprint?: PipelineBlueprint | null;
  phase: RunPhase;
  status: RunStatus;
  triggeredBy: TriggerSource;
  prId?: number | null;
  prUrl?: string | null;
  errorMessage?: string | null;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline Run CRUD
// ══════════════════════════════════════════════════════════════════════════════

export function createPipelineRun(data: {
  sessionId: number;
  type: string;
  triggeredBy: TriggerSource;
  blueprint?: PipelineBlueprint;
}): PipelineRun {
  const db = getDb();
  const now = Date.now();
  const result = db.insert(pipelineRuns).values({
    sessionId: data.sessionId,
    type: data.type,
    blueprintJson: data.blueprint ? JSON.stringify(data.blueprint) : null,
    phase: 'pending',
    status: 'queued',
    triggeredBy: data.triggeredBy,
    createdAt: now,
  }).returning().get();
  
  return parseRun(result);
}

export function getPipelineRun(id: number): PipelineRun | null {
  const db = getDb();
  const row = db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)).get();
  return row ? parseRun(row) : null;
}

export function getRunsForSession(sessionId: number): PipelineRun[] {
  const db = getDb();
  const rows = db.select().from(pipelineRuns)
    .where(eq(pipelineRuns.sessionId, sessionId))
    .orderBy(desc(pipelineRuns.createdAt))
    .all();
  return rows.map(parseRun);
}

export function getActiveRunForSession(sessionId: number): PipelineRun | null {
  const db = getDb();
  const row = db.select().from(pipelineRuns)
    .where(and(
      eq(pipelineRuns.sessionId, sessionId),
      eq(pipelineRuns.status, 'running'),
    ))
    .get();
  return row ? parseRun(row) : null;
}

export function getQueuedRunsForSession(sessionId: number): PipelineRun[] {
  const db = getDb();
  const rows = db.select().from(pipelineRuns)
    .where(and(
      eq(pipelineRuns.sessionId, sessionId),
      eq(pipelineRuns.status, 'queued'),
    ))
    .orderBy(pipelineRuns.createdAt)
    .all();
  return rows.map(parseRun);
}

export function getLatestRunForSession(sessionId: number): PipelineRun | null {
  const db = getDb();
  const row = db.select().from(pipelineRuns)
    .where(eq(pipelineRuns.sessionId, sessionId))
    .orderBy(desc(pipelineRuns.createdAt))
    .limit(1)
    .get();
  return row ? parseRun(row) : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline Run Updates
// ══════════════════════════════════════════════════════════════════════════════

export function updateRunPhase(id: number, phase: RunPhase): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ phase })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function updateRunStatus(id: number, status: RunStatus): void {
  const db = getDb();
  const updates: Record<string, unknown> = { status };
  
  if (status === 'running') {
    updates.startedAt = Date.now();
  } else if (status === 'complete' || status === 'failed') {
    updates.completedAt = Date.now();
  }
  
  db.update(pipelineRuns)
    .set(updates)
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function updateRunBlueprint(id: number, blueprint: PipelineBlueprint): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ blueprintJson: JSON.stringify(blueprint) })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function updateRunPr(id: number, prId: number, prUrl: string): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ prId, prUrl })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function updateRunError(id: number, errorMessage: string): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ errorMessage, status: 'failed', completedAt: Date.now() })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function startRun(id: number): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ status: 'running', startedAt: Date.now(), phase: 'wi_review' })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function completeRun(id: number): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ status: 'complete', phase: 'complete', completedAt: Date.now() })
    .where(eq(pipelineRuns.id, id))
    .run();
}

export function pauseRun(id: number): void {
  const db = getDb();
  db.update(pipelineRuns)
    .set({ status: 'paused' })
    .where(eq(pipelineRuns.id, id))
    .run();
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function parseRun(row: unknown): PipelineRun {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as number,
    sessionId: r.sessionId as number,
    type: r.type as string,
    blueprint: r.blueprintJson ? JSON.parse(r.blueprintJson as string) : null,
    phase: r.phase as RunPhase,
    status: r.status as RunStatus,
    triggeredBy: r.triggeredBy as TriggerSource,
    prId: r.prId as number | null,
    prUrl: r.prUrl as string | null,
    errorMessage: r.errorMessage as string | null,
    createdAt: r.createdAt as number,
    startedAt: r.startedAt as number | null,
    completedAt: r.completedAt as number | null,
  };
}

/**
 * Check if a session has any running or queued runs.
 */
export function sessionHasPendingRuns(sessionId: number): boolean {
  const db = getDb();
  const row = db.select().from(pipelineRuns)
    .where(and(
      eq(pipelineRuns.sessionId, sessionId),
    ))
    .get();
  
  if (!row) return false;
  const status = (row as Record<string, unknown>).status as string;
  return status === 'queued' || status === 'running';
}
