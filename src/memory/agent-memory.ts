import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { agentMemory } from '../db/schema';

export type MemoryType = 'code_pattern' | 'team_preference' | 'lesson_learned' | 'standard';

export interface AgentMemoryEntry {
  id: number;
  agentName: string;
  repoKey: string;
  memoryType: MemoryType;
  key: string;
  value: string;
  confidence: number;
  sourceSessionId?: number | null;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
}

export function makeRepoKey(orgUrl: string, project: string, repo: string): string {
  return `${orgUrl.replace(/\/$/, '')}/${project}/${repo}`;
}

export function saveMemory(
  agentName: string,
  repoKey: string,
  memoryType: MemoryType,
  key: string,
  value: string,
  confidence: number,
  sourceSessionId?: number,
): void {
  const db = getDb();
  const now = Date.now();

  // Upsert: update if same agent+repo+key exists
  const existing = db.select().from(agentMemory)
    .where(and(
      eq(agentMemory.agentName, agentName),
      eq(agentMemory.repoKey, repoKey),
      eq(agentMemory.key, key),
    ))
    .get();

  if (existing) {
    db.update(agentMemory)
      .set({ value, confidence, updatedAt: now, sourceSessionId: sourceSessionId ?? null })
      .where(eq(agentMemory.id, (existing as any).id))
      .run();
  } else {
    db.insert(agentMemory).values({
      agentName, repoKey, memoryType, key, value, confidence,
      sourceSessionId: sourceSessionId ?? null,
      createdAt: now, updatedAt: now, usageCount: 0,
    }).run();
  }
}

export function loadMemories(agentName: string, repoKey: string, limit = 10): AgentMemoryEntry[] {
  const db = getDb();
  const rows = db.select().from(agentMemory)
    .where(and(eq(agentMemory.agentName, agentName), eq(agentMemory.repoKey, repoKey)))
    .all() as unknown as AgentMemoryEntry[];

  // Sort by confidence desc, usage desc, return top N above threshold
  const filtered = rows
    .filter((r) => r.confidence >= 0.3)
    .sort((a, b) => b.confidence - a.confidence || b.usageCount - a.usageCount)
    .slice(0, limit);

  // Increment usage count
  for (const row of filtered) {
    db.update(agentMemory)
      .set({ usageCount: row.usageCount + 1, updatedAt: Date.now() })
      .where(eq(agentMemory.id, row.id))
      .run();
  }

  return filtered;
}

export function formatMemoriesForPrompt(memories: AgentMemoryEntry[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(
    (m) => `- [${m.memoryType}] ${m.value}  (confidence: ${m.confidence.toFixed(2)})`,
  );
  return `Based on your memory of this repository:\n${lines.join('\n')}\nApply this knowledge when completing your current task.`;
}

export function adjustConfidence(agentName: string, repoKey: string, key: string, delta: number): void {
  const db = getDb();
  const row = db.select().from(agentMemory)
    .where(and(eq(agentMemory.agentName, agentName), eq(agentMemory.repoKey, repoKey), eq(agentMemory.key, key)))
    .get() as unknown as AgentMemoryEntry | undefined;

  if (row) {
    const newConf = Math.max(0, Math.min(1, row.confidence + delta));
    db.update(agentMemory)
      .set({ confidence: newConf, updatedAt: Date.now() })
      .where(eq(agentMemory.id, row.id))
      .run();
  }
}
