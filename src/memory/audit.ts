import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { auditLog } from '../db/schema';

export type AuditEventType = 'info' | 'tool_call' | 'decision' | 'error' | 'state_change' | 'warn';

export interface AuditEvent {
  id: number;
  sessionId: number;
  pipelineRunId?: number | null;
  timestamp: number;
  phase: string;
  agent: string;
  eventType: AuditEventType;
  message: string;
  metadata?: unknown;
}

export function appendAuditEvent(
  sessionId: number,
  phase: string,
  agent: string,
  eventType: AuditEventType,
  message: string,
  metadata?: unknown,
  pipelineRunId?: number,
): void {
  const db = getDb();
  db.insert(auditLog).values({
    sessionId,
    pipelineRunId: pipelineRunId ?? null,
    timestamp: Date.now(),
    phase,
    agent,
    eventType,
    message,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
  }).run();
}

export function getAuditEventsForSession(sessionId: number, limit = 100): AuditEvent[] {
  const db = getDb();
  const rows = db.select().from(auditLog)
    .where(eq(auditLog.sessionId, sessionId))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .all();
  
  return rows.map(parseEvent).reverse();
}

export function getAuditEventsForRun(pipelineRunId: number, limit = 100): AuditEvent[] {
  const db = getDb();
  const rows = db.select().from(auditLog)
    .where(eq(auditLog.pipelineRunId, pipelineRunId))
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .all();
  
  return rows.map(parseEvent).reverse();
}

function parseEvent(row: unknown): AuditEvent {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as number,
    sessionId: r.sessionId as number,
    pipelineRunId: r.pipelineRunId as number | null,
    timestamp: r.timestamp as number,
    phase: r.phase as string,
    agent: r.agent as string,
    eventType: r.eventType as AuditEventType,
    message: r.message as string,
    metadata: r.metadataJson ? JSON.parse(r.metadataJson as string) : undefined,
  };
}
