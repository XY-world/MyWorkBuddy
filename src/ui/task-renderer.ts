import { Listr, ListrTask } from 'listr2';
import chalk from 'chalk';
import { Task } from '../memory/tasks';
import { Session, WorkItemSession } from '../memory/session';
import { agentLabel, statusBadge } from './formatters';

export function buildTaskList(session: Session | WorkItemSession, tasks: Task[]): Listr {
  const listrTasks: ListrTask[] = tasks.map((t) => ({
    title: `${agentLabel(t.agent)} ${t.title}`,
    task: (_ctx: unknown, task: any) => {
      switch (t.status) {
        case 'done':
          task.title = `${agentLabel(t.agent)} ${chalk.gray(t.title)} ${chalk.green(`✔ ${t.resultSummary?.slice(0, 50) ?? ''}`)}`;
          break;
        case 'failed':
          task.title = `${agentLabel(t.agent)} ${chalk.red(t.title)} ${chalk.red('✖')}`;
          task.skip();
          break;
        case 'running':
          task.title = `${agentLabel(t.agent)} ${t.title} ${chalk.yellow('↻ ...')}`;
          break;
        default:
          task.skip();
      }
    },
    skip: () => t.status === 'pending' || t.status === 'skipped',
  }));

  return new Listr(listrTasks, {
    concurrent: false,
    rendererOptions: { collapseErrors: false },
  });
}

export function printStaticTaskList(tasks: Task[]): void {
  for (const t of tasks) {
    const badge = statusBadge(t.status);
    const label = agentLabel(t.agent);
    const summary = t.resultSummary ? chalk.gray(`  — ${t.resultSummary.slice(0, 60)}`) : '';
    console.log(`  ${badge}  ${label} ${t.title}${summary}`);
  }
}
