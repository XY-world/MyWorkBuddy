import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client';
import { agentMessages } from '../db/schema';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

export interface AgentMessage {
  id: number;
  sessionId: number;
  agentName: string;
  role: MessageRole;
  content: string;
  toolCallJson?: string | null;
  seq: number;
  createdAt: number;
}

export function appendMessage(
  sessionId: number,
  agentName: string,
  role: MessageRole,
  content: string,
  toolCallJson?: unknown,
): void {
  const db = getDb();
  const existing = db.select().from(agentMessages)
    .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.agentName, agentName)))
    .all();
  const seq = existing.length;
  db.insert(agentMessages).values({
    sessionId,
    agentName,
    role,
    content,
    toolCallJson: toolCallJson ? JSON.stringify(toolCallJson) : null,
    seq,
    createdAt: Date.now(),
  }).run();
}

export function getConversationHistory(sessionId: number, agentName: string): AgentMessage[] {
  const db = getDb();
  return db.select().from(agentMessages)
    .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.agentName, agentName)))
    .all() as unknown as AgentMessage[];
}
