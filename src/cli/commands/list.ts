import { Command } from 'commander';
import chalk from 'chalk';
import { runMigrations } from '../../db/migrate';
import { getAllSessions } from '../../memory/session';
import { getLatestRunForSession } from '../../memory/pipeline-run';
import { statusBadge, formatRelativeTime } from '../../ui/formatters';

export function listCommand(): Command {
  return new Command('list')
    .description('List all work item sessions')
    .action(() => {
      runMigrations();
      const sessions = getAllSessions();

      if (sessions.length === 0) {
        console.log(chalk.yellow('\n  No sessions yet. Run: myworkbuddy run <workItemId>\n'));
        return;
      }

      console.log(chalk.bold('\n  myworkbuddy · All Sessions'));
      console.log('  ' + '─'.repeat(90));
      console.log(chalk.gray(`  ${'WI#'.padEnd(7)} ${'Title'.padEnd(38)} ${'Status'.padEnd(10)} ${'PR'.padEnd(20)} Date`));
      console.log('  ' + '─'.repeat(90));

      for (const s of sessions) {
        const badge = statusBadge(s.status);
        const latestRun = getLatestRunForSession(s.id);
        const pr = latestRun?.prUrl ? chalk.cyan('PR created') : chalk.gray('—');
        console.log(
          `  ${badge} ${s.workItemId.toString().padEnd(6)} ${(s.title || '(untitled)').slice(0, 37).padEnd(38)} ${s.status.padEnd(10)} ${pr.padEnd(20)} ${formatRelativeTime(s.createdAt)}`,
        );
      }

      console.log('  ' + '─'.repeat(90));
      console.log(chalk.gray(`  ${sessions.length} total  ·  Tip: myworkbuddy status <WI#> for detail\n`));
    });
}
