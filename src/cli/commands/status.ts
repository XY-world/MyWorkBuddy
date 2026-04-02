import { Command } from 'commander';
import chalk from 'chalk';
import { runMigrations } from '../../db/migrate';
import { getAllSessions, getSession } from '../../memory/session';
import { getTasksForSession } from '../../memory/tasks';
import { statusBadge, agentLabel, formatRelativeTime } from '../../ui/formatters';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show session status — all active sessions or detail for one work item')
    .argument('[workItemId]', 'Work item ID (optional)')
    .action((workItemIdStr?: string) => {
      runMigrations();

      if (workItemIdStr) {
        // Detail view for specific WI
        const sessions = getAllSessions().filter((s) => s.workItemId === parseInt(workItemIdStr));
        if (sessions.length === 0) {
          console.log(chalk.yellow(`No sessions found for WI #${workItemIdStr}`));
          return;
        }
        const session = sessions[sessions.length - 1]; // latest
        const tasks = getTasksForSession(session.id);

        console.log(chalk.bold(`\n  myworkbuddy · WI #${session.workItemId}: ${session.title}`));
        console.log(chalk.gray(`  Phase: ${session.phase.toUpperCase()}  ·  Branch: ${session.branch || '(none)'}  ·  Started: ${formatRelativeTime(session.createdAt)}\n`));

        const done = tasks.filter((t) => t.status === 'done').length;
        const total = tasks.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const barFilled = Math.round(pct / 5);
        const bar = '█'.repeat(barFilled) + '░'.repeat(20 - barFilled);

        console.log(`  ${chalk.gray('Seq  Agent            Task')}${' '.repeat(40)}${chalk.gray('Status')}`);
        console.log('  ' + '─'.repeat(72));
        for (const t of tasks) {
          const badge = statusBadge(t.status);
          const label = agentLabel(t.agent);
          const title = t.title.slice(0, 40).padEnd(40);
          console.log(`  ${t.seq.toString().padEnd(4)} ${label} ${title} ${badge}`);
        }
        console.log('  ' + '─'.repeat(72));
        console.log(chalk.gray(`  Progress: ${bar}  ${done} / ${total} tasks  (${pct}%)`));

        if (session.prUrl) console.log(`\n  PR: ${chalk.cyan(session.prUrl)}`);
        console.log();

      } else {
        // All sessions table
        const sessions = getAllSessions();
        if (sessions.length === 0) {
          console.log(chalk.yellow('\n  No sessions found. Run: myworkbuddy run <workItemId>\n'));
          return;
        }

        console.log(chalk.bold('\n  myworkbuddy · Sessions'));
        console.log('  ' + '─'.repeat(75));
        console.log(chalk.gray(`  ${'ID'.padEnd(4)} ${'WI#'.padEnd(6)} ${'Title'.padEnd(35)} ${'Phase'.padEnd(14)} ${'Tasks'.padEnd(8)} Age`));
        console.log('  ' + '─'.repeat(75));

        for (const s of sessions) {
          const tasks = getTasksForSession(s.id);
          const done = tasks.filter((t) => t.status === 'done').length;
          const total = tasks.length;
          const badge = statusBadge(s.status);
          console.log(
            `  ${badge} ${s.id.toString().padEnd(3)} ${s.workItemId.toString().padEnd(6)} ${(s.title || '(untitled)').slice(0, 34).padEnd(35)} ${s.phase.padEnd(14)} ${`${done}/${total}`.padEnd(8)} ${formatRelativeTime(s.createdAt)}`,
          );
        }
        console.log('  ' + '─'.repeat(75));
        const active = sessions.filter((s) => s.status === 'active').length;
        console.log(chalk.gray(`  ${sessions.length} sessions  ·  ${active} active\n`));
      }
    });
}
