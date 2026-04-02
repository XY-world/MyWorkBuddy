import { getAuditLog } from '../../memory/audit';

export async function handleAuditApi(sessionId: number, query: Record<string, string>): Promise<unknown> {
  const events = getAuditLog(sessionId);
  const { phase, agent, type } = query;
  return events.filter((e) => {
    if (phase && e.phase !== phase) return false;
    if (agent && !e.agent.toLowerCase().includes(agent.toLowerCase())) return false;
    if (type && e.eventType !== type) return false;
    return true;
  });
}
