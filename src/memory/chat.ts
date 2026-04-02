import { eq, and, desc, asc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { chatMessages } from '../db/schema';
import { updateSessionContextSummary } from './session';
import { createCopilotSession } from '../tools/copilot-client';

export interface ChatMessage {
  id: number;
  sessionId: number;
  role: 'user' | 'sam';
  content: string;
  isCompressed: boolean;
  pipelineRunId?: number | null;
  createdAt: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Chat Message CRUD
// ══════════════════════════════════════════════════════════════════════════════

export function appendChatMessage(data: {
  sessionId: number;
  role: 'user' | 'sam';
  content: string;
  pipelineRunId?: number;
}): ChatMessage {
  const db = getDb();
  const result = db.insert(chatMessages).values({
    sessionId: data.sessionId,
    role: data.role,
    content: data.content,
    isCompressed: 0,
    pipelineRunId: data.pipelineRunId ?? null,
    createdAt: Date.now(),
  }).returning().get();
  
  return parseMessage(result);
}

export function getChatMessages(sessionId: number): ChatMessage[] {
  const db = getDb();
  const rows = db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt))
    .all();
  return rows.map(parseMessage);
}

export function getUncompressedMessages(sessionId: number, limit = 20): ChatMessage[] {
  const db = getDb();
  const rows = db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.sessionId, sessionId),
      eq(chatMessages.isCompressed, 0),
    ))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all();
  // Reverse to get chronological order
  return rows.map(parseMessage).reverse();
}

export function getRecentMessages(sessionId: number, limit = 50): ChatMessage[] {
  const db = getDb();
  const rows = db.select().from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .all();
  return rows.map(parseMessage).reverse();
}

export function countUncompressedMessages(sessionId: number): number {
  const db = getDb();
  const rows = db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.sessionId, sessionId),
      eq(chatMessages.isCompressed, 0),
    ))
    .all();
  return rows.length;
}

// ══════════════════════════════════════════════════════════════════════════════
// Context Compression (模拟 OpenClaw)
// ══════════════════════════════════════════════════════════════════════════════

const COMPRESS_THRESHOLD = 30;  // 当未压缩消息超过此数量时触发压缩
const KEEP_RECENT = 10;         // 压缩后保留最近 N 条不压缩

/**
 * Check if compression is needed and perform it.
 */
export async function maybeCompressContext(sessionId: number, existingSummary?: string): Promise<void> {
  const uncompressedCount = countUncompressedMessages(sessionId);
  
  if (uncompressedCount < COMPRESS_THRESHOLD) {
    return;
  }
  
  await compressContext(sessionId, existingSummary);
}

/**
 * Compress older messages into a summary.
 */
export async function compressContext(sessionId: number, existingSummary?: string): Promise<string> {
  const db = getDb();
  const allUncompressed = getUncompressedMessages(sessionId, 100);
  
  if (allUncompressed.length <= KEEP_RECENT) {
    return existingSummary ?? '';
  }
  
  // Messages to compress (older ones)
  const toCompress = allUncompressed.slice(0, -KEEP_RECENT);
  const toKeep = allUncompressed.slice(-KEEP_RECENT);
  
  // Build conversation text for summarization
  const conversationText = toCompress
    .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join('\n\n');
  
  // Ask Sam to summarize
  const prompt = `You are summarizing a conversation history between a user and Sam (an engineering manager AI) about an Azure DevOps work item.

${existingSummary ? `Previous summary:\n${existingSummary}\n\n` : ''}New conversation to incorporate:
${conversationText}

Create a concise summary (max 500 words) that captures:
1. Key decisions made
2. Important context about the work item
3. Any constraints or preferences mentioned
4. Current status and next steps

Respond with ONLY the summary, no preamble.`;

  let summary = existingSummary ?? '';
  
  try {
    const session = await createCopilotSession('You are a helpful assistant that summarizes conversations.');
    const response = await session.sendAndWait({ prompt });
    summary = response.text.trim();
    await session.close();
  } catch (err) {
    console.error('[Chat] Compression failed:', err);
    // Fall back to simple concatenation
    summary = existingSummary
      ? `${existingSummary}\n\n[Additional context from ${toCompress.length} messages]`
      : `[Summary of ${toCompress.length} messages — compression failed, see full history]`;
  }
  
  // Mark old messages as compressed
  for (const msg of toCompress) {
    db.update(chatMessages)
      .set({ isCompressed: 1 })
      .where(eq(chatMessages.id, msg.id))
      .run();
  }
  
  // Save summary to session
  updateSessionContextSummary(sessionId, summary);
  
  console.log(`[Chat] Compressed ${toCompress.length} messages, kept ${toKeep.length} recent`);
  
  return summary;
}

/**
 * Build context for sending to LLM.
 * Returns the compressed summary + recent uncompressed messages.
 */
export function buildChatContext(sessionId: number, contextSummary?: string | null): {
  summary: string | null;
  recentMessages: ChatMessage[];
} {
  const recent = getUncompressedMessages(sessionId, 20);
  return {
    summary: contextSummary ?? null,
    recentMessages: recent,
  };
}

/**
 * Format chat context for including in a prompt.
 */
export function formatChatContextForPrompt(context: {
  summary: string | null;
  recentMessages: ChatMessage[];
}): string {
  const parts: string[] = [];
  
  if (context.summary) {
    parts.push(`## Previous Context Summary\n${context.summary}`);
  }
  
  if (context.recentMessages.length > 0) {
    const msgs = context.recentMessages
      .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');
    parts.push(`## Recent Conversation\n${msgs}`);
  }
  
  return parts.join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function parseMessage(row: unknown): ChatMessage {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as number,
    sessionId: r.sessionId as number,
    role: r.role as 'user' | 'sam',
    content: r.content as string,
    isCompressed: (r.isCompressed as number) === 1,
    pipelineRunId: r.pipelineRunId as number | null,
    createdAt: r.createdAt as number,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Convenience aliases for VSCode extension
// ══════════════════════════════════════════════════════════════════════════════

/** Alias for getChatMessages */
export const getMessages = getChatMessages;

/** Convenience wrapper for appendChatMessage */
export function addMessage(sessionId: number, role: 'user' | 'assistant' | 'sam', content: string, pipelineRunId?: number): ChatMessage {
  // Normalize role: 'assistant' -> 'sam'
  const normalizedRole = role === 'assistant' ? 'sam' : role as 'user' | 'sam';
  return appendChatMessage({ sessionId, role: normalizedRole, content, pipelineRunId });
}
