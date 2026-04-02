import { getAllSessions, getSession, getOrCreateSession } from '../../memory/session';
import { getTasksForRun, getTasksForSession } from '../../memory/tasks';
import { getCodeChanges } from '../../memory/code-changes';
import { getLatestRunForSession, createPipelineRun } from '../../memory/pipeline-run';
import { PipelineRunner } from '../../agents/pipeline-runner';
import { getWorkItem } from '../../ado/work-items';
import { broadcastEvent } from './stream';
import { getConfig } from '../../config/manager';

export async function handleSessionsApi(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (method === 'GET') {
    const sessions = getAllSessions();
    return sessions.map((s) => {
      const latestRun = getLatestRunForSession(s.id);
      const tasks = latestRun ? getTasksForRun(latestRun.id) : [];
      const done = tasks.filter((t) => t.status === 'done').length;
      return { ...s, taskCount: tasks.length, tasksDone: done, latestRun };
    });
  }

  if (method === 'POST') {
    const workItemId = body.workItemId as number;
    if (!workItemId) return { error: 'workItemId required' };

    const cfg = getConfig();
    const cfgAll = cfg.getAll();
    const project = (body.project as string) || cfgAll.ado.wiProject;

    // Start pipeline in background
    setImmediate(async () => {
      try {
        const workItem = await getWorkItem(project, workItemId);
        const { session } = getOrCreateSession({
          workItemId,
          adoOrg: cfgAll.ado.orgUrl,
          project,
          repo: cfgAll.ado.defaultRepo,
          title: workItem.title,
        });
        const pipelineRun = createPipelineRun({
          sessionId: session.id,
          type: 'full',
          triggeredBy: 'web',
        });
        const runner = new PipelineRunner();
        runner.on('event', (e: any) => broadcastEvent(e));
        await runner.execute({ session, run: pipelineRun });
      } catch (err: any) {
        broadcastEvent({ type: 'error', message: err.message, phase: 'unknown' });
      }
    });

    return { started: true, workItemId };
  }

  return { error: 'Method not allowed' };
}

export async function handleSessionApi(sessionId: number): Promise<unknown> {
  const session = getSession(sessionId);
  if (!session) return null;
  const latestRun = getLatestRunForSession(sessionId);
  const tasks = latestRun ? getTasksForRun(latestRun.id) : [];
  const changes = latestRun ? getCodeChanges(latestRun.id) : [];
  return { session, tasks, changes, latestRun };
}
