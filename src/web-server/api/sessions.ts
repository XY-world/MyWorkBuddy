import { getAllSessions, getSession } from '../../memory/session';
import { getTasksForSession } from '../../memory/tasks';
import { getCodeChanges } from '../../memory/code-changes';
import { Orchestrator } from '../../agents/orchestrator';
import { broadcastEvent } from './stream';

export async function handleSessionsApi(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (method === 'GET') {
    const sessions = getAllSessions();
    return sessions.map((s) => {
      const tasks = getTasksForSession(s.id);
      const done = tasks.filter((t) => t.status === 'done').length;
      return { ...s, taskCount: tasks.length, tasksDone: done };
    });
  }

  if (method === 'POST') {
    const workItemId = body.workItemId as number;
    if (!workItemId) return { error: 'workItemId required' };

    // Start orchestration in background
    const orch = new Orchestrator();
    orch.on('event', (e: any) => broadcastEvent(e));

    setImmediate(() => {
      orch.run({ workItemId }).catch((err) => {
        broadcastEvent({ type: 'error', message: err.message, phase: 'unknown' });
      });
    });

    return { started: true, workItemId };
  }

  return { error: 'Method not allowed' };
}

export async function handleSessionApi(sessionId: number): Promise<unknown> {
  const session = getSession(sessionId);
  if (!session) return null;
  const tasks = getTasksForSession(sessionId);
  const changes = getCodeChanges(sessionId);
  return { session, tasks, changes };
}
