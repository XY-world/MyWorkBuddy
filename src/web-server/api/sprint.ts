import { getConfig } from '../../config/manager';
import { getWorkItemsForIteration, getIterations } from '../../ado/work-items';
import { getAllSessions } from '../../memory/session';

export async function handleSprintApi(query: Record<string, string>): Promise<unknown> {
  const cfg = getConfig().getAll();
  const project = query.project ?? cfg.ado.wiProject;
  const iterationPath = query.iteration;

  // Get available iterations
  let iterations: Awaited<ReturnType<typeof getIterations>> = [];
  try {
    iterations = await getIterations(project);
  } catch (err: any) {
    return { error: `Failed to fetch iterations: ${err.message}`, iterations: [], workItems: [] };
  }

  // Determine which iteration to show
  const targetIteration = iterationPath
    ? iterations.find((i) => i.path === iterationPath || i.name === iterationPath)
    : iterations.find((i) => i.isCurrent) ?? iterations[iterations.length - 1];

  if (!targetIteration) {
    return { iterations, currentIteration: null, workItems: [] };
  }

  let workItems: unknown[] = [];
  try {
    const raw = await getWorkItemsForIteration(project, targetIteration.path);
    const sessions = getAllSessions();
    workItems = raw.map((wi) => {
      const session = sessions.find((s) => s.workItemId === wi.id);
      return { ...wi, session: session ?? null };
    });
  } catch (err: any) {
    return { error: `Failed to fetch work items: ${err.message}`, iterations, currentIteration: targetIteration, workItems: [] };
  }

  return { iterations, currentIteration: targetIteration, workItems };
}
