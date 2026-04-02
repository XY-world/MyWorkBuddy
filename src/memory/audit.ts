import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { auditLog } from '../db/schema';

export type AuditEventType = 'info' | 'tool_call' | 'decision' | 'error' | 'state_change';

export interface AuditEvent {
  id: number;
  sessionId: number;
  timestamp: number;
  phase: string;
  agent: string;
  eventType: AuditEventType;
  message: string;
  metadataJson?: string | null;
}

export function appendAuditEvent(
  sessionId: number,
  phase: string,
  agent: string,
  eventType: AuditEventType,
  message: string,
  metadata?: unknown,
): void {
  const db = getDb();
  db.insert(auditLog).values({
    sessionId,
    timestamp: Date.now(),
    phase,
    agent,
    eventType,
    message,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
  }).run();
}

export function getAuditLog(sessionId: number): AuditEvent[] {
  const db = getDb();
  return db.select().from(auditLog)
    .where(eq(auditLog.sessionId, sessionId))
    .all() as unknown as AuditEvent[];
}
