import { eq, and, asc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { agentMessages } from '../db/schema';

export interface AgentMessage {
  id: number;
  pipelineRunId: number;
  agentName: string;
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  toolCallJson?: string | null;
  seq: number;
  createdAt: number;
}

export function appendMessage(
  pipelineRunId: number,
  agentName: string,
  role: 'system' | 'user' | 'assistant' | 'tool_result',
  content: string,
  toolCallJson?: string,
): void {
  const db = getDb();
  
  // Get next seq number
  const existing = db.select().from(agentMessages)
    .where(and(
      eq(agentMessages.pipelineRunId, pipelineRunId),
      eq(agentMessages.agentName, agentName),
    ))
    .all();
  const seq = existing.length;
  
  db.insert(agentMessages).values({
    pipelineRunId,
    agentName,
    role,
    content,
    toolCallJson: toolCallJson ?? null,
    seq,
    createdAt: Date.now(),
  }).run();
}

export function getMessages(pipelineRunId: number, agentName: string): AgentMessage[] {
  const db = getDb();
  const rows = db.select().from(agentMessages)
    .where(and(
      eq(agentMessages.pipelineRunId, pipelineRunId),
      eq(agentMessages.agentName, agentName),
    ))
    .orderBy(asc(agentMessages.seq))
    .all();
  
  return rows.map((r: any) => ({
    id: r.id,
    pipelineRunId: r.pipelineRunId,
    agentName: r.agentName,
    role: r.role,
    content: r.content,
    toolCallJson: r.toolCallJson,
    seq: r.seq,
    createdAt: r.createdAt,
  }));
}

export function clearMessages(pipelineRunId: number, agentName: string): void {
  const db = getDb();
  db.delete(agentMessages)
    .where(and(
      eq(agentMessages.pipelineRunId, pipelineRunId),
      eq(agentMessages.agentName, agentName),
    ))
    .run();
}
